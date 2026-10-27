package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

var players = [2]string{
	"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
	"0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
}

type receipt struct {
	TransactionHash string          `json:"transactionHash"`
	Status          json.RawMessage `json:"status"`
	GasUsed         json.RawMessage `json:"gasUsed"`
	BlockNumber     json.RawMessage `json:"blockNumber"`
	Logs            []eventLog      `json:"logs"`
}

type eventLog struct {
	Address string   `json:"address"`
	Topics  []string `json:"topics"`
	Data    string   `json:"data"`
}

type transaction struct {
	Operation string          `json:"operation"`
	MatchID   uint64          `json:"matchId"`
	Round     uint8           `json:"round"`
	GasUsed   uint64          `json:"gasUsed"`
	Receipt   json.RawMessage `json:"receipt"`
}

type gasStats struct {
	Count uint64 `json:"count"`
	Min   uint64 `json:"min"`
	Max   uint64 `json:"max"`
	Total uint64 `json:"total"`
}

type demo struct {
	rpc           string
	arena         string
	output        string
	chainID       string
	foundry       string
	actionsDomain string
	commitType    string
	rulesHash     string
	transactions  []transaction
}

type preparedOrders struct {
	orders     string
	salt       string
	commitment string
}

func main() {
	rpc := flag.String("rpc", "http://127.0.0.1:8545", "Local Anvil RPC URL")
	arena := flag.String("arena", "", "Deployed Arena address")
	output := flag.String("output", "../.local/demo", "Directory for public local demo records")
	flag.Parse()
	d := demo{rpc: *rpc, arena: *arena, output: *output}
	if err := d.run(); err != nil {
		fmt.Fprintln(os.Stderr, "Complete match demonstration failed:", err)
		os.Exit(1)
	}
	fmt.Println("Complete match transactions finished; receipts, events, and gas baseline saved.")
}

func (d *demo) run() (err error) {
	if d.arena == "" {
		return fmt.Errorf("an Arena address is required")
	}
	if err = os.MkdirAll(d.output, 0755); err != nil {
		return err
	}
	defer func() {
		if saveErr := d.saveReports(); saveErr != nil {
			if err == nil {
				err = saveErr
			} else {
				fmt.Fprintln(os.Stderr, "Saving local transaction records failed:", saveErr)
			}
		}
	}()
	if d.chainID, err = d.cast("chain-id", "--rpc-url", d.rpc); err != nil {
		return err
	}
	if d.foundry, err = d.cast("--version"); err != nil {
		return err
	}
	if d.rulesHash, err = d.cast("call", d.arena, "getRulesHash()(bytes32)", "--rpc-url", d.rpc); err != nil {
		return err
	}
	if d.actionsDomain, err = d.cast("keccak", "OnChainTacticalArena.Actions"); err != nil {
		return err
	}
	if d.commitType, err = d.cast("keccak", "ActionCommitment((uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)"); err != nil {
		return err
	}

	fmt.Println("Completing match 1 through a Victory Points win...")
	if err = d.playGame(1, 7, 3, pointOrders); err != nil {
		return err
	}
	fmt.Println("Playing match 2 through elimination from the normal initial state...")
	if err = d.openMatch(2); err != nil {
		return err
	}
	if err = d.playGame(2, 10, 1, eliminationOrders); err != nil {
		return err
	}
	if err = d.commitForfeit(); err != nil {
		return err
	}
	if err = d.revealDraw(); err != nil {
		return err
	}
	logs, err := d.cast("logs", "--address", d.arena, "--from-block", "0", "--to-block", "latest", "--json", "--rpc-url", d.rpc)
	if err != nil {
		return err
	}
	var events []json.RawMessage
	if err = json.Unmarshal([]byte(logs), &events); err != nil {
		return fmt.Errorf("decode Arena event archive: %w\n%s", err, logs)
	}
	return writeJSON(filepath.Join(d.output, "events.json"), events)
}

func (d *demo) playGame(matchID uint64, lastRound, expectedReason uint8, plan func(uint8) ([3]order, [3]order)) error {
	for round := uint8(1); round <= lastRound; round++ {
		// The preceding launcher step already revealed match 1's first-round HOLD orders.
		if matchID != 1 || round != 1 {
			a, b := plan(round)
			prepared, err := d.prepare(matchID, round, a, b)
			if err != nil {
				return err
			}
			if err = d.submitRound(matchID, round, prepared); err != nil {
				return err
			}
		}
		if err := d.send("settleRound", matchID, round, players[1], "settleRound(uint256,uint8)", decimal(matchID), decimal(uint64(round))); err != nil {
			return err
		}
	}
	return d.checkTerminalReceipt(matchID, lastRound, expectedReason)
}

func (d *demo) checkTerminalReceipt(matchID uint64, round, reason uint8) error {
	var result receipt
	if err := json.Unmarshal(d.transactions[len(d.transactions)-1].Receipt, &result); err != nil {
		return err
	}
	if len(result.Logs) != 3 {
		return fmt.Errorf("match %d: expected RoundResolved, PhaseAdvanced, and MatchFinished", matchID)
	}
	signatures := [3]string{
		"RoundResolved(uint256,uint8,bytes32,bytes32,(uint8,uint8)[2],uint8,uint8)",
		"PhaseAdvanced(uint256,uint8,uint8,uint64)",
		"MatchFinished(uint256,uint8,address,uint8,uint8,bytes32)",
	}
	for index, signature := range signatures {
		topic, err := d.cast("keccak", signature)
		if err != nil {
			return err
		}
		entry := result.Logs[index]
		if !strings.EqualFold(entry.Address, d.arena) || len(entry.Topics) != 3 ||
			!strings.EqualFold(entry.Topics[0], topic) || !strings.EqualFold(entry.Topics[1], "0x"+word(matchID)) {
			return fmt.Errorf("match %d: terminal event identity differs", matchID)
		}
	}
	resolved, err := dataWords(result.Logs[0].Data, 8)
	if err != nil {
		return err
	}
	phase, err := dataWords(result.Logs[1].Data, 2)
	if err != nil {
		return err
	}
	finished, err := dataWords(result.Logs[2].Data, 4)
	if err != nil {
		return err
	}
	winner := "0x" + strings.Repeat("0", 24) + strings.ToLower(strings.TrimPrefix(players[0], "0x"))
	if !strings.EqualFold(result.Logs[0].Topics[2], "0x"+word(uint64(round))) ||
		!strings.EqualFold(result.Logs[1].Topics[2], "0x"+word(uint64(round))) ||
		!strings.EqualFold(result.Logs[2].Topics[2], winner) ||
		resolved[6] != word(1) || resolved[7] != word(uint64(reason)) ||
		phase[0] != word(5) || phase[1] != word(0) ||
		finished[0] != word(uint64(round)) || finished[1] != word(1) ||
		finished[2] != word(uint64(reason)) || finished[3] != resolved[1] {
		return fmt.Errorf("match %d: terminal event result or hash differs", matchID)
	}
	return nil
}

func dataWords(data string, count int) ([]string, error) {
	hex := strings.ToLower(strings.TrimPrefix(data, "0x"))
	if len(hex) != count*64 {
		return nil, fmt.Errorf("expected %d ABI event words, got %d hex characters", count, len(hex))
	}
	words := make([]string, count)
	for index := range words {
		words[index] = hex[index*64 : (index+1)*64]
	}
	return words, nil
}

func word(value uint64) string {
	return fmt.Sprintf("%064x", value)
}

func (d *demo) openMatch(matchID uint64) error {
	if err := d.send("createMatch", matchID, 0, players[0], "createMatch(uint8)", "1"); err != nil {
		return err
	}
	if err := d.send("joinMatch", matchID, 0, players[1], "joinMatch(uint256)", decimal(matchID)); err != nil {
		return err
	}
	return d.send("startMatch", matchID, 1, players[0], "startMatch(uint256)", decimal(matchID))
}

func (d *demo) prepare(matchID uint64, round uint8, a, b [3]order) ([2]preparedOrders, error) {
	var prepared [2]preparedOrders
	for player, orders := range [2][3]order{a, b} {
		entry := &prepared[player]
		entry.orders = ordersABI(orders)
		// These deterministic salts belong only to the public, disposable local demonstration.
		entry.salt = fmt.Sprintf("0x%064x", matchID<<16|uint64(round)<<8|uint64(player+1))
		encoded, err := d.cast("abi-encode", "f(bytes32,(uint8,uint8,uint8,uint8[4])[3])", d.actionsDomain, entry.orders)
		if err != nil {
			return prepared, err
		}
		actionsHash, err := d.cast("keccak", encoded)
		if err != nil {
			return prepared, err
		}
		context := fmt.Sprintf("(%s,%s,%d)", d.chainID, d.arena, matchID)
		encoded, err = d.cast("abi-encode", "f(bytes32,(uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)",
			d.commitType, context, decimal(uint64(round)), players[player], d.rulesHash, actionsHash, entry.salt)
		if err != nil {
			return prepared, err
		}
		entry.commitment, err = d.cast("keccak", encoded)
		if err != nil {
			return prepared, err
		}
	}
	return prepared, nil
}

func (d *demo) submitRound(matchID uint64, round uint8, prepared [2]preparedOrders) error {
	for player, entry := range prepared {
		if err := d.send("commitActions", matchID, round, players[player], "commitActions(uint256,uint8,bytes32)",
			decimal(matchID), decimal(uint64(round)), entry.commitment); err != nil {
			return err
		}
	}
	for player, entry := range prepared {
		if err := d.send("revealActions", matchID, round, players[player], "revealActions(uint256,uint8,(uint8,uint8,uint8,uint8[4])[3],bytes32)",
			decimal(matchID), decimal(uint64(round)), entry.orders, entry.salt); err != nil {
			return err
		}
	}
	return nil
}

func (d *demo) commitForfeit() error {
	fmt.Println("Playing match 3 through a one-sided Commit timeout...")
	if err := d.openMatch(3); err != nil {
		return err
	}
	prepared, err := d.prepare(3, 1, holds(), holds())
	if err != nil {
		return err
	}
	if err = d.send("commitActions", 3, 1, players[0], "commitActions(uint256,uint8,bytes32)", "3", "1", prepared[0].commitment); err != nil {
		return err
	}
	return d.expire(3, "2")
}

func (d *demo) revealDraw() error {
	fmt.Println("Playing match 4 through a bilateral Reveal timeout...")
	if err := d.openMatch(4); err != nil {
		return err
	}
	prepared, err := d.prepare(4, 1, holds(), holds())
	if err != nil {
		return err
	}
	for player, entry := range prepared {
		if err = d.send("commitActions", 4, 1, players[player], "commitActions(uint256,uint8,bytes32)", "4", "1", entry.commitment); err != nil {
			return err
		}
	}
	return d.expire(4, "3")
}

func (d *demo) expire(matchID uint64, phase string) error {
	if _, err := d.cast("rpc", "evm_increaseTime", "601", "--rpc-url", d.rpc); err != nil {
		return err
	}
	if _, err := d.cast("rpc", "evm_mine", "--rpc-url", d.rpc); err != nil {
		return err
	}
	return d.send("advanceExpiredPhase", matchID, 1, players[1], "advanceExpiredPhase(uint256,uint8,uint8)", decimal(matchID), "1", phase)
}

func (d *demo) send(operation string, matchID uint64, round uint8, player, signature string, arguments ...string) error {
	args := append([]string{"send", d.arena, signature}, arguments...)
	args = append(args, "--unlocked", "--from", player, "--rpc-url", d.rpc, "--json")
	raw, err := d.cast(args...)
	if err != nil {
		return fmt.Errorf("%s match %d round %d: %w", operation, matchID, round, err)
	}
	var result receipt
	if err = json.Unmarshal([]byte(raw), &result); err != nil {
		return fmt.Errorf("decode %s receipt: %w\n%s", operation, err, raw)
	}
	status, err := quantity(result.Status)
	if err != nil {
		return fmt.Errorf("%s receipt status: %w\n%s", operation, err, raw)
	}
	if status != 1 {
		return fmt.Errorf("%s transaction failed: %s", operation, raw)
	}
	gas, err := quantity(result.GasUsed)
	if err != nil {
		return fmt.Errorf("%s receipt gasUsed: %w\n%s", operation, err, raw)
	}
	block, err := quantity(result.BlockNumber)
	if err != nil {
		return fmt.Errorf("%s receipt blockNumber: %w\n%s", operation, err, raw)
	}
	d.transactions = append(d.transactions, transaction{operation, matchID, round, gas, json.RawMessage(raw)})
	fmt.Printf("%s match=%d round=%d status=1 block=%d gas=%d tx=%s\n", operation, matchID, round, block, gas, result.TransactionHash)
	return nil
}

func (d *demo) cast(arguments ...string) (string, error) {
	command := exec.Command("cast", arguments...)
	command.Stderr = os.Stderr
	output, err := command.Output()
	if err != nil {
		if len(output) != 0 {
			fmt.Fprintln(os.Stderr, string(output))
		}
		return "", fmt.Errorf("cast %s: %w", arguments[0], err)
	}
	return strings.TrimSpace(string(output)), nil
}

func (d *demo) saveReports() error {
	operations := make(map[string]gasStats)
	for _, transaction := range d.transactions {
		stats := operations[transaction.Operation]
		if stats.Count == 0 || transaction.GasUsed < stats.Min {
			stats.Min = transaction.GasUsed
		}
		if transaction.GasUsed > stats.Max {
			stats.Max = transaction.GasUsed
		}
		stats.Count++
		stats.Total += transaction.GasUsed
		operations[transaction.Operation] = stats
	}
	report := struct {
		ChainID    string              `json:"chainId"`
		Arena      string              `json:"arena"`
		Foundry    string              `json:"foundry"`
		Operations map[string]gasStats `json:"operations"`
	}{d.chainID, d.arena, d.foundry, operations}
	if err := writeJSON(filepath.Join(d.output, "transactions.json"), d.transactions); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(d.output, "gas-baseline.json"), report); err != nil {
		return err
	}
	if stats, ok := operations["settleRound"]; ok {
		fmt.Printf("Settlement gas: %d transactions, min=%d, max=%d, total=%d.\n", stats.Count, stats.Min, stats.Max, stats.Total)
	}
	return nil
}

func quantity(raw json.RawMessage) (uint64, error) {
	return strconv.ParseUint(strings.Trim(string(raw), "\""), 0, 64)
}

func decimal(value uint64) string {
	return strconv.FormatUint(value, 10)
}

func writeJSON(destination string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(destination, append(data, '\n'), 0644)
}
