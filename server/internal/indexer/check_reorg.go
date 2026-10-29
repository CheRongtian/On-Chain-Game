package indexer

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"onchainarena/server/internal/game"
)

func newBigID(id string) *big.Int {
	value, _ := new(big.Int).SetString(id, 10)
	return value
}

func (c *checker) waitAtTip(previousPID int) (metadata, error) {
	head, err := c.chain.HeaderByNumber(c.ctx, nil)
	if err != nil {
		return metadata{}, err
	}
	ctx, cancel := context.WithTimeout(c.ctx, 2*time.Minute)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	last := "waiting for canonical indexing"
	for {
		var meta metadata
		if err = c.get(ctx, "/ready", &meta); err == nil {
			if meta.Ready && meta.IndexedBlock == head.Number.Int64() && meta.IndexedHash == head.Hash().Hex() &&
				meta.DeploymentHash == c.report.DeploymentHash.Hex() && (previousPID < 0 || meta.ProcessID != previousPID) {
				return meta, nil
			}
			last = fmt.Sprintf("expected canonical cursor %s/%s, got %d/%s", head.Number, head.Hash().Hex(), meta.IndexedBlock, meta.IndexedHash)
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

func (c *checker) snapshot() (string, error) {
	var id string
	err := c.rpc.CallContext(c.ctx, &id, "evm_snapshot")
	return id, err
}

func (c *checker) revert(id string) error {
	var reverted bool
	if err := c.rpc.CallContext(c.ctx, &reverted, "evm_revert", id); err != nil {
		return err
	}
	if !reverted {
		return fmt.Errorf("Anvil refused to restore acceptance snapshot %s", id)
	}
	return nil
}

func (c *checker) openFaultMatch(name string, host int) (*checkedMatch, error) {
	entry := &checkedMatch{Name: name, Round: 1}
	c.report.FaultMatches = append(c.report.FaultMatches, entry)
	if _, err := c.send(entry, host, "createMatch", uint8(1)); err != nil {
		return entry, err
	}
	if _, err := c.send(entry, 1-host, "joinMatch", newBigID(entry.ID)); err != nil {
		return entry, err
	}
	_, err := c.send(entry, host, "startMatch", newBigID(entry.ID))
	return entry, err
}

func (c *checker) submitHolds(entry *checkedMatch, committed, revealed [2]bool) error {
	matchContext := game.MatchContext{ChainID: game.U256(c.cfg.ChainID), Arena: game.Address(common.HexToAddress(c.cfg.Arena))}
	newBigID(entry.ID).FillBytes(matchContext.MatchID[:])
	var salts [2]game.Hash
	orders := game.HoldActions()
	for player := range c.accounts {
		if !committed[player] {
			continue
		}
		if _, err := rand.Read(salts[player][:]); err != nil {
			return err
		}
		commitment, err := game.Commitment(matchContext, 1, game.Address(c.accounts[player]), orders, salts[player])
		if err != nil {
			return err
		}
		if _, err = c.send(entry, player, "commitActions", newBigID(entry.ID), uint8(1), [32]byte(commitment)); err != nil {
			return err
		}
	}
	for player := range c.accounts {
		if revealed[player] {
			if _, err := c.send(entry, player, "revealActions", newBigID(entry.ID), uint8(1), orders, [32]byte(salts[player])); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *checker) timeout(entry *checkedMatch, phase uint8, outcome game.Outcome) error {
	values, err := c.read(nil, "getMatch", newBigID(entry.ID))
	if err != nil {
		return err
	}
	summary := *abi.ConvertType(values[0], new(chainMatch)).(*chainMatch)
	if summary.Phase != phase || summary.PhaseDeadline == 0 {
		return fmt.Errorf("fault match %s is not in timeout phase %d", entry.ID, phase)
	}
	var ignored any
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setNextBlockTimestamp", summary.PhaseDeadline+1); err != nil {
		return err
	}
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_mine"); err != nil {
		return err
	}
	if _, err = c.send(entry, 0, "advanceExpiredPhase", newBigID(entry.ID), summary.Round, phase); err != nil {
		return err
	}
	wantReason := game.CommitTimeout
	if phase == 3 {
		wantReason = game.RevealTimeout
	}
	if entry.State.Outcome != outcome || entry.State.Reason != wantReason {
		return fmt.Errorf("timeout chain result differs: outcome=%d reason=%d", entry.State.Outcome, entry.State.Reason)
	}
	return nil
}

func (c *checker) expectHTTP(path string, status int) error {
	request, err := http.NewRequestWithContext(c.ctx, http.MethodGet, "http://"+c.cfg.HTTP+path, nil)
	if err != nil {
		return err
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		return fmt.Errorf("%s expected HTTP %d, got %d", path, status, response.StatusCode)
	}
	return nil
}

func (c *checker) expectProjectedResult(id string, phase uint8, outcome game.Outcome) error {
	var response struct {
		Match match `json:"match"`
	}
	if err := c.get(c.ctx, "/matches/"+id, &response); err != nil {
		return err
	}
	if response.Match.Phase != phase || response.Match.Outcome != outcome {
		return fmt.Errorf("match %s retained the wrong branch result: phase=%d outcome=%d", id, response.Match.Phase, response.Match.Outcome)
	}
	if phase == 6 && response.Match.Battle != nil {
		return fmt.Errorf("a cancelled replacement room retained an old branch's battle state")
	}
	return nil
}

func (c *checker) checkBranches() (err error) {
	originalSnapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	originalRecords, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	// Branch tests advance time and replace blocks. Restore their entire scope so
	// a reused local backend retains its original rooms, deadlines, and account nonces.
	defer func() { err = errors.Join(err, c.restoreFaultBranch(originalSnapshot, originalRecords)) }()
	entry, err := c.openFaultMatch("branch-timeout", 0)
	if err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	snapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	before, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	if err = c.submitHolds(entry, [2]bool{true, false}, [2]bool{}); err != nil {
		return err
	}
	if err = c.timeout(entry, 2, game.PlayerA); err != nil {
		return err
	}
	ghost := &checkedMatch{Name: "displaced-room"}
	c.report.FaultMatches = append(c.report.FaultMatches, ghost)
	if _, err = c.send(ghost, 0, "createMatch", uint8(1)); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	result, err := c.expectVerification(entry.ID, "Verified")
	if err != nil {
		return err
	}
	c.recordHistory("commit-timeout", entry.ID, result)
	if err = c.revert(snapshot); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	after, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(before, after) {
		c.report.Baseline, c.report.Actual = before, after
		return fmt.Errorf("reorg recovery did not restore the common-ancestor records and cursor")
	}
	if err = c.expectProjectedResult(entry.ID, 2, game.Ongoing); err != nil {
		return err
	}
	for _, path := range []string{"/matches/" + ghost.ID, "/matches/" + ghost.ID + "/verification"} {
		if err = c.expectHTTP(path, 404); err != nil {
			return fmt.Errorf("displaced room still visible: %w", err)
		}
	}
	result, err = c.expectVerification(entry.ID, "Incomplete")
	if err != nil {
		return err
	}
	c.recordHistory("rollback-to-common-ancestor", entry.ID, result)
	var archivedWin bool
	if err = c.db.QueryRowContext(c.ctx, `SELECT EXISTS(SELECT 1 FROM orphaned_blocks b,jsonb_array_elements(b.events) e
		WHERE b.deployment_id=$1 AND e->>'name'='MatchFinished' AND e->>'tx_hash'=$2)`, c.store.deploymentID, entry.Source.TxHash).Scan(&archivedWin); err != nil {
		return err
	}
	if !archivedWin {
		return fmt.Errorf("the displaced victory was not archived with its original source")
	}
	log.Print("PASS: running Indexer rolled back to the common ancestor; the old win and displaced room disappeared.")
	// Keep evidence for each branch separate even when the match ID is reused.
	replacement := &checkedMatch{Name: "replacement-reveal-timeout", ID: entry.ID, State: entry.Snapshots[0].State, StateHash: entry.Snapshots[0].Hash, Round: 1}
	c.report.FaultMatches = append(c.report.FaultMatches, replacement)
	if err = c.submitHolds(replacement, [2]bool{true, true}, [2]bool{false, true}); err != nil {
		return err
	}
	if err = c.timeout(replacement, 3, game.PlayerB); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	result, err = c.expectVerification(replacement.ID, "Verified")
	if err != nil {
		return err
	}
	if err = c.expectProjectedResult(replacement.ID, 5, game.PlayerB); err != nil {
		return err
	}
	c.recordHistory("replacement-reveal-timeout", replacement.ID, result)
	log.Print("PASS: the replacement branch produced and verified its own result for the same match ID.")
	if err = c.checkCrashBranch(); err != nil {
		return err
	}
	var archived int
	if err = c.db.QueryRowContext(c.ctx, `SELECT count(*) FROM orphaned_blocks WHERE deployment_id=$1`, c.store.deploymentID).Scan(&archived); err != nil {
		return err
	}
	if archived == 0 {
		return fmt.Errorf("displaced branches were not retained for diagnosis")
	}
	baseline, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	meta, err := c.waitAtTip(-1)
	if err != nil {
		return err
	}
	if err = c.request("reindex"); err != nil {
		return err
	}
	meta, err = c.waitAtTip(meta.ProcessID)
	if err != nil {
		return err
	}
	actual, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(baseline, actual) {
		c.report.Baseline, c.report.Actual = baseline, actual
		return fmt.Errorf("a clean canonical rebuild differs from recovered projections")
	}
	for _, match := range c.report.Matches {
		if _, err = c.expectVerification(match.ID, "Verified"); err != nil {
			return err
		}
	}
	if _, err = c.expectVerification(replacement.ID, "Verified"); err != nil {
		return err
	}
	c.report.History = append(c.report.History, historyCheck{Name: "recovered-versus-clean-rebuild", Block: uint64(meta.IndexedBlock), BlockHash: common.HexToHash(meta.IndexedHash)})
	log.Printf("PASS: recovered data matched a clean rebuild at block %d; %d displaced blocks remain isolated.", meta.IndexedBlock, archived)
	return nil
}

func (c *checker) restoreFaultBranch(snapshot string, before map[string][]json.RawMessage) error {
	cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	restorer := *c
	restorer.ctx = cleanup
	if err := restorer.revert(snapshot); err != nil {
		return fmt.Errorf("restore the chain after branch faults: %w", err)
	}
	meta, err := restorer.waitAtTip(-1)
	if err != nil {
		return fmt.Errorf("restore indexed records after branch faults: %w", err)
	}
	after, err := c.store.export(cleanup)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(before, after) {
		if c.report.Baseline == nil {
			c.report.Baseline, c.report.Actual = before, after
		}
		return fmt.Errorf("branch-fault cleanup changed the original canonical records")
	}
	for _, entry := range c.report.Matches {
		if _, err = restorer.expectVerification(entry.ID, "Verified"); err != nil {
			return err
		}
	}
	c.report.History = append(c.report.History, historyCheck{Name: "branch-fault-cleanup", Block: uint64(meta.IndexedBlock), BlockHash: common.HexToHash(meta.IndexedHash)})
	log.Print("PASS: branch-fault cleanup restored the original chain time, rooms, and canonical records.")
	return nil
}

func (c *checker) checkCrashBranch() error {
	snapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	entry, err := c.openFaultMatch("before-crash-timeout", 0)
	if err != nil {
		return err
	}
	if err = c.timeout(entry, 2, game.Draw); err != nil {
		return err
	}
	meta, err := c.waitAtTip(-1)
	if err != nil {
		return err
	}
	draw, err := c.expectVerification(entry.ID, "Verified")
	if err != nil {
		return err
	}
	c.recordHistory("commit-timeout-draw", entry.ID, draw)
	if err = c.signalIndexer(meta.ProcessID, "STOP"); err != nil {
		return err
	}
	// Resume on an interrupted check so a reused backend is never left suspended.
	defer func() { _ = c.signalIndexer(meta.ProcessID, "CONT") }()
	if err = c.revert(snapshot); err != nil {
		return err
	}
	replacement := &checkedMatch{Name: "offline-replacement-room"}
	c.report.FaultMatches = append(c.report.FaultMatches, replacement)
	if _, err = c.send(replacement, 1, "createMatch", uint8(1)); err != nil {
		return err
	}
	if replacement.ID != entry.ID {
		return fmt.Errorf("offline replacement did not reuse the reverted room ID")
	}
	if _, err = c.send(replacement, 1, "cancelWaitingMatch", newBigID(replacement.ID)); err != nil {
		return err
	}
	log.Print("Simulating an abrupt Go exit while a different chain branch is waiting to be indexed.")
	if err = c.request("restart"); err != nil {
		return err
	}
	// The container supervisor must consume the restart request before Go exits.
	if err = c.waitRestartHandler(); err != nil {
		return err
	}
	if err = c.signalIndexer(meta.ProcessID, "KILL"); err != nil {
		return err
	}
	if _, err = c.waitAtTip(meta.ProcessID); err != nil {
		return err
	}
	if err = c.expectProjectedResult(replacement.ID, 6, game.Ongoing); err != nil {
		return err
	}
	result, err := c.expectVerification(replacement.ID, "Incomplete")
	if err != nil {
		return err
	}
	if !result.PrefixVerified || result.Complete {
		return fmt.Errorf("cancelled replacement was certified as a completed battle")
	}
	c.recordHistory("crash-and-offline-branch-replacement", replacement.ID, result)
	log.Print("PASS: after an abrupt exit, startup recovered the replacement branch and discarded the old battle result.")
	return nil
}

func (c *checker) waitRestartHandler() error {
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		_, err := os.Stat(filepath.Join(c.root, ".local", "indexer-command"))
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the launcher did not consume the restart request: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}
