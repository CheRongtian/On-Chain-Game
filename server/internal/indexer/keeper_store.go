package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/core/types"
)

type keeperAttempt struct {
	ID       int64
	Tx       *types.Transaction
	Status   string
	LastSent sql.NullTime
}

func (k *keeper) saveJob(ctx context.Context, job *keeperJob) error {
	return k.s.db.QueryRowContext(ctx, `INSERT INTO keeper_jobs(deployment_id,match_id,round,phase,operation)
		VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id,match_id,round,phase,operation)
		DO UPDATE SET status='queued',updated_at=now() RETURNING id`,
		k.s.deploymentID, job.MatchID, job.Round, job.Phase, job.Operation).Scan(&job.ID)
}

func (k *keeper) jobState(ctx context.Context, job keeperJob, state string) error {
	_, err := k.s.db.ExecContext(ctx, `UPDATE keeper_jobs SET status=$2,updated_at=now() WHERE id=$1`, job.ID, state)
	return err
}

func (k *keeper) recoverJobs(ctx context.Context) ([]keeperJob, error) {
	rows, err := k.s.db.QueryContext(ctx, `SELECT j.id,j.match_id::text,j.round,j.phase,j.operation
		FROM keeper_jobs j WHERE j.deployment_id=$1 AND (j.status IN ('queued','pending') OR EXISTS (
		SELECT 1 FROM keeper_attempts a LEFT JOIN chain_blocks b ON b.deployment_id=a.deployment_id AND b.number=a.receipt_block
		WHERE a.job_id=j.id AND a.status='confirmed' AND b.hash IS DISTINCT FROM a.receipt_hash))
		ORDER BY COALESCE((SELECT min(a.nonce) FROM keeper_attempts a WHERE a.job_id=j.id
		AND a.status IN ('prepared','sent','replaced','confirmed','orphaned')),9223372036854775807),j.id`, k.s.deploymentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var jobs []keeperJob
	for rows.Next() {
		var job keeperJob
		if err = rows.Scan(&job.ID, &job.MatchID, &job.Round, &job.Phase, &job.Operation); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (k *keeper) attempts(ctx context.Context, job keeperJob) ([]keeperAttempt, error) {
	rows, err := k.s.db.QueryContext(ctx, `SELECT id,raw_tx,status,last_sent_at,signer FROM keeper_attempts
		WHERE job_id=$1 AND status IN ('prepared','sent','replaced','confirmed','orphaned') ORDER BY id DESC`, job.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var attempts []keeperAttempt
	for rows.Next() {
		var attempt keeperAttempt
		var raw []byte
		var signer string
		if err = rows.Scan(&attempt.ID, &raw, &attempt.Status, &attempt.LastSent, &signer); err != nil {
			return nil, err
		}
		if !strings.EqualFold(signer, k.address.Hex()) {
			return nil, fmt.Errorf("pending Keeper transaction belongs to %s; restore its KEEPER_PRIVATE_KEY before resuming", signer)
		}
		attempt.Tx = new(types.Transaction)
		if err = attempt.Tx.UnmarshalBinary(raw); err != nil {
			return nil, fmt.Errorf("decode saved Keeper transaction %d: %w", attempt.ID, err)
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

func (k *keeper) savePrepared(ctx context.Context, job keeperJob, signed *types.Transaction) (keeperAttempt, error) {
	attempt := keeperAttempt{Tx: signed, Status: "prepared"}
	raw, err := signed.MarshalBinary()
	if err != nil {
		return attempt, err
	}
	tx, err := k.s.db.BeginTx(ctx, nil)
	if err != nil {
		return attempt, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `UPDATE keeper_attempts SET status='replaced'
		WHERE job_id=$1 AND status IN ('prepared','sent','orphaned')`, job.ID)
	if err != nil {
		return attempt, err
	}
	err = tx.QueryRowContext(ctx, `INSERT INTO keeper_attempts(deployment_id,match_id,round,operation,job_id,signer,nonce,
		tx_hash,raw_tx,tip_cap,fee_cap,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared') RETURNING id`,
		k.s.deploymentID, job.MatchID, job.Round, job.Operation, job.ID, strings.ToLower(k.address.Hex()), signed.Nonce(),
		signed.Hash().Hex(), raw, signed.GasTipCap().String(), signed.GasFeeCap().String()).Scan(&attempt.ID)
	if err != nil {
		return attempt, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keeper_jobs SET status='pending',updated_at=now() WHERE id=$1`, job.ID); err != nil {
		return attempt, err
	}
	return attempt, tx.Commit()
}

func (k *keeper) saveReceipt(ctx context.Context, job keeperJob, attempt keeperAttempt, receipt *types.Receipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	state, task := "confirmed", "confirmed"
	if receipt.Status != types.ReceiptStatusSuccessful {
		state, task = "reverted", "failed"
	} else if attempt.Tx.To() != nil && *attempt.Tx.To() == k.address {
		state, task = "cancelled", "superseded"
	}
	tx, err := k.s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `UPDATE keeper_attempts SET status=$2,receipt=$3,receipt_block=$4,receipt_hash=$5,error=NULL
		WHERE id=$1`, attempt.ID, state, string(data), receipt.BlockNumber.Int64(), receipt.BlockHash.Hex())
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keeper_attempts SET status='superseded' WHERE job_id=$1 AND id<>$2
		AND status IN ('prepared','sent','replaced','orphaned')`, job.ID, attempt.ID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keeper_jobs SET status=$2,updated_at=now() WHERE id=$1`, job.ID, task); err != nil {
		return err
	}
	return tx.Commit()
}
