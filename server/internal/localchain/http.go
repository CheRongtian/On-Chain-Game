package localchain

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common/hexutil"
)

type localAPI struct{ chain *Chain }

func (a *localAPI) Checkpoint() checkpoint {
	head := a.chain.backend.BlockChain().CurrentBlock()
	return checkpoint{Number: head.Number.Uint64(), Hash: head.Hash()}
}

func (a *localAPI) AdvanceClock(at *hexutil.Uint64) (bool, error) {
	head := a.chain.backend.BlockChain().CurrentBlock()
	now := uint64(time.Now().Unix())
	// Explicit local time makes deadline acceptance deterministic without waiting ten minutes.
	if at != nil {
		now = uint64(*at)
	}
	if now <= head.Time {
		return false, nil
	}
	if err := a.chain.beacon.AdjustTime(time.Duration(now-head.Time) * time.Second); err != nil {
		return false, err
	}
	return true, nil
}

type call struct {
	Method string          `json:"method"`
	ID     json.RawMessage `json:"id"`
}

type bufferedResponse struct {
	bytes.Buffer
	header http.Header
	status int
}

func (w *bufferedResponse) Header() http.Header    { return w.header }
func (w *bufferedResponse) WriteHeader(status int) { w.status = status }

func (c *Chain) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
	if err != nil {
		http.Error(w, "Invalid RPC request body", http.StatusBadRequest)
		return
	}
	body = bytes.TrimSpace(body)
	batch := len(body) > 0 && body[0] == '['
	var calls []call
	if batch {
		err = json.Unmarshal(body, &calls)
	} else {
		var one call
		err = json.Unmarshal(body, &one)
		calls = []call{one}
	}
	if err != nil || len(calls) == 0 {
		http.Error(w, "Invalid JSON-RPC request", http.StatusBadRequest)
		return
	}
	for _, request := range calls {
		if !strings.HasPrefix(request.Method, "eth_") && !strings.HasPrefix(request.Method, "net_") &&
			!strings.HasPrefix(request.Method, "web3_") && request.Method != "arena_checkpoint" && request.Method != "arena_advanceClock" {
			writeFailure(w, calls, batch, -32601, "This local node exposes eth, net, web3, and Arena persistence methods.")
			return
		}
	}
	// No successful chain response escapes before its block and receipts are durable.
	c.mu.Lock()
	defer c.mu.Unlock()
	r.Body = io.NopCloser(bytes.NewReader(body))
	response := &bufferedResponse{header: make(http.Header), status: http.StatusOK}
	c.handler.ServeHTTP(response, r)
	if err = c.mine(); err == nil {
		err = c.persist()
	}
	if err != nil {
		if c.failure != err.Error() {
			log.Printf("Chain confirmation could not be persisted: %v", err)
			c.failure = err.Error()
		}
		// A send hash acknowledges broadcast only; retain it so receipt polling can recover.
		if len(calls) != 1 || (calls[0].Method != "eth_sendRawTransaction" && calls[0].Method != "eth_sendTransaction") {
			writeFailure(w, calls, batch, -32003, "Chain persistence failed. Confirmation is unavailable; retain the original transaction and retry its receipt.")
			return
		}
	} else if c.failure != "" {
		log.Print("Chain persistence recovered; confirmation reads are available again.")
		c.failure = ""
	}
	for key, values := range response.header {
		w.Header()[key] = values
	}
	w.WriteHeader(response.status)
	_, _ = w.Write(response.Bytes())
}

func writeFailure(w http.ResponseWriter, calls []call, batch bool, code int, message string) {
	values := []any{}
	for _, request := range calls {
		if len(request.ID) != 0 {
			values = append(values, map[string]any{"jsonrpc": "2.0", "id": request.ID,
				"error": map[string]any{"code": code, "message": message}})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	if batch {
		_ = json.NewEncoder(w).Encode(values)
	} else if len(values) == 1 {
		_ = json.NewEncoder(w).Encode(values[0])
	}
}
