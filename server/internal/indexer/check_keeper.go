package indexer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"onchainarena/server/internal/game"
)

type keeperCheck struct {
	Name    string   `json:"name"`
	MatchID string   `json:"matchId"`
	JobID   int64    `json:"jobId"`
	Hashes  []string `json:"transactionHashes"`
	Nonce   uint64   `json:"nonce"`
}

func (c *checker) holdKeeper() error {
	if c.gate != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
	defer cancel()
	var err error
	c.gate, err = keeperGate(ctx, c.db, c.store.deploymentID, true)
	return err
}

func (c *checker) allowKeeper() {
	releaseKeeperGate(c.gate, c.store.deploymentID)
	c.gate = nil
}

func (c *checker) waitKeeper(entry *checkedMatch, job keeperJob) (receipt *types.Receipt, err error) {
	c.allowKeeper()
	defer func() { err = errors.Join(err, c.holdKeeper()) }()
	ctx, cancel := context.WithTimeout(c.ctx, 45*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		var hash string
		err = c.db.QueryRowContext(ctx, `SELECT a.tx_hash FROM keeper_attempts a JOIN keeper_jobs j ON j.id=a.job_id
			WHERE j.id=$1 AND j.status='confirmed' AND a.status='confirmed' ORDER BY a.id DESC LIMIT 1`, job.ID).Scan(&hash)
		if err == nil {
			receipt, err = canonicalReceipt(ctx, c.store, common.HexToHash(hash))
			if err != nil {
				return nil, err
			}
			if receipt != nil {
				if _, err = c.recordReceipt(entry, job.Operation, receipt); err != nil {
					return nil, err
				}
				return receipt, nil
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("Keeper job %d did not confirm: %w", job.ID, ctx.Err())
		case <-ticker.C:
		}
	}
}

func (c *checker) keeperJob(k *keeper, entry *checkedMatch) (keeperJob, error) {
	job, eligible, err := k.candidate(c.ctx, entry.ID)
	if err != nil {
		return job, err
	}
	if !eligible {
		return job, fmt.Errorf("acceptance match %s is not eligible for Keeper progression", entry.ID)
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return job, err
	}
	err = k.saveJob(c.ctx, &job)
	return job, err
}

func (c *checker) recordKeeper(name string, job keeperJob) error {
	rows, err := c.db.QueryContext(c.ctx, `SELECT tx_hash,nonce FROM keeper_attempts WHERE job_id=$1 ORDER BY id`, job.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	result := keeperCheck{Name: name, MatchID: job.MatchID, JobID: job.ID}
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash, &result.Nonce); err != nil {
			return err
		}
		result.Hashes = append(result.Hashes, hash)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	c.report.Keeper = append(c.report.Keeper, result)
	log.Printf("PASS: Keeper %s; match=%s job=%d attempts=%d.", name, job.MatchID, job.ID, len(result.Hashes))
	return nil
}

func (c *checker) keeperResolvable() (*checkedMatch, error) {
	entry, err := c.openFaultMatch("keeper-settlement", 0)
	if err != nil {
		return entry, err
	}
	err = c.submitHolds(entry, [2]bool{true, true}, [2]bool{true, true})
	return entry, err
}

func (c *checker) checkKeeper() (err error) {
	k, err := newKeeper(c.ctx, c.store)
	if err != nil {
		return err
	}
	if busy, recoverErr := k.recover(c.ctx); recoverErr != nil || busy {
		return fmt.Errorf("finish existing Keeper transactions before fault acceptance: busy=%t error=%v", busy, recoverErr)
	}
	snapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	before, err := c.store.export(c.ctx)
	if err != nil {
		return err
	}
	var attemptID, jobID int64
	if err = c.db.QueryRowContext(c.ctx, `SELECT COALESCE(max(id),0) FROM keeper_attempts`).Scan(&attemptID); err != nil {
		return err
	}
	if err = c.db.QueryRowContext(c.ctx, `SELECT COALESCE(max(id),0) FROM keeper_jobs`).Scan(&jobID); err != nil {
		return err
	}
	rows, err := c.db.QueryContext(c.ctx, `SELECT id,status FROM keeper_jobs WHERE deployment_id=$1`, c.store.deploymentID)
	if err != nil {
		return err
	}
	states := map[int64]string{}
	for rows.Next() {
		var id int64
		var state string
		if err = rows.Scan(&id, &state); err != nil {
			rows.Close()
			return err
		}
		states[id] = state
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		restorer := *c
		restorer.ctx = cleanup
		if lockErr := restorer.holdKeeper(); lockErr != nil {
			err = errors.Join(err, lockErr)
			return
		}
		c.gate = restorer.gate
		var ignored any
		_, markErr := c.db.ExecContext(cleanup, `UPDATE keeper_attempts SET status='test_reverted' WHERE deployment_id=$1 AND id>$2`, c.store.deploymentID, attemptID)
		err = errors.Join(err, markErr)
		_, markErr = c.db.ExecContext(cleanup, `UPDATE keeper_jobs SET status='test_reverted',updated_at=now() WHERE deployment_id=$1 AND id>$2`, c.store.deploymentID, jobID)
		err = errors.Join(err, markErr)
		for id, state := range states {
			_, markErr = c.db.ExecContext(cleanup, `UPDATE keeper_jobs SET status=$2 WHERE id=$1`, id, state)
			err = errors.Join(err, markErr)
		}
		err = errors.Join(err, c.rpc.CallContext(cleanup, &ignored, "evm_setAutomine", true))
		err = errors.Join(err, restorer.restoreFaultBranch(snapshot, before))
	}()
	log.Print("Running Keeper timeout, transaction recovery, replacement, and competing-caller scenarios. Test-only clocks and pending transactions will be restored.")
	for _, scenario := range []struct {
		name      string
		phase     uint8
		committed [2]bool
		revealed  [2]bool
		outcome   game.Outcome
	}{
		{"commit-one-missing", 2, [2]bool{true, false}, [2]bool{}, game.PlayerA},
		{"commit-both-missing", 2, [2]bool{}, [2]bool{}, game.Draw},
		{"reveal-one-missing", 3, [2]bool{true, true}, [2]bool{false, true}, game.PlayerB},
		{"reveal-both-missing", 3, [2]bool{true, true}, [2]bool{}, game.Draw},
		{"waiting-room-expiry", 1, [2]bool{}, [2]bool{}, game.Ongoing},
	} {
		var entry *checkedMatch
		if scenario.phase == 1 {
			entry = &checkedMatch{Name: "keeper-waiting-room"}
			c.report.FaultMatches = append(c.report.FaultMatches, entry)
			_, err = c.send(entry, 0, "createMatch", uint8(1))
		} else {
			entry, err = c.openFaultMatch("keeper-"+scenario.name, 0)
			if err == nil {
				err = c.submitHolds(entry, scenario.committed, scenario.revealed)
			}
		}
		if err != nil {
			return err
		}
		summary, _, readErr := k.summary(c.ctx, entry.ID)
		if readErr != nil {
			return readErr
		}
		deadline := summary.PhaseDeadline
		if scenario.phase == 1 {
			deadline = summary.JoinDeadline
		}
		var ignored any
		if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setNextBlockTimestamp", deadline); err != nil {
			return err
		}
		if err = c.rpc.CallContext(c.ctx, &ignored, "evm_mine"); err != nil {
			return err
		}
		if _, eligible, readErr := k.candidate(c.ctx, entry.ID); readErr != nil || eligible {
			return fmt.Errorf("Keeper must not expire at the exact deadline: eligible=%t error=%v", eligible, readErr)
		}
		if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setNextBlockTimestamp", deadline+1); err != nil {
			return err
		}
		if err = c.rpc.CallContext(c.ctx, &ignored, "evm_mine"); err != nil {
			return err
		}
		job, queueErr := c.keeperJob(k, entry)
		if queueErr != nil {
			return queueErr
		}
		if _, err = c.waitKeeper(entry, job); err != nil {
			return err
		}
		got, _, readErr := k.summary(c.ctx, entry.ID)
		wantPhase := uint8(5)
		if scenario.phase == 1 {
			wantPhase = 7
		}
		if readErr != nil || got.Phase != wantPhase || got.Outcome != uint8(scenario.outcome) {
			return fmt.Errorf("Keeper %s produced an unexpected chain result: %+v; %v", scenario.name, got, readErr)
		}
		if err = c.recordKeeper(scenario.name, job); err != nil {
			return err
		}
	}
	for _, broadcast := range []bool{false, true} {
		if err = c.checkKeeperRestart(k, broadcast); err != nil {
			return err
		}
	}
	if err = c.checkKeeperReplacement(k); err != nil {
		return err
	}
	if err = c.checkKeeperCompetitor(k); err != nil {
		return err
	}
	if err = c.checkKeeperCancellation(k); err != nil {
		return err
	}
	return c.checkKeeperBranch(k)
}

func (c *checker) checkKeeperRestart(k *keeper, broadcast bool) error {
	entry, err := c.keeperResolvable()
	if err != nil {
		return err
	}
	job, err := c.keeperJob(k, entry)
	if err != nil {
		return err
	}
	nonce, err := c.chain.PendingNonceAt(c.ctx, k.address)
	if err != nil {
		return err
	}
	attempt, err := k.sign(c.ctx, job, nonce, nil, false)
	if err != nil {
		return err
	}
	name := "restart-after-save-before-send"
	if broadcast {
		// Deliberately omit the database send update to model a lost RPC response or crash.
		if err = c.chain.SendTransaction(c.ctx, attempt.Tx); err != nil {
			return err
		}
		name = "restart-after-send-before-recording"
	}
	meta, err := c.waitAtTip(-1)
	if err != nil {
		return err
	}
	if err = c.request("restart"); err != nil {
		return err
	}
	if _, err = c.waitReady(meta.ProcessID, uint64(meta.IndexedBlock)); err != nil {
		return err
	}
	receipt, err := c.waitKeeper(entry, job)
	if err != nil {
		return err
	}
	var count int
	if err = c.db.QueryRowContext(c.ctx, `SELECT count(*) FROM keeper_attempts WHERE job_id=$1`, job.ID).Scan(&count); err != nil {
		return err
	}
	if receipt.TxHash != attempt.Tx.Hash() || count != 1 {
		return fmt.Errorf("Keeper restart changed the saved transaction or sent a second nonce")
	}
	return c.recordKeeper(name, job)
}

func (c *checker) checkKeeperReplacement(k *keeper) error {
	entry, err := c.keeperResolvable()
	if err != nil {
		return err
	}
	job, err := c.keeperJob(k, entry)
	if err != nil {
		return err
	}
	var ignored any
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setAutomine", false); err != nil {
		return err
	}
	if err = k.prepare(c.ctx, job); err != nil {
		return err
	}
	if _, err = c.db.ExecContext(c.ctx, `UPDATE keeper_attempts SET last_sent_at=now()-interval '31 seconds' WHERE job_id=$1`, job.ID); err != nil {
		return err
	}
	if _, err = k.recoverJob(c.ctx, job); err != nil {
		return err
	}
	attempts, err := k.attempts(c.ctx, job)
	if err != nil {
		return err
	}
	if len(attempts) != 2 || attempts[0].Tx.Nonce() != attempts[1].Tx.Nonce() ||
		attempts[0].Tx.GasTipCap().Cmp(attempts[1].Tx.GasTipCap()) <= 0 || attempts[0].Tx.GasFeeCap().Cmp(attempts[1].Tx.GasFeeCap()) <= 0 {
		return fmt.Errorf("Keeper replacement must retain the nonce and increase both fee caps")
	}
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setAutomine", true); err != nil {
		return err
	}
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_mine"); err != nil {
		return err
	}
	if _, err = c.waitKeeper(entry, job); err != nil {
		return err
	}
	if err = c.singleKeeperResolution(entry); err != nil {
		return err
	}
	return c.recordKeeper("same-nonce-fee-replacement", job)
}

func (c *checker) singleKeeperResolution(entry *checkedMatch) error {
	data, err := c.cfg.ABI.Pack("settleRound", newBigID(entry.ID), uint8(1))
	if err != nil {
		return err
	}
	arena := common.HexToAddress(c.cfg.Arena)
	if _, callErr := c.chain.CallContract(c.ctx, ethereum.CallMsg{From: c.accounts[0], To: &arena, Data: data}, nil); callErr == nil {
		return fmt.Errorf("a settled round still accepts a repeated settlement")
	} else if _, reverted := ethRevertData(callErr); !reverted {
		return fmt.Errorf("could not establish that repeat settlement reverted: %w", callErr)
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	var count int
	err = c.db.QueryRowContext(c.ctx, `SELECT count(*) FROM chain_events WHERE deployment_id=$1 AND match_id=$2
		AND name='RoundResolved' AND round=1`, c.store.deploymentID, entry.ID).Scan(&count)
	if err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("round one settled %d times", count)
	}
	return nil
}

func (c *checker) checkKeeperCompetitor(k *keeper) error {
	entry, err := c.keeperResolvable()
	if err != nil {
		return err
	}
	job, err := c.keeperJob(k, entry)
	if err != nil {
		return err
	}
	if _, err = c.send(entry, 0, "settleRound", newBigID(entry.ID), uint8(1)); err != nil {
		return err
	}
	if busy, recoverErr := k.recoverJob(c.ctx, job); recoverErr != nil || busy {
		return fmt.Errorf("Keeper did not skip a task completed by a player: busy=%t error=%v", busy, recoverErr)
	}
	var status string
	if err = c.db.QueryRowContext(c.ctx, `SELECT status FROM keeper_jobs WHERE id=$1`, job.ID).Scan(&status); err != nil {
		return err
	}
	if status != "superseded" {
		return fmt.Errorf("a player's completed task still has Keeper status %s", status)
	}
	if err = c.singleKeeperResolution(entry); err != nil {
		return err
	}
	return c.recordKeeper("manual-progression-and-duplicate-task", job)
}

func (c *checker) checkKeeperBranch(k *keeper) error {
	entry, err := c.keeperResolvable()
	if err != nil {
		return err
	}
	job, err := c.keeperJob(k, entry)
	if err != nil {
		return err
	}
	snapshot, err := c.snapshot()
	if err != nil {
		return err
	}
	original, err := c.waitKeeper(entry, job)
	if err != nil {
		return err
	}
	originalHeader, err := c.chain.HeaderByNumber(c.ctx, original.BlockNumber)
	if err != nil {
		return err
	}
	if err = c.revert(snapshot); err != nil {
		return err
	}
	if _, err = c.waitAtTip(-1); err != nil {
		return err
	}
	if _, err = c.db.ExecContext(c.ctx, `UPDATE keeper_attempts SET last_sent_at=now()-interval '6 seconds' WHERE job_id=$1`, job.ID); err != nil {
		return err
	}
	var ignored any
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setNextBlockTimestamp", originalHeader.Time+1); err != nil {
		return err
	}
	if _, err = k.recoverJob(c.ctx, job); err != nil {
		return err
	}
	replacement, err := c.waitKeeper(entry, job)
	if err != nil {
		return err
	}
	if replacement.BlockHash == original.BlockHash {
		return fmt.Errorf("Keeper reorg acceptance did not replace its receipt block")
	}
	if err = c.singleKeeperResolution(entry); err != nil {
		return err
	}
	return c.recordKeeper("receipt-reorg-and-resubmission", job)
}

func (c *checker) checkKeeperCancellation(k *keeper) error {
	entry, err := c.keeperResolvable()
	if err != nil {
		return err
	}
	job, err := c.keeperJob(k, entry)
	if err != nil {
		return err
	}
	nonce, err := c.chain.PendingNonceAt(c.ctx, k.address)
	if err != nil {
		return err
	}
	attempt, err := k.sign(c.ctx, job, nonce, nil, false)
	if err != nil {
		return err
	}
	if _, err = c.send(entry, 0, "settleRound", newBigID(entry.ID), uint8(1)); err != nil {
		return err
	}
	var ignored any
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setAutomine", false); err != nil {
		return err
	}
	if err = k.broadcast(c.ctx, job, attempt); err != nil {
		return err
	}
	if _, err = c.db.ExecContext(c.ctx, `UPDATE keeper_attempts SET last_sent_at=now()-interval '31 seconds' WHERE job_id=$1`, job.ID); err != nil {
		return err
	}
	if _, err = k.recoverJob(c.ctx, job); err != nil {
		return err
	}
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_setAutomine", true); err != nil {
		return err
	}
	if err = c.rpc.CallContext(c.ctx, &ignored, "evm_mine"); err != nil {
		return err
	}
	if _, err = k.recoverJob(c.ctx, job); err != nil {
		return err
	}
	var state string
	if err = c.db.QueryRowContext(c.ctx, `SELECT status FROM keeper_jobs WHERE id=$1`, job.ID).Scan(&state); err != nil {
		return err
	}
	used, err := c.chain.NonceAt(c.ctx, k.address, nil)
	if err != nil {
		return err
	}
	if state != "superseded" || used != nonce+1 {
		return fmt.Errorf("a stale pending task did not release its nonce: state=%s nonce=%d expected=%d", state, used, nonce+1)
	}
	if err = c.singleKeeperResolution(entry); err != nil {
		return err
	}
	return c.recordKeeper("competing-player-pending-nonce-cancellation", job)
}
