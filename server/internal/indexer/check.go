package indexer

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
	"onchainarena/server/internal/game"
	"onchainarena/server/internal/scenario"
)

type checkedRound struct {
	Number      uint8             `json:"round"`
	Orders      [2][3]game.Action `json:"orders"`
	Salts       [2]game.Hash      `json:"salts"`
	Commitments [2]game.Hash      `json:"commitments"`
	BeforeHash  common.Hash       `json:"beforeHash"`
	AfterHash   common.Hash       `json:"afterHash"`
}

type checkedSnapshot struct {
	Source source           `json:"source"`
	State  game.BattleState `json:"state"`
	Hash   common.Hash      `json:"stateHash"`
}

type checkedEvent struct {
	Name    string          `json:"name"`
	Round   uint8           `json:"round"`
	Log     types.Log       `json:"log"`
	Payload json.RawMessage `json:"payload"`
}

type chainMatch struct {
	Players       [2]common.Address
	MapId         uint8
	RulesHash     [32]byte
	Phase         uint8
	Round         uint8
	JoinDeadline  uint64
	PhaseDeadline uint64
	StateHash     [32]byte
	Outcome       uint8
	Reason        uint8
}

type checkedMatch struct {
	Name      string            `json:"name"`
	ID        string            `json:"id"`
	Round     uint8             `json:"round"`
	State     game.BattleState  `json:"state"`
	StateHash common.Hash       `json:"stateHash"`
	Source    source            `json:"source"`
	Rounds    []checkedRound    `json:"rounds"`
	Snapshots []checkedSnapshot `json:"snapshots"`
	Events    []checkedEvent    `json:"events"`
	summary   chainMatch
}

type checkedOperation struct {
	Name        string `json:"name"`
	PreviousPID int    `json:"previousProcessId"`
	CurrentPID  int    `json:"currentProcessId"`
	Block       uint64 `json:"comparedThroughBlock"`
	Matched     bool   `json:"matched"`
}

type checkReport struct {
	Status         string             `json:"status"`
	Error          string             `json:"error,omitempty"`
	Started        time.Time          `json:"startedAt"`
	Duration       time.Duration      `json:"durationNanoseconds"`
	ChainID        uint64             `json:"chainId"`
	Arena          string             `json:"arena"`
	DeploymentHash common.Hash        `json:"deploymentHash"`
	Matches        []*checkedMatch    `json:"matches"`
	Operations     []checkedOperation `json:"operations"`
	History        []historyCheck     `json:"historyChecks"`
	FaultMatches   []*checkedMatch    `json:"faultMatches"`
	Keeper         []keeperCheck      `json:"keeperChecks,omitempty"`
	Receipts       []struct {
		MatchID string         `json:"matchId"`
		Method  string         `json:"method"`
		Receipt *types.Receipt `json:"receipt"`
	} `json:"receipts"`
	Baseline map[string][]json.RawMessage `json:"failedBaseline,omitempty"`
	Actual   map[string][]json.RawMessage `json:"failedActual,omitempty"`
}

type checker struct {
	ctx      context.Context
	root     string
	cfg      config
	rpc      *rpc.Client
	chain    *ethclient.Client
	db       *sql.DB
	store    *service
	client   *http.Client
	accounts [2]common.Address
	report   *checkReport
	gate     *sql.Conn
}

func Check(ctx context.Context, root string, withKeeper bool) (err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cfg, err := readConfig(root)
	if err != nil {
		return err
	}
	if withKeeper && !cfg.KeeperEnabled {
		return fmt.Errorf("Keeper acceptance requires KEEPER_ENABLED=true; ordinary manual play supports false")
	}
	dir := filepath.Join(root, ".local", "indexer")
	if err = os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	report := &checkReport{Status: "running", Started: time.Now().UTC(), ChainID: cfg.ChainID, Arena: cfg.Arena}
	defer func() {
		report.Duration = time.Since(report.Started)
		if err != nil {
			report.Status, report.Error = "failed", err.Error()
		}
		data, saveErr := json.MarshalIndent(report, "", "  ")
		if saveErr == nil {
			saveErr = os.WriteFile(filepath.Join(dir, "acceptance.json"), append(data, '\n'), 0600)
		}
		if saveErr != nil {
			if err == nil {
				err = saveErr
			} else {
				log.Printf("Save acceptance evidence: %v", saveErr)
			}
		}
		if err == nil {
			log.Printf("PASS: indexing, replay, recovery, and requested acceptance scenarios matched in %s. Local acceptance report saved.", report.Duration.Round(time.Millisecond))
		}
	}()
	c := &checker{ctx: ctx, root: root, cfg: cfg, client: &http.Client{Timeout: 35 * time.Second}, report: report}
	c.rpc, err = rpc.DialContext(ctx, cfg.RPC)
	if err != nil {
		return err
	}
	defer c.rpc.Close()
	c.chain = ethclient.NewClient(c.rpc)
	setup, finish := context.WithTimeout(ctx, 15*time.Second)
	defer finish()
	id, err := c.chain.ChainID(setup)
	if err != nil {
		return err
	}
	if id.Cmp(new(big.Int).SetUint64(cfg.ChainID)) != 0 {
		return fmt.Errorf("RPC is not serving the configured local chain")
	}
	anchor, err := c.chain.HeaderByNumber(setup, new(big.Int).SetUint64(cfg.From))
	if err != nil {
		return err
	}
	report.DeploymentHash = anchor.Hash()
	var accounts []common.Address
	if err = c.rpc.CallContext(setup, &accounts, "eth_accounts"); err != nil {
		return err
	}
	if len(accounts) < 2 {
		return fmt.Errorf("two unlocked local accounts are required")
	}
	copy(c.accounts[:], accounts[:2])
	finish()
	meta, err := c.waitReady(-1, cfg.From)
	if err != nil {
		return err
	}
	log.Print("Loading the current Go build while keeping Anvil and existing rooms running.")
	if err = c.request("restart"); err != nil {
		return err
	}
	meta, err = c.waitReady(meta.ProcessID, uint64(meta.IndexedBlock))
	if err != nil {
		return err
	}
	values, err := c.read(nil, "getRulesHash")
	if err != nil {
		return err
	}
	if len(values) != 1 {
		return fmt.Errorf("getRulesHash returned an unexpected ABI result")
	}
	rules, ok := values[0].([32]byte)
	if !ok || game.Hash(rules) != game.RulesHash() {
		return fmt.Errorf("the current deployment has unsupported rules")
	}
	c.db, err = sql.Open("pgx", cfg.Database)
	if err != nil {
		return err
	}
	defer c.db.Close()
	var deploymentID int64
	err = c.db.QueryRowContext(ctx, `SELECT id FROM deployments WHERE chain_id=$1 AND arena=$2 AND deployment_hash=$3`,
		id.String(), cfg.Arena, anchor.Hash().Hex()).Scan(&deploymentID)
	if err != nil {
		return fmt.Errorf("find the active indexed deployment: %w", err)
	}
	c.store = &service{cfg: cfg, db: c.db, deploymentID: deploymentID, rpc: c.rpc, chain: c.chain, anchor: anchor}
	if err = c.holdKeeper(); err != nil {
		return err
	}
	defer func() { releaseKeeperGate(c.gate, deploymentID) }()
	for _, plan := range []struct {
		name   string
		rounds uint8
		reason game.EndReason
		orders func(uint8) ([3]game.Action, [3]game.Action)
	}{{"points", 7, game.VictoryPoints, scenario.PointOrders}, {"elimination", 10, game.Elimination, scenario.EliminationOrders}} {
		entry := &checkedMatch{Name: plan.name}
		report.Matches = append(report.Matches, entry)
		if err = c.play(entry, plan.rounds, plan.reason, plan.orders); err != nil {
			return fmt.Errorf("%s match %s round %d: %w", entry.Name, entry.ID, entry.Round, err)
		}
	}
	lastBlock := report.Matches[len(report.Matches)-1].Source.Block
	meta, err = c.waitReady(-1, lastBlock)
	if err != nil {
		return err
	}
	if err = c.checkRecords(); err != nil {
		return err
	}
	log.Print("PASS: both chain results, API details, raw events, rounds, revealed actions, and snapshots matched.")
	baseline, err := c.store.export(ctx)
	if err != nil {
		return err
	}
	for _, operation := range []string{"restart", "rescan", "reindex"} {
		if operation != "restart" {
			if err = os.Remove(filepath.Join(dir, operation+".json")); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		previous := meta.ProcessID
		if err = c.request(operation); err != nil {
			return err
		}
		meta, err = c.waitReady(previous, uint64(meta.IndexedBlock))
		if err != nil {
			return fmt.Errorf("wait for %s: %w", operation, err)
		}
		actual, readErr := c.store.export(ctx)
		if readErr != nil {
			return readErr
		}
		matched := reflect.DeepEqual(baseline, actual)
		report.Operations = append(report.Operations, checkedOperation{operation, previous, meta.ProcessID, uint64(meta.IndexedBlock), matched})
		if !matched {
			report.Baseline, report.Actual = baseline, actual
			return fmt.Errorf("indexed records or cursor changed after %s; before/after evidence is saved in the acceptance report", operation)
		}
		if operation != "restart" {
			var comparison struct {
				Operation      string      `json:"operation"`
				Status         string      `json:"status"`
				Matched        bool        `json:"matched"`
				Block          uint64      `json:"comparedThroughBlock"`
				DeploymentHash common.Hash `json:"deploymentHash"`
			}
			data, readErr := os.ReadFile(filepath.Join(dir, operation+".json"))
			if readErr != nil {
				return readErr
			}
			if err = json.Unmarshal(data, &comparison); err != nil {
				return err
			}
			if comparison.Operation != operation || comparison.Status != "compared" || !comparison.Matched || comparison.Block != uint64(meta.IndexedBlock) || comparison.DeploymentHash != report.DeploymentHash {
				return fmt.Errorf("%s did not produce a successful comparison for the current deployment and cursor", operation)
			}
		}
		if err = c.checkRecords(); err != nil {
			return fmt.Errorf("after %s: %w", operation, err)
		}
		log.Printf("PASS: %s preserved all records and cursor at block %d (Go process %d -> %d).", operation, meta.IndexedBlock, previous, meta.ProcessID)
	}
	if err = c.checkHistory(); err != nil {
		return err
	}
	if withKeeper {
		if err = c.checkKeeper(); err != nil {
			return fmt.Errorf("Keeper acceptance: %w", err)
		}
	}
	report.Status = "passed"
	return nil
}

func (c *checker) request(operation string) error {
	command := exec.CommandContext(c.ctx, "bash", "-e", "-u", "-o", "pipefail", "-c", `project_root="$1"
source "$project_root/scripts/local-indexer.sh"
request_indexer_operation "$2"`, "check-indexer", c.root, operation)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("request %s: %w", operation, err)
	}
	return nil
}

func (c *checker) waitReady(previousPID int, block uint64) (metadata, error) {
	ctx, cancel := context.WithTimeout(c.ctx, 2*time.Minute)
	defer cancel()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	last := "the read API is not ready"
	for {
		var meta metadata
		err := c.get(ctx, "/ready", &meta)
		if err == nil {
			if meta.ChainID != c.cfg.ChainID || !strings.EqualFold(meta.Arena, c.cfg.Arena) || meta.DeploymentHash != c.report.DeploymentHash.Hex() {
				return meta, fmt.Errorf("the read API is serving a different deployment")
			}
			if meta.Ready && meta.IndexedBlock >= 0 && uint64(meta.IndexedBlock) >= block && (previousPID < 0 || meta.ProcessID > 0 && meta.ProcessID != previousPID) {
				return meta, nil
			}
			last = fmt.Sprintf("waiting for cursor >= %d and Go process change; current cursor=%d process=%d", block, meta.IndexedBlock, meta.ProcessID)
		} else {
			last = err.Error()
		}
		select {
		case <-ctx.Done():
			return meta, fmt.Errorf("%s: %w", last, ctx.Err())
		case <-ticker.C:
		}
	}
}

func (c *checker) get(ctx context.Context, path string, value any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+c.cfg.HTTP+path, nil)
	if err != nil {
		return err
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("read API %s returned HTTP %d", path, response.StatusCode)
	}
	return json.NewDecoder(response.Body).Decode(value)
}

func (c *checker) read(block *big.Int, method string, args ...any) ([]any, error) {
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	data, err := c.cfg.ABI.Pack(method, args...)
	if err != nil {
		return nil, err
	}
	arena := common.HexToAddress(c.cfg.Arena)
	result, err := c.chain.CallContract(ctx, ethereum.CallMsg{To: &arena, Data: data}, block)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", method, err)
	}
	return c.cfg.ABI.Methods[method].Outputs.Unpack(result)
}

func (c *checker) battle(block *big.Int, id *big.Int) (game.BattleState, error) {
	var state game.BattleState
	values, err := c.read(block, "getBattleState", id)
	if err != nil {
		return state, err
	}
	if len(values) != 1 {
		return state, fmt.Errorf("getBattleState returned an unexpected ABI result")
	}
	data, err := json.Marshal(values[0])
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(data, &state)
	return state, err
}

func (c *checker) send(entry *checkedMatch, player int, method string, args ...any) (*types.Receipt, error) {
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	data, err := c.cfg.ABI.Pack(method, args...)
	if err != nil {
		return nil, err
	}
	arena := common.HexToAddress(c.cfg.Arena)
	gas, err := c.chain.EstimateGas(ctx, ethereum.CallMsg{From: c.accounts[player], To: &arena, Data: data})
	if err != nil {
		return nil, fmt.Errorf("estimate %s: %w", method, err)
	}
	var hash common.Hash
	err = c.rpc.CallContext(ctx, &hash, "eth_sendTransaction", map[string]any{
		"from": c.accounts[player], "to": arena, "data": hexutil.Bytes(data), "gas": hexutil.Uint64(gas),
	})
	if err != nil {
		return nil, fmt.Errorf("send %s: %w", method, err)
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	var receipt *types.Receipt
	for {
		receipt, err = c.chain.TransactionReceipt(ctx, hash)
		if err == nil {
			break
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for %s transaction %s: %w", method, hash.Hex(), ctx.Err())
		case <-ticker.C:
		}
	}
	return c.recordReceipt(entry, method, receipt)
}

func (c *checker) recordReceipt(entry *checkedMatch, method string, receipt *types.Receipt) (*types.Receipt, error) {
	arena := common.HexToAddress(c.cfg.Arena)
	var err error
	index := len(c.report.Receipts)
	c.report.Receipts = append(c.report.Receipts, struct {
		MatchID string         `json:"matchId"`
		Method  string         `json:"method"`
		Receipt *types.Receipt `json:"receipt"`
	}{entry.ID, method, receipt})
	if receipt.Status != types.ReceiptStatusSuccessful {
		return receipt, fmt.Errorf("%s transaction %s reverted at block %s", method, receipt.TxHash.Hex(), receipt.BlockNumber)
	}
	for _, raw := range receipt.Logs {
		if raw.Address != arena {
			continue
		}
		name, event, payload, decodeErr := decodeEvent(c.cfg.ABI, *raw)
		if decodeErr != nil {
			return receipt, decodeErr
		}
		if name == "MatchCreated" && entry.ID == "" {
			entry.ID = event.MatchID
			c.report.Receipts[index].MatchID = entry.ID
		}
		if event.MatchID != entry.ID {
			return receipt, fmt.Errorf("receipt event belongs to unexpected match %s", event.MatchID)
		}
		entry.Source = source{raw.BlockNumber, raw.BlockHash.Hex(), raw.TxHash.Hex(), raw.Index}
		entry.Events = append(entry.Events, checkedEvent{name, event.Round, *raw, payload})
		switch name {
		case "MatchStarted":
			if event.InitialState == nil {
				return receipt, fmt.Errorf("MatchStarted has no initial state")
			}
			entry.State, entry.StateHash = *event.InitialState, event.StateHash
			entry.Snapshots = append(entry.Snapshots, checkedSnapshot{entry.Source, entry.State, entry.StateHash})
		case "RoundResolved":
			id, ok := new(big.Int).SetString(entry.ID, 10)
			if !ok {
				return receipt, fmt.Errorf("invalid created match ID")
			}
			entry.State, err = c.battle(receipt.BlockNumber, id)
			if err != nil {
				return receipt, err
			}
			entry.StateHash = event.AfterStateHash
			entry.Snapshots = append(entry.Snapshots, checkedSnapshot{entry.Source, entry.State, entry.StateHash})
		case "MatchFinished":
			entry.StateHash = event.StateHash
			if event.Reason == game.CommitTimeout || event.Reason == game.RevealTimeout {
				entry.State, err = c.battle(receipt.BlockNumber, newBigID(entry.ID))
				if err != nil {
					return receipt, err
				}
				entry.Snapshots = append(entry.Snapshots, checkedSnapshot{entry.Source, entry.State, entry.StateHash})
			}
		}
	}
	return receipt, nil
}

func (c *checker) play(entry *checkedMatch, lastRound uint8, reason game.EndReason, orders func(uint8) ([3]game.Action, [3]game.Action)) error {
	if _, err := c.send(entry, 0, "createMatch", uint8(1)); err != nil {
		return err
	}
	id, ok := new(big.Int).SetString(entry.ID, 10)
	if !ok {
		return fmt.Errorf("createMatch did not emit a valid room ID")
	}
	log.Printf("Playing %s match %s with the two local accounts.", entry.Name, entry.ID)
	if _, err := c.send(entry, 1, "joinMatch", id); err != nil {
		return err
	}
	if _, err := c.send(entry, 0, "startMatch", id); err != nil {
		return err
	}
	matchContext := game.MatchContext{ChainID: game.U256(c.cfg.ChainID), Arena: game.Address(common.HexToAddress(c.cfg.Arena))}
	id.FillBytes(matchContext.MatchID[:])
	var receipt *types.Receipt
	for round := uint8(1); round <= lastRound; round++ {
		entry.Round = round
		a, b := orders(round)
		input := checkedRound{Number: round, Orders: [2][3]game.Action{a, b}, BeforeHash: entry.StateHash}
		for player := range c.accounts {
			if _, err := rand.Read(input.Salts[player][:]); err != nil {
				return err
			}
			var err error
			input.Commitments[player], err = game.Commitment(matchContext, round, game.Address(c.accounts[player]), input.Orders[player], input.Salts[player])
			if err != nil {
				return err
			}
			if _, err = c.send(entry, player, "commitActions", id, round, [32]byte(input.Commitments[player])); err != nil {
				return err
			}
		}
		for player := range c.accounts {
			if _, err := c.send(entry, player, "revealActions", id, round, input.Orders[player], [32]byte(input.Salts[player])); err != nil {
				return err
			}
		}
		var err error
		receipt, err = c.send(entry, 1, "settleRound", id, round)
		if err != nil {
			return err
		}
		input.AfterHash = entry.StateHash
		// Orders and salts enter the evidence only after both reveals were accepted.
		entry.Rounds = append(entry.Rounds, input)
		log.Printf("%s match=%s round=%d/%d settled at block %s.", entry.Name, entry.ID, round, lastRound, receipt.BlockNumber)
	}
	values, err := c.read(receipt.BlockNumber, "getMatch", id)
	if err != nil {
		return err
	}
	if len(values) != 1 {
		return fmt.Errorf("getMatch returned an unexpected ABI result")
	}
	entry.summary = *abi.ConvertType(values[0], new(chainMatch)).(*chainMatch)
	if entry.summary.Phase != 5 || entry.summary.Round != lastRound || entry.summary.Outcome != uint8(game.PlayerA) || entry.summary.Reason != uint8(reason) ||
		entry.State.Round != lastRound || entry.State.Outcome != game.PlayerA || entry.State.Reason != reason || entry.StateHash != common.Hash(entry.summary.StateHash) {
		return fmt.Errorf("chain final result differs: phase=%d round=%d outcome=%d reason=%d", entry.summary.Phase, entry.summary.Round, entry.summary.Outcome, entry.summary.Reason)
	}
	log.Printf("PASS: %s match %s finished with the expected chain result.", entry.Name, entry.ID)
	return nil
}
