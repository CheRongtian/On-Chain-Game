package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type streamNotice struct {
	ChainID        uint64   `json:"chainId"`
	Arena          string   `json:"arena"`
	DeploymentHash string   `json:"deploymentHash"`
	Block          int64    `json:"block"`
	BlockHash      string   `json:"blockHash"`
	Matches        []string `json:"matches"`
	Reason         string   `json:"reason,omitempty"`
}

type streamStatus struct {
	Database string `json:"database"`
	RPC      string `json:"rpc"`
	Indexer  string `json:"indexer"`
	Ready    bool   `json:"ready"`
	Error    string `json:"error,omitempty"`
}

func (s *service) notify(ctx context.Context, tx *sql.Tx, kind string, point cursor, matches []string) error {
	if matches == nil {
		matches = []string{}
	}
	notice := streamNotice{ChainID: s.cfg.ChainID, Arena: s.cfg.Arena, DeploymentHash: s.anchor.Hash().Hex(),
		Block: point.Number, BlockHash: point.Hash, Matches: matches}
	data, err := json.Marshal(notice)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO stream_events(deployment_id,kind,data) VALUES($1,$2,$3)`, s.deploymentID, kind, string(data))
	return err
}

func (s *service) streamState() streamStatus {
	s.mu.RLock()
	seen := s.observed
	s.mu.RUnlock()
	state := streamStatus{Database: "available", RPC: "available", Indexer: "synced", Error: seen.Error}
	if seen.DatabaseError != "" {
		state.Database, state.Indexer = "unavailable", "paused"
	}
	if seen.RPCError != "" {
		state.RPC, state.Indexer = "unavailable", "paused"
	}
	if seen.Blocked {
		state.Indexer = "recovering"
	} else if seen.Error != "" {
		state.Indexer = "paused"
	}
	state.Ready = seen.Error == "" && seen.Indexed == int64(seen.Head) && !seen.LastSync.IsZero() && time.Since(seen.LastSync) < 45*time.Second
	if !state.Ready && state.Indexer == "synced" {
		state.Indexer = "syncing"
	}
	return state
}

func (s *service) streamID(sequence int64) string {
	return fmt.Sprintf("%d:%d", s.deploymentID, sequence)
}

func (s *service) streamCursor(ctx context.Context, supplied string) (int64, bool, error) {
	var last int64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(max(id),0) FROM stream_events WHERE deployment_id=$1`, s.deploymentID).Scan(&last); err != nil {
		return 0, false, err
	}
	parts := strings.Split(supplied, ":")
	if len(parts) != 2 {
		return last, true, nil
	}
	deployment, err := strconv.ParseInt(parts[0], 10, 64)
	sequence, sequenceErr := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || sequenceErr != nil || deployment != s.deploymentID || sequence < 0 || sequence > last {
		return last, true, nil
	}
	if sequence != 0 {
		var exists bool
		if err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM stream_events WHERE deployment_id=$1 AND id=$2)`, deployment, sequence).Scan(&exists); err != nil {
			return 0, false, err
		}
		if !exists {
			return last, true, nil
		}
	}
	return sequence, false, nil
}

func (s *service) stream(w http.ResponseWriter, r *http.Request) {
	supplied := r.Header.Get("Last-Event-ID")
	if supplied == "" {
		supplied = r.URL.Query().Get("after")
	}
	setup, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	sequence, reset, err := s.streamCursor(setup, supplied)
	if err != nil {
		cancel()
		writeResponse(w, 503, apiError{Code: "events_unavailable", Message: "Live updates are unavailable; continue with regular refresh."})
		return
	}
	point, err := s.cursor(setup)
	cancel()
	if err != nil {
		s.queryError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	control := http.NewResponseController(w)
	write := func(kind, id string, data any) error {
		payload, marshalErr := json.Marshal(data)
		if marshalErr != nil {
			return marshalErr
		}
		if deadlineErr := control.SetWriteDeadline(time.Now().Add(15 * time.Second)); deadlineErr != nil {
			return deadlineErr
		}
		if id != "" {
			if _, err := fmt.Fprintf(w, "id: %s\n", id); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind, payload); err != nil {
			return err
		}
		return control.Flush()
	}
	if reset {
		notice := streamNotice{s.cfg.ChainID, s.cfg.Arena, s.anchor.Hash().Hex(), point.Number, point.Hash, []string{}, "subscription-reset"}
		if err = write("reset", s.streamID(sequence), notice); err != nil {
			return
		}
	}
	previous := s.streamState()
	if err = write("status", "", previous); err != nil {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastHeartbeat := time.Now()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
		ctx, finish := context.WithTimeout(r.Context(), 3*time.Second)
		rows, readErr := s.db.QueryContext(ctx, `SELECT id,kind,data FROM stream_events WHERE deployment_id=$1 AND id>$2 ORDER BY id LIMIT 100`, s.deploymentID, sequence)
		type event struct {
			ID   int64
			Kind string
			Data json.RawMessage
		}
		var events []event
		if readErr == nil {
			for rows.Next() {
				var event event
				if readErr = rows.Scan(&event.ID, &event.Kind, &event.Data); readErr != nil {
					break
				}
				events = append(events, event)
			}
			if readErr == nil {
				readErr = rows.Err()
			}
			rows.Close()
		}
		finish()
		if readErr != nil {
			_ = write("status", "", streamStatus{Database: "unavailable", RPC: "unknown", Indexer: "paused", Error: "History connection interrupted."})
			return
		}
		for _, event := range events {
			if err = write(event.Kind, s.streamID(event.ID), event.Data); err != nil {
				return
			}
			sequence = event.ID
		}
		state := s.streamState()
		if state != previous || time.Since(lastHeartbeat) >= 10*time.Second {
			if err = write("status", "", state); err != nil {
				return
			}
			previous, lastHeartbeat = state, time.Now()
		}
	}
}
