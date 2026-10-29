package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"time"
)

type metadata struct {
	ProcessID           int          `json:"processId"`
	ChainID             uint64       `json:"chainId"`
	Arena               string       `json:"arena"`
	DeploymentBlock     uint64       `json:"deploymentBlock"`
	DeploymentHash      string       `json:"deploymentHash"`
	IndexedBlock        int64        `json:"indexedBlock"`
	IndexedHash         string       `json:"indexedHash"`
	ObservedBlock       uint64       `json:"observedBlock"`
	Lag                 uint64       `json:"lag"`
	RequiredDescendants uint64       `json:"requiredDescendants"`
	ConfirmationPolicy  string       `json:"confirmationPolicy"`
	LastSync            time.Time    `json:"lastSuccessfulSync"`
	Ready               bool         `json:"ready"`
	Blocked             bool         `json:"blocked"`
	Error               string       `json:"error,omitempty"`
	Verification        string       `json:"verification"`
	Keeper              keeperStatus `json:"keeper"`
	Services            streamStatus `json:"services"`
}

type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("Write API response: %v", err)
	}
}

func (s *service) meta(ctx context.Context, tx *sql.Tx) (metadata, error) {
	s.mu.RLock()
	seen := s.observed
	keeper := s.keeperState
	s.mu.RUnlock()
	keeper.Enabled = s.cfg.KeeperEnabled
	m := metadata{ProcessID: os.Getpid(), ChainID: s.cfg.ChainID, Arena: s.cfg.Arena, DeploymentBlock: s.cfg.From, DeploymentHash: s.anchor.Hash().Hex(),
		ObservedBlock: seen.Head, RequiredDescendants: s.cfg.Confirmations, ConfirmationPolicy: "block_depth", LastSync: seen.LastSync,
		Blocked: seen.Blocked, Error: seen.Error, Verification: "available_per_match", Keeper: keeper, Services: s.streamState()}
	err := tx.QueryRowContext(ctx, `SELECT block_number,block_hash FROM sync_cursors WHERE deployment_id=$1`, s.deploymentID).Scan(&m.IndexedBlock, &m.IndexedHash)
	if err != nil {
		return m, err
	}
	if m.IndexedBlock >= 0 {
		m.ObservedBlock = max(m.ObservedBlock, uint64(m.IndexedBlock))
		m.Lag = m.ObservedBlock - uint64(m.IndexedBlock)
	}
	m.Ready = m.Error == "" && !m.LastSync.IsZero() && m.Lag == 0 && m.Services.Ready
	return m, nil
}

func (m metadata) confirmation(block uint64) map[string]any {
	status, count := "unknown", uint64(0)
	if m.Error == "" && m.ObservedBlock >= block {
		count = m.ObservedBlock - block + 1
		status = "provisional"
		if m.RequiredDescendants == 0 {
			status = "observed"
		} else if m.ObservedBlock-block >= m.RequiredDescendants {
			status = "confirmed"
		}
	}
	return map[string]any{"status": status, "confirmations": count, "requiredDescendants": m.RequiredDescendants}
}

func (s *service) read(handler func(*http.Request, *sql.Tx, metadata) (any, *apiError)) http.HandlerFunc {
	return s.readFor(5*time.Second, handler)
}

func (s *service) readFor(timeout time.Duration, handler func(*http.Request, *sql.Tx, metadata) (any, *apiError)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		r = r.WithContext(ctx)
		tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
		if err != nil {
			log.Printf("Read API database: %v", err)
			writeResponse(w, 503, apiError{Code: "database_unavailable", Message: "Indexed data is temporarily unavailable."})
			return
		}
		defer tx.Rollback()
		meta, err := s.meta(ctx, tx)
		if err != nil {
			s.queryError(w, err)
			return
		}
		value, failure := handler(r, tx, meta)
		if failure != nil {
			writeResponse(w, failure.Status, failure)
			return
		}
		writeResponse(w, 200, value)
	}
}

func (s *service) queryError(w http.ResponseWriter, err error) {
	log.Printf("Read API query: %v", err)
	writeResponse(w, 503, apiError{Code: "query_failed", Message: "Indexed data could not be read."})
}

func pagination(r *http.Request) (int, int, *apiError) {
	limit, offset := 20, 0
	for _, field := range []struct {
		name   string
		target *int
	}{{"limit", &limit}, {"offset", &offset}} {
		if text := r.URL.Query().Get(field.name); text != "" {
			n, err := strconv.Atoi(text)
			if err != nil || n < 0 {
				return 0, 0, &apiError{400, "invalid_pagination", "Use a limit from 1 to 100 and a nonnegative offset."}
			}
			*field.target = n
		}
	}
	if limit < 1 || limit > 100 {
		return 0, 0, &apiError{400, "invalid_pagination", "Use a limit from 1 to 100."}
	}
	return limit, offset, nil
}

func matchID(r *http.Request) (string, *apiError) {
	value := r.PathValue("id")
	n, ok := new(big.Int).SetString(value, 10)
	if !ok || n.Sign() <= 0 || n.BitLen() > 256 {
		return "", &apiError{400, "invalid_match_id", "Match ID must be a positive uint256 decimal integer."}
	}
	return n.String(), nil
}

func (s *service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", s.stream)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		state := s.streamState()
		events := "available"
		var latest int64
		if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(max(id),0) FROM stream_events WHERE deployment_id=$1`, s.deploymentID).Scan(&latest); err != nil {
			events = "unavailable"
			if pingErr := s.db.PingContext(ctx); pingErr != nil {
				state.Database, state.Ready, state.Error = "unavailable", false, "PostgreSQL is unavailable."
			}
		}
		status, code := "ok", http.StatusOK
		if !state.Ready || events != "available" {
			status, code = "degraded", http.StatusServiceUnavailable
		}
		s.mu.RLock()
		keeper := s.keeperState
		s.mu.RUnlock()
		keeper.Enabled = s.cfg.KeeperEnabled
		writeResponse(w, code, map[string]any{"status": status, "services": state, "events": events, "keeper": keeper})
	})
	status := func(ready bool) http.HandlerFunc {
		return s.read(func(r *http.Request, tx *sql.Tx, m metadata) (any, *apiError) {
			if ready && !m.Ready {
				return nil, &apiError{503, "indexer_not_ready", "Indexer is behind or unavailable; inspect /sync."}
			}
			if !ready {
				var matches, finished, events, rounds, snapshots int64
				err := tx.QueryRowContext(r.Context(), `SELECT
					(SELECT count(*) FROM matches WHERE deployment_id=$1),
					(SELECT count(*) FROM matches WHERE deployment_id=$1 AND phase=5),
					(SELECT count(*) FROM chain_events WHERE deployment_id=$1),
					(SELECT count(*) FROM rounds WHERE deployment_id=$1),
					(SELECT count(*) FROM battle_snapshots WHERE deployment_id=$1)`, s.deploymentID).
					Scan(&matches, &finished, &events, &rounds, &snapshots)
				if err != nil {
					return nil, &apiError{503, "query_failed", "Could not read index counts."}
				}
				return map[string]any{"sync": m, "counts": map[string]int64{"matches": matches, "finishedMatches": finished, "events": events, "rounds": rounds, "snapshots": snapshots}}, nil
			}
			return m, nil
		})
	}
	mux.HandleFunc("GET /ready", status(true))
	mux.HandleFunc("GET /sync", status(false))
	mux.HandleFunc("GET /matches", s.read(func(r *http.Request, tx *sql.Tx, m metadata) (any, *apiError) {
		limit, offset, failure := pagination(r)
		if failure != nil {
			return nil, failure
		}
		rows, err := tx.QueryContext(r.Context(), `SELECT data FROM matches WHERE deployment_id=$1 ORDER BY match_id LIMIT $2 OFFSET $3`, s.deploymentID, limit+1, offset)
		if err != nil {
			log.Printf("List matches: %v", err)
			return nil, &apiError{503, "query_failed", "Could not read matches."}
		}
		defer rows.Close()
		items := []any{}
		for rows.Next() {
			var data []byte
			var match match
			if err = rows.Scan(&data); err == nil {
				err = json.Unmarshal(data, &match)
			}
			if err != nil {
				return nil, &apiError{503, "query_failed", "Could not decode indexed match."}
			}
			items = append(items, map[string]any{"match": match, "confirmation": m.confirmation(match.Source.Block)})
		}
		if rows.Err() != nil {
			return nil, &apiError{503, "query_failed", "Could not finish reading matches."}
		}
		hasMore := len(items) > limit
		if hasMore {
			items = items[:limit]
		}
		return map[string]any{"meta": m, "items": items, "limit": limit, "offset": offset, "hasMore": hasMore}, nil
	}))
	mux.HandleFunc("GET /matches/{id}", s.read(func(r *http.Request, tx *sql.Tx, m metadata) (any, *apiError) {
		id, failure := matchID(r)
		if failure != nil {
			return nil, failure
		}
		var data []byte
		err := tx.QueryRowContext(r.Context(), `SELECT data FROM matches WHERE deployment_id=$1 AND match_id=$2`, s.deploymentID, id).Scan(&data)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &apiError{404, "match_not_found", "Match has not been indexed in this deployment."}
		}
		if err != nil {
			return nil, &apiError{503, "query_failed", "Could not read match."}
		}
		var match match
		if err = json.Unmarshal(data, &match); err != nil {
			return nil, &apiError{503, "query_failed", "Could not decode indexed match."}
		}
		return map[string]any{"meta": m, "match": match, "confirmation": m.confirmation(match.Source.Block)}, nil
	}))
	mux.HandleFunc("GET /matches/{id}/events", s.read(func(r *http.Request, tx *sql.Tx, m metadata) (any, *apiError) {
		id, failure := matchID(r)
		if failure != nil {
			return nil, failure
		}
		limit, offset, failure := pagination(r)
		if failure != nil {
			return nil, failure
		}
		var exists bool
		if err := tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM matches WHERE deployment_id=$1 AND match_id=$2)`, s.deploymentID, id).Scan(&exists); err != nil {
			return nil, &apiError{503, "query_failed", "Could not read match."}
		}
		if !exists {
			return nil, &apiError{404, "match_not_found", "Match has not been indexed in this deployment."}
		}
		rows, err := tx.QueryContext(r.Context(), `SELECT name,block_number,raw_log,payload FROM chain_events WHERE deployment_id=$1 AND match_id=$2 ORDER BY block_number,log_index LIMIT $3 OFFSET $4`, s.deploymentID, id, limit+1, offset)
		if err != nil {
			return nil, &apiError{503, "query_failed", "Could not read events."}
		}
		defer rows.Close()
		items := []any{}
		for rows.Next() {
			var name string
			var block uint64
			var raw, payload json.RawMessage
			if err = rows.Scan(&name, &block, &raw, &payload); err != nil {
				return nil, &apiError{503, "query_failed", "Could not decode indexed event."}
			}
			items = append(items, map[string]any{"name": name, "raw": raw, "payload": payload, "confirmation": m.confirmation(block)})
		}
		if rows.Err() != nil {
			return nil, &apiError{503, "query_failed", "Could not finish reading events."}
		}
		hasMore := len(items) > limit
		if hasMore {
			items = items[:limit]
		}
		return map[string]any{"meta": m, "items": items, "limit": limit, "offset": offset, "hasMore": hasMore}, nil
	}))
	for _, view := range []string{"replay", "verification", "snapshots"} {
		mux.HandleFunc("GET /matches/{id}/"+view, s.replayRoute(view))
	}
	return mux
}

func Status(root string) error {
	cfg, err := readConfig(root)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 5 * time.Second}
	response, err := client.Get("http://" + cfg.HTTP + "/sync")
	if err != nil {
		return fmt.Errorf("read backend status: %w", err)
	}
	defer response.Body.Close()
	if _, err = io.Copy(os.Stdout, response.Body); err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("status endpoint returned HTTP %d", response.StatusCode)
	}
	return nil
}
