package indexer

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"time"

	"onchainarena/server/internal/game"
)

type streamCheck struct {
	Name     string   `json:"name"`
	Duration int64    `json:"durationMilliseconds"`
	IDs      []string `json:"eventIds,omitempty"`
}
type checkedStreamEvent struct {
	ID   string
	Kind string
	Data json.RawMessage
}
type checkedStream struct {
	ctx    context.Context
	stop   context.CancelFunc
	body   io.ReadCloser
	events chan checkedStreamEvent
	done   chan error
}

func (c *checker) openStream(after string) (*checkedStream, error) {
	ctx, stop := context.WithTimeout(c.ctx, 2*time.Minute)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+c.cfg.HTTP+"/events", nil)
	if err != nil {
		stop()
		return nil, err
	}
	if after != "" {
		req.Header.Set("Last-Event-ID", after)
	}
	response, err := (&http.Client{}).Do(req)
	if err != nil {
		stop()
		return nil, err
	}
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		response.Body.Close()
		stop()
		return nil, fmt.Errorf("SSE returned HTTP %d without an event stream", response.StatusCode)
	}
	stream := &checkedStream{ctx: ctx, stop: stop, body: response.Body, events: make(chan checkedStreamEvent, 64), done: make(chan error, 1)}
	go func() {
		scanner := bufio.NewScanner(response.Body)
		event := checkedStreamEvent{}
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case line == "":
				if event.Kind != "" {
					select {
					case stream.events <- event:
					case <-ctx.Done():
						return
					}
				}
				event = checkedStreamEvent{}
			case strings.HasPrefix(line, "id: "):
				event.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				event.Kind = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				event.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
			}
		}
		if err := scanner.Err(); err != nil {
			stream.done <- err
		} else {
			stream.done <- io.EOF
		}
	}()
	return stream, nil
}
func (s *checkedStream) close() { s.stop(); _ = s.body.Close() }
func (s *checkedStream) next(kind, matchID string) (checkedStreamEvent, error) {
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
	defer cancel()
	for {
		select {
		case event := <-s.events:
			if event.Kind != kind {
				continue
			}
			if matchID != "" {
				var notice streamNotice
				if err := json.Unmarshal(event.Data, &notice); err != nil {
					return event, err
				}
				found := false
				for _, id := range notice.Matches {
					if id == matchID {
						found = true
					}
				}
				if !found {
					continue
				}
			}
			return event, nil
		case err := <-s.done:
			return checkedStreamEvent{}, err
		case <-ctx.Done():
			return checkedStreamEvent{}, fmt.Errorf("waiting for SSE %s: %w", kind, ctx.Err())
		}
	}
}
func (c *checker) recordStream(name string, started time.Time, ids ...string) {
	c.report.Stream = append(c.report.Stream, streamCheck{name, time.Since(started).Milliseconds(), ids})
	log.Printf("PASS: %s in %s.", name, time.Since(started).Round(time.Millisecond))
}
func (c *checker) streamSequence() (string, error) {
	var id int64
	err := c.db.QueryRowContext(c.ctx, `SELECT COALESCE(max(id),0) FROM stream_events WHERE deployment_id=$1`, c.store.deploymentID).Scan(&id)
	return c.store.streamID(id), err
}

func (c *checker) checkStream() (err error) {
	started := time.Now()
	snapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	before, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, c.restoreFaultBranch(snapshot, before)) }()
	log.Print("Running committed SSE, resumption, RPC suspension, project database connection loss, Go SIGKILL, and multi-block branch recovery checks.")
	initial, err := c.streamSequence()
	if err != nil {
		return err
	}
	tx, err := c.db.BeginTx(c.ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	point, err := c.store.cursor(c.ctx)
	if err != nil {
		return err
	}
	if err = c.store.notify(c.ctx, tx, "change", point, []string{c.report.Matches[0].ID}); err != nil {
		return err
	}
	uncommitted, err := c.streamSequence()
	if err != nil {
		return err
	}
	if uncommitted != initial {
		return fmt.Errorf("an uncommitted notification became visible")
	}
	if err = tx.Rollback(); err != nil {
		return err
	}
	rolledBack, err := c.streamSequence()
	if err != nil {
		return err
	}
	if rolledBack != initial {
		return fmt.Errorf("a rolled-back notification remained visible")
	}
	c.recordStream("SSE notices stay invisible until commit and disappear on rollback", started, initial)
	stream, err := c.openStream("")
	if err != nil {
		return err
	}
	defer stream.close()
	reset, err := stream.next("reset", "")
	if err != nil {
		return err
	}
	entry := &checkedMatch{Name: "stream-resumption"}
	c.report.FaultMatches = append(c.report.FaultMatches, entry)
	if _, err = c.send(entry, 0, "createMatch", uint8(1)); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	changed, err := stream.next("change", entry.ID)
	if err != nil {
		return err
	}
	stream.close()
	resumed, err := c.openStream(reset.ID)
	if err != nil {
		return err
	}
	defer resumed.close()
	repeated, err := resumed.next("change", entry.ID)
	if err != nil {
		return err
	}
	if repeated.ID != changed.ID || !reflect.DeepEqual(repeated.Data, changed.Data) {
		return fmt.Errorf("SSE resume changed a committed notification")
	}
	resumed.close()
	c.recordStream("SSE reconnect replays the same committed IDs and data", started, reset.ID, changed.ID)
	resetStarted := time.Now()
	invalid, err := c.openStream("different-deployment:0")
	if err != nil {
		return err
	}
	reset, err = invalid.next("reset", "")
	invalid.close()
	if err != nil {
		return err
	}
	if !strings.HasPrefix(reset.ID, fmt.Sprintf("%d:", c.store.deploymentID)) {
		return fmt.Errorf("SSE reset did not bind the active deployment")
	}
	c.recordStream("an invalid or previous-deployment cursor requests a full refresh", resetStarted, reset.ID)
	if err = c.checkStreamCrash(changed.ID); err != nil {
		return err
	}
	if err = c.checkStreamRPC(); err != nil {
		return err
	}
	if err = c.checkStreamDatabase(); err != nil {
		return err
	}
	return c.checkStreamBranch()
}

func (c *checker) checkStreamCrash(after string) error {
	started := time.Now()
	meta, err := c.waitAtTip(-1)
	if err != nil {
		return err
	}
	process, err := os.FindProcess(meta.ProcessID)
	if err != nil {
		return err
	}
	oldStream, err := c.openStream(after)
	if err != nil {
		return err
	}
	defer oldStream.close()
	log.Print("Deliberately terminating Go without a restart request; the launcher must retain Anvil and recover it.")
	if err = process.Signal(syscall.SIGKILL); err != nil {
		return err
	}
	if _, readErr := oldStream.next("change", ""); readErr == nil || errors.Is(readErr, context.DeadlineExceeded) || errors.Is(readErr, context.Canceled) {
		return fmt.Errorf("terminated Go did not promptly close its old SSE connection: %v", readErr)
	}
	entry := &checkedMatch{Name: "rpc-room-during-go-recovery"}
	c.report.FaultMatches = append(c.report.FaultMatches, entry)
	if _, err = c.send(entry, 1, "createMatch", uint8(1)); err != nil {
		return err
	}
	if _, err = c.waitAtTip(meta.ProcessID); err != nil {
		return err
	}
	stream, err := c.openStream(after)
	if err != nil {
		return err
	}
	defer stream.close()
	event, err := stream.next("change", entry.ID)
	if err != nil {
		return err
	}
	c.recordStream("Go SIGKILL preserves the chain, RPC writes, cursor, and SSE resumption", started, event.ID)
	return nil
}

func (c *checker) readHealth() (streamStatus, error) {
	ctx, cancel := context.WithTimeout(c.ctx, 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+c.cfg.HTTP+"/health", nil)
	if err != nil {
		return streamStatus{}, err
	}
	response, err := c.client.Do(req)
	if err != nil {
		return streamStatus{}, err
	}
	defer response.Body.Close()
	var body struct {
		Services streamStatus `json:"services"`
	}
	err = json.NewDecoder(response.Body).Decode(&body)
	return body.Services, err
}

func (c *checker) checkStreamRPC() error {
	started := time.Now()
	data, err := os.ReadFile(filepath.Join(c.root, ".local", "anvil.pid"))
	if err != nil {
		return fmt.Errorf("restart the backend launcher before RPC fault acceptance: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 1 {
		return fmt.Errorf("invalid managed Anvil process ID")
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	stream, err := c.openStream("")
	if err != nil {
		return err
	}
	defer stream.close()
	if err = process.Signal(syscall.SIGSTOP); err != nil {
		return err
	}
	defer func() { _ = process.Signal(syscall.SIGCONT) }()
	for {
		event, readErr := stream.next("status", "")
		if readErr != nil {
			return readErr
		}
		var state streamStatus
		if err = json.Unmarshal(event.Data, &state); err != nil {
			return err
		}
		if state.RPC == "unavailable" {
			if state.Database != "available" || state.Ready {
				return fmt.Errorf("RPC loss was misclassified: %+v", state)
			}
			break
		}
	}
	health, err := c.readHealth()
	if err != nil || health.RPC != "unavailable" || health.Database != "available" {
		return fmt.Errorf("health did not distinguish RPC loss: %+v; %v", health, err)
	}
	if err = process.Signal(syscall.SIGCONT); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	c.recordStream("RPC suspension clears readiness and reports a recoverable source outage", started)
	return nil
}

func (c *checker) checkStreamDatabase() error {
	started := time.Now()
	var oldPID int
	leaseSQL := `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
		WHERE a.datname=current_database() AND a.application_name='onchain_arena_backend'
		AND l.locktype='advisory' AND l.classid=0 AND l.objid::bigint=$1 AND l.granted LIMIT 1`
	if err := c.db.QueryRowContext(c.ctx, leaseSQL, c.store.deploymentID).Scan(&oldPID); err != nil {
		return err
	}
	before, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	// Only this application's database sessions are terminated; the shared server keeps running.
	rows, err := c.db.QueryContext(c.ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
		WHERE datname=current_database() AND application_name='onchain_arena_backend' AND pid<>pg_backend_pid()`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var terminated bool
		if err = rows.Scan(&terminated); err != nil {
			rows.Close()
			return err
		}
		if !terminated {
			rows.Close()
			return fmt.Errorf("PostgreSQL refused to terminate a project connection")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
	defer cancel()
	for {
		var newPID int
		if readErr := c.db.QueryRowContext(ctx, leaseSQL, c.store.deploymentID).Scan(&newPID); readErr == nil && newPID != oldPID {
			break
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Indexer did not reacquire its database session lock: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	after, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(before, after) {
		return fmt.Errorf("project database reconnection changed canonical records")
	}
	c.recordStream("project database connections and Indexer lock recover without restarting shared PostgreSQL", started)
	return nil
}

func (c *checker) checkStreamBranch() error {
	started := time.Now()
	snapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	entry, err := c.openFaultMatch("sse-old-branch-win", 0)
	if err != nil {
		return err
	}
	if err = c.submitHolds(entry, [2]bool{true, false}, [2]bool{}); err != nil {
		return err
	}
	if err = c.timeout(entry, 2, game.PlayerA); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	if _, err = c.expectVerification(entry.ID, "Verified"); err != nil {
		return err
	}
	after, err := c.streamSequence()
	if err != nil {
		return err
	}
	stream, err := c.openStream(after)
	if err != nil {
		return err
	}
	defer stream.close()
	if err = c.revert(snapshot); err != nil {
		return err
	}
	replacement := &checkedMatch{Name: "sse-replacement-cancelled-room"}
	c.report.FaultMatches = append(c.report.FaultMatches, replacement)
	if _, err = c.send(replacement, 1, "createMatch", uint8(1)); err != nil {
		return err
	}
	if _, err = c.send(replacement, 1, "cancelWaitingMatch", newBigID(replacement.ID)); err != nil {
		return err
	}
	if replacement.ID != entry.ID {
		return fmt.Errorf("SSE branch replacement did not reuse the displaced match ID")
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	retracted, err := stream.next("reorg", entry.ID)
	if err != nil {
		return err
	}
	changed, err := stream.next("change", entry.ID)
	if err != nil {
		return err
	}
	var first, second int64
	_, err = fmt.Sscanf(retracted.ID, fmt.Sprintf("%d:%%d", c.store.deploymentID), &first)
	if err != nil {
		return err
	}
	_, err = fmt.Sscanf(changed.ID, fmt.Sprintf("%d:%%d", c.store.deploymentID), &second)
	if err != nil || second <= first {
		return fmt.Errorf("replacement state arrived before branch withdrawal")
	}
	if err = c.expectProjectedResult(entry.ID, 6, game.Ongoing); err != nil {
		return err
	}
	if _, err = c.expectVerification(entry.ID, "Incomplete"); err != nil {
		return err
	}
	c.recordStream("multi-block reorg retracts the old victory before publishing the replacement", started, retracted.ID, changed.ID)
	return nil
}
