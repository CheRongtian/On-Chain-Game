package indexer

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type requestBudget struct {
	tokens float64
	at     time.Time
}

func (b *requestBudget) take(now time.Time, rate, burst float64) bool {
	if b.at.IsZero() {
		b.tokens = burst
	} else {
		b.tokens = min(burst, b.tokens+now.Sub(b.at).Seconds()*rate)
	}
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type operations struct {
	rpcChecks       atomic.Uint64
	rpcFailures     atomic.Uint64
	rpcDuration     atomic.Int64
	rpcLastDuration atomic.Int64
	rpcLastCheck    atomic.Int64
	requests        atomic.Uint64
	rejected        atomic.Uint64
	streams         atomic.Int64
	disconnects     atomic.Uint64
	keeperFailures  atomic.Uint64
	keeperRetries   atomic.Uint64
	verified        atomic.Uint64
	mismatch        atomic.Uint64
	incomplete      atomic.Uint64
	mu              sync.Mutex
	ordinary        requestBudget
	replay          requestBudget
	alerts          map[string]bool
	replayIssues    map[string]bool
}

func (s *service) alert(name string, active bool, detail string) {
	s.ops.mu.Lock()
	if s.ops.alerts == nil {
		s.ops.alerts = map[string]bool{}
	}
	previous := s.ops.alerts[name]
	s.ops.alerts[name] = active
	s.ops.mu.Unlock()
	if active != previous {
		state := "recovered"
		if active {
			state = "active"
		}
		log.Printf("Operational alert %s %s: %s", name, state, detail)
	}
}

func (s *service) observeHealth() {
	state := s.streamState()
	s.mu.RLock()
	keeper := s.keeperState
	s.mu.RUnlock()
	s.alert("rpc_unavailable", state.RPC == "unavailable", "RPC reads need recovery; do not infer a transaction result from this outage.")
	s.alert("database_unavailable", state.Database == "unavailable", "Indexed history is unavailable; live RPC play is independent.")
	s.alert("indexer_delayed", !state.Ready, "History may be delayed; inspect /sync before using indexed results.")
	s.alert("keeper_unavailable", s.cfg.KeeperEnabled && keeper.Error != "", "Public progression is paused; existing transaction hashes must be reconciled before retrying.")
}

func (s *service) observeReplay(id, result string) {
	switch result {
	case "Verified":
		s.ops.verified.Add(1)
	case "Mismatch":
		s.ops.mismatch.Add(1)
	default:
		s.ops.incomplete.Add(1)
	}
	s.ops.mu.Lock()
	if s.ops.replayIssues == nil {
		s.ops.replayIssues = map[string]bool{}
	}
	if result == "Mismatch" {
		s.ops.replayIssues[id] = true
	} else if result == "Verified" {
		delete(s.ops.replayIssues, id)
	}
	active := len(s.ops.replayIssues) > 0
	s.ops.mu.Unlock()
	s.alert("replay_mismatch", active, "A replay check disagreed with indexed data; inspect verification details. Incomplete evidence is not a verified result.")
}

func (s *service) clearReplayObservations() {
	s.ops.mu.Lock()
	s.ops.replayIssues = nil
	s.ops.mu.Unlock()
	s.alert("replay_mismatch", false, "The source branch or index changed; earlier observations were withdrawn and need fresh verification.")
}

func (s *service) limited(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ops.requests.Add(1)
		switch r.URL.Path {
		case "/health", "/ready", "/sync", "/metrics", "/events":
			next.ServeHTTP(w, r)
			return
		}
		heavy := strings.HasPrefix(r.URL.Path, "/matches/") &&
			(strings.HasSuffix(r.URL.Path, "/replay") || strings.HasSuffix(r.URL.Path, "/verification") || strings.HasSuffix(r.URL.Path, "/snapshots"))
		s.ops.mu.Lock()
		allowed := s.ops.ordinary.take(time.Now(), 100, 200)
		if allowed && heavy {
			allowed = s.ops.replay.take(time.Now(), 8, 32)
		}
		s.ops.mu.Unlock()
		if !allowed {
			s.ops.rejected.Add(1)
			w.Header().Set("Retry-After", "1")
			writeResponse(w, http.StatusTooManyRequests, apiError{Code: "rate_limited", Message: "History requests are temporarily limited. Retry after one second; live RPC play remains available."})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *service) metrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	s.mu.RLock()
	seen, keeper := s.observed, s.keeperState
	s.mu.RUnlock()
	state := s.streamState()
	flag := func(value bool) int {
		if value {
			return 1
		}
		return 0
	}
	gauge := func(name, help string, value any) {
		fmt.Fprintf(w, "# HELP arena_%s %s\n# TYPE arena_%s gauge\narena_%s %v\n", name, help, name, name, value)
	}
	counter := func(name, help string, value uint64) {
		fmt.Fprintf(w, "# HELP arena_%s %s\n# TYPE arena_%s counter\narena_%s %d\n", name, help, name, name, value)
	}
	gauge("rpc_up", "Last background RPC probe is available.", flag(state.RPC == "available"))
	gauge("database_up", "Last background database check is available.", flag(state.Database == "available"))
	gauge("indexer_ready", "Index is current and has a recent successful sync, including idle chains.", flag(state.Ready))
	gauge("indexer_lag_blocks", "Observed head minus completed index cursor.", max(int64(seen.Head)-seen.Indexed, 0))
	lastSync := int64(0)
	if !seen.LastSync.IsZero() {
		lastSync = seen.LastSync.Unix()
	}
	gauge("last_sync_timestamp_seconds", "Unix time of the last successful sync, including checks without new blocks.", lastSync)
	gauge("rpc_probe_last_seconds", "Duration of the last background head probe.", float64(s.ops.rpcLastDuration.Load())/1e9)
	gauge("rpc_probe_timestamp_seconds", "Unix time of the last completed background head probe.", s.ops.rpcLastCheck.Load())
	counter("rpc_probes_total", "Background head probes since process start.", s.ops.rpcChecks.Load())
	counter("rpc_probe_failures_total", "Failed background head probes since process start.", s.ops.rpcFailures.Load())
	fmt.Fprintf(w, "# TYPE arena_rpc_probe_seconds_sum counter\narena_rpc_probe_seconds_sum %g\n", float64(s.ops.rpcDuration.Load())/1e9)
	counter("http_requests_total", "Requests handled by this deployment since process start.", s.ops.requests.Load())
	counter("http_limited_total", "Requests rejected by request or stream limits.", s.ops.rejected.Load())
	gauge("sse_connections", "Current open event streams; this does not imply client delivery acknowledgement.", s.ops.streams.Load())
	counter("sse_disconnects_total", "Event streams closed since process start, including normal navigation.", s.ops.disconnects.Load())
	gauge("keeper_enabled", "Keeper is configured for this deployment.", flag(s.cfg.KeeperEnabled))
	gauge("keeper_up", "Enabled Keeper has no current execution error.", flag(s.cfg.KeeperEnabled && keeper.Error == ""))
	gauge("keeper_ready", "Keeper and its indexing dependencies are ready for public work.", flag(s.cfg.KeeperEnabled && keeper.Error == "" && state.Ready))
	counter("keeper_failures_total", "Failed Keeper work cycles since process start.", s.ops.keeperFailures.Load())
	counter("keeper_retries_total", "Keeper resend or replacement broadcasts since process start.", s.ops.keeperRetries.Load())
	counter("replay_verified_total", "Replay requests returning Verified; counts checks, not unique games.", s.ops.verified.Load())
	counter("replay_mismatch_total", "Replay requests returning Mismatch; counts checks, not unique games.", s.ops.mismatch.Load())
	counter("replay_incomplete_total", "Replay requests returning Incomplete; counts checks, not unique games.", s.ops.incomplete.Load())
	gauge("database_connections_in_use", "Connections currently checked out from the Go database pool.", s.db.Stats().InUse)
	s.ops.mu.Lock()
	defer s.ops.mu.Unlock()
	for _, name := range []string{"rpc_unavailable", "database_unavailable", "indexer_delayed", "keeper_unavailable", "replay_mismatch"} {
		fmt.Fprintf(w, "arena_alert_active{name=%q} %d\n", name, flag(s.ops.alerts[name]))
	}
}
