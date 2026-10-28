package indexer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

func (k *keeper) fees(ctx context.Context, previous *types.Transaction) (*big.Int, *big.Int, error) {
	tip, err := k.s.chain.SuggestGasTipCap(ctx)
	if err != nil {
		return nil, nil, err
	}
	header, err := k.s.chain.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	fee := new(big.Int).Add(new(big.Int).Mul(header.BaseFee, big.NewInt(2)), tip)
	if previous != nil {
		bump := func(old *big.Int) *big.Int {
			return new(big.Int).Add(new(big.Int).Div(new(big.Int).Mul(old, big.NewInt(125)), big.NewInt(100)), big.NewInt(1))
		}
		if floor := bump(previous.GasTipCap()); tip.Cmp(floor) < 0 {
			tip = floor
		}
		fee = new(big.Int).Add(new(big.Int).Mul(header.BaseFee, big.NewInt(2)), tip)
		if floor := bump(previous.GasFeeCap()); fee.Cmp(floor) < 0 {
			fee = floor
		}
	}
	return tip, fee, nil
}

func (k *keeper) sign(ctx context.Context, job keeperJob, nonce uint64, previous *types.Transaction, cancel bool) (keeperAttempt, error) {
	to, gas := common.HexToAddress(k.s.cfg.Arena), uint64(21_000)
	var data []byte
	var err error
	if cancel {
		to = k.address
	} else {
		data, err = k.callData(job)
		if err != nil {
			return keeperAttempt{}, err
		}
		gas, err = k.s.chain.EstimateGasAtBlock(ctx, ethereum.CallMsg{From: k.address, To: &to, Data: data}, nil)
		if err != nil {
			return keeperAttempt{}, err
		}
		gas += gas / 5
	}
	tip, fee, err := k.fees(ctx, previous)
	if err != nil {
		return keeperAttempt{}, err
	}
	chainID := new(big.Int).SetUint64(k.s.cfg.ChainID)
	signed, err := types.SignTx(types.NewTx(&types.DynamicFeeTx{ChainID: chainID, Nonce: nonce,
		GasTipCap: tip, GasFeeCap: fee, Gas: gas, To: &to, Value: new(big.Int), Data: data}), types.LatestSignerForChainID(chainID), k.key)
	if err != nil {
		return keeperAttempt{}, err
	}
	return k.savePrepared(ctx, job, signed)
}

func (k *keeper) prepare(ctx context.Context, job keeperJob) error {
	eligible, err := k.eligible(ctx, job)
	if err != nil {
		return err
	}
	if !eligible {
		return k.jobState(ctx, job, "superseded")
	}
	nonce, err := k.s.chain.PendingNonceAt(ctx, k.address)
	if err != nil {
		return err
	}
	attempt, err := k.sign(ctx, job, nonce, nil, false)
	if err != nil {
		// Another public caller can advance the phase between reading and gas estimation.
		if eligible, checkErr := k.eligible(ctx, job); checkErr == nil && !eligible {
			return k.jobState(ctx, job, "superseded")
		}
		return err
	}
	return k.broadcast(ctx, job, attempt)
}

func (k *keeper) broadcast(ctx context.Context, job keeperJob, attempt keeperAttempt) error {
	sendErr := k.s.chain.SendTransaction(ctx, attempt.Tx)
	state, message := "sent", ""
	if sendErr != nil {
		message = sendErr.Error()
		if strings.Contains(strings.ToLower(message), "already known") {
			sendErr, message = nil, ""
		} else {
			state = "prepared"
		}
	}
	_, err := k.s.db.ExecContext(ctx, `UPDATE keeper_attempts SET status=$2,error=NULLIF($3,''),last_sent_at=now() WHERE id=$1`, attempt.ID, state, message)
	if err != nil {
		return err
	}
	if sendErr != nil {
		return fmt.Errorf("broadcast Keeper %s match %s nonce %d: %w", job.Operation, job.MatchID, attempt.Tx.Nonce(), sendErr)
	}
	log.Printf("Keeper sent %s: match=%s round=%d nonce=%d tx=%s.", job.Operation, job.MatchID, job.Round, attempt.Tx.Nonce(), attempt.Tx.Hash().Hex())
	return nil
}

func (k *keeper) recover(ctx context.Context) (bool, error) {
	jobs, err := k.recoverJobs(ctx)
	if err != nil {
		return false, err
	}
	for _, job := range jobs {
		busy, recoverErr := k.recoverJob(ctx, job)
		if recoverErr != nil || busy {
			return busy, recoverErr
		}
	}
	return false, nil
}

func (k *keeper) recoverJob(ctx context.Context, job keeperJob) (bool, error) {
	attempts, err := k.attempts(ctx, job)
	if err != nil {
		return true, err
	}
	for _, attempt := range attempts {
		receipt, receiptErr := canonicalReceipt(ctx, k.s, attempt.Tx.Hash())
		if receiptErr != nil {
			return true, receiptErr
		}
		if receipt != nil {
			if err = k.saveReceipt(ctx, job, attempt, receipt); err != nil {
				return true, err
			}
			log.Printf("Keeper receipt: match=%s round=%d tx=%s block=%s success=%t.",
				job.MatchID, job.Round, attempt.Tx.Hash().Hex(), receipt.BlockNumber, receipt.Status == types.ReceiptStatusSuccessful)
			return false, nil
		}
	}
	eligible, err := k.eligible(ctx, job)
	if err != nil {
		return true, err
	}
	if len(attempts) == 0 {
		if !eligible {
			return false, k.jobState(ctx, job, "superseded")
		}
		return true, k.prepare(ctx, job)
	}
	latest := attempts[0]
	if latest.Status == "confirmed" {
		if _, err = k.s.db.ExecContext(ctx, `UPDATE keeper_attempts SET status='orphaned' WHERE id=$1`, latest.ID); err != nil {
			return true, err
		}
		if err = k.jobState(ctx, job, "pending"); err != nil {
			return true, err
		}
		log.Printf("Keeper receipt left the canonical branch: tx=%s. Rechecking task and nonce.", latest.Tx.Hash().Hex())
	}
	nonce, err := k.s.chain.NonceAt(ctx, k.address, nil)
	if err != nil {
		return true, err
	}
	if nonce > latest.Tx.Nonce() {
		if _, err = k.s.db.ExecContext(ctx, `UPDATE keeper_attempts SET status='superseded' WHERE job_id=$1
			AND status IN ('prepared','sent','replaced','orphaned')`, job.ID); err != nil {
			return true, err
		}
		log.Printf("Keeper nonce %d was consumed elsewhere; task %d will be rechecked before any new submission.", latest.Tx.Nonce(), job.ID)
		return false, k.jobState(ctx, job, "superseded")
	}
	_, pending, lookupErr := k.s.chain.TransactionByHash(ctx, latest.Tx.Hash())
	if lookupErr != nil && !errors.Is(lookupErr, ethereum.NotFound) {
		return true, lookupErr
	}
	if lookupErr == nil && !pending {
		if latest.Status == "confirmed" || latest.Status == "orphaned" {
			lookupErr = ethereum.NotFound
		} else {
			// The receipt may become available one RPC request after the transaction.
			return true, nil
		}
	}
	if eligible && errors.Is(lookupErr, ethereum.NotFound) {
		pendingNonce, readErr := k.s.chain.PendingNonceAt(ctx, k.address)
		if readErr != nil {
			return true, readErr
		}
		if pendingNonce < latest.Tx.Nonce() {
			// A branch rollback can remove several nonces, including tasks now completed by others.
			replacement, signErr := k.sign(ctx, job, pendingNonce, latest.Tx, false)
			if signErr != nil {
				return true, signErr
			}
			log.Printf("Keeper reassigned an orphaned nonce: %d -> %d for job %d.", latest.Tx.Nonce(), pendingNonce, job.ID)
			return true, k.broadcast(ctx, job, replacement)
		}
	}
	if !eligible && errors.Is(lookupErr, ethereum.NotFound) {
		pendingNonce, readErr := k.s.chain.PendingNonceAt(ctx, k.address)
		if readErr != nil {
			return true, readErr
		}
		if pendingNonce <= latest.Tx.Nonce() {
			if _, err = k.s.db.ExecContext(ctx, `UPDATE keeper_attempts SET status='superseded' WHERE job_id=$1
				AND status IN ('prepared','sent','replaced','orphaned')`, job.ID); err != nil {
				return true, err
			}
			return false, k.jobState(ctx, job, "superseded")
		}
	}
	if latest.LastSent.Valid && time.Since(latest.LastSent.Time) >= 30*time.Second {
		replacement, signErr := k.sign(ctx, job, latest.Tx.Nonce(), latest.Tx, !eligible)
		if signErr != nil {
			if nowEligible, checkErr := k.eligible(ctx, job); checkErr == nil && !nowEligible {
				return true, nil
			}
			return true, signErr
		}
		log.Printf("Keeper replacing nonce %d: previous=%s replacement=%s cancellation=%t.",
			latest.Tx.Nonce(), latest.Tx.Hash().Hex(), replacement.Tx.Hash().Hex(), !eligible)
		return true, k.broadcast(ctx, job, replacement)
	}
	if errors.Is(lookupErr, ethereum.NotFound) && (!latest.LastSent.Valid || time.Since(latest.LastSent.Time) >= 5*time.Second) {
		return true, k.broadcast(ctx, job, latest)
	}
	return true, nil
}
