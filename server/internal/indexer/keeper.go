package indexer

import (
	"context"
	"crypto/ecdsa"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

type keeperStatus struct {
	Enabled bool   `json:"enabled"`
	Address string `json:"address,omitempty"`
	Error   string `json:"error,omitempty"`
}

type keeper struct {
	s       *service
	key     *ecdsa.PrivateKey
	address common.Address
}

type keeperJob struct {
	ID        int64
	MatchID   string
	Round     uint8
	Phase     uint8
	Operation string
}

func newKeeper(ctx context.Context, s *service) (*keeper, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(s.cfg.KeeperKey, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid KEEPER_PRIVATE_KEY; use a dedicated execution account")
	}
	k := &keeper{s: s, key: key, address: crypto.PubkeyToAddress(key.PublicKey)}
	var players []common.Address
	if err = s.rpc.CallContext(ctx, &players, "eth_accounts"); err != nil {
		return nil, err
	}
	for _, player := range players[:min(2, len(players))] {
		if player == k.address {
			return nil, fmt.Errorf("Keeper must use an account separate from both local players")
		}
	}
	balance, err := s.chain.BalanceAt(ctx, k.address, nil)
	if err != nil {
		return nil, err
	}
	if balance.Sign() == 0 {
		// readConfig accepts only this project's local Anvil endpoint and chain ID.
		var result any
		funds := new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1_000_000_000_000_000_000))
		if err = s.rpc.CallContext(ctx, &result, "anvil_setBalance", k.address, hexutil.EncodeBig(funds)); err != nil {
			return nil, fmt.Errorf("fund local Keeper account: %w", err)
		}
	}
	return k, nil
}

func (s *service) runKeeper(ctx context.Context) {
	if !s.cfg.KeeperEnabled {
		return
	}
	var err error
	if s.keeper == nil {
		s.keeper, err = newKeeper(ctx, s)
		if err == nil {
			log.Printf("Keeper ready. Dedicated execution account: %s. Public settlement, timeout, and room expiry enabled.", s.keeper.address.Hex())
		}
	}
	if err == nil {
		err = s.keeper.tick(ctx)
	}
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	s.mu.Lock()
	previous := s.keeperState.Error
	s.keeperState = keeperStatus{Enabled: true}
	if s.keeper != nil {
		s.keeperState.Address = s.keeper.address.Hex()
	}
	if err != nil {
		s.keeperState.Error = err.Error()
	}
	s.mu.Unlock()
	if err != nil && err.Error() != previous {
		log.Printf("Keeper paused: %v. Player transactions remain available.", err)
	} else if err == nil && previous != "" {
		log.Print("Keeper recovered; pending transactions and current chain conditions were rechecked.")
	}
}

func keeperGate(ctx context.Context, db *sql.DB, deployment int64, wait bool) (*sql.Conn, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var acquired bool
	if wait {
		_, err = conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, -deployment)
		acquired = err == nil
	} else {
		err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, -deployment).Scan(&acquired)
	}
	if err != nil || !acquired {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func releaseKeeperGate(conn *sql.Conn, deployment int64) {
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, -deployment)
	_ = conn.Close()
}

func (k *keeper) tick(ctx context.Context) error {
	gate, err := keeperGate(ctx, k.s.db, k.s.deploymentID, false)
	if err != nil || gate == nil {
		return err
	}
	defer releaseKeeperGate(gate, k.s.deploymentID)
	cursor, head, err := k.s.validateCursor(ctx)
	if err != nil {
		return err
	}
	if cursor.Number != int64(head) {
		return nil
	}
	busy, err := k.recover(ctx)
	if err != nil || busy {
		return err
	}
	header, err := k.s.chain.HeaderByNumber(ctx, nil)
	if err != nil {
		return err
	}
	cutoff := max(header.Time, uint64(time.Now().Unix()))
	rows, err := k.s.db.QueryContext(ctx, `SELECT match_id::text FROM matches WHERE deployment_id=$1 AND
		(phase=4 OR (phase=1 AND (data->>'joinDeadline')::bigint<$2)
		OR (phase IN (2,3) AND (data->>'phaseDeadline')::bigint<$2)) ORDER BY match_id`, k.s.deploymentID, cutoff)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		job, eligible, readErr := k.candidate(ctx, id)
		if readErr != nil {
			return readErr
		}
		if !eligible {
			continue
		}
		if err = k.saveJob(ctx, &job); err != nil {
			return err
		}
		// One in-flight nonce at a time keeps recovery and competing callers simple.
		return k.prepare(ctx, job)
	}
	return nil
}

func (k *keeper) summary(ctx context.Context, id string) (chainMatch, bool, error) {
	var summary chainMatch
	data, err := k.s.cfg.ABI.Pack("getMatch", newBigID(id))
	if err != nil {
		return summary, false, err
	}
	arena := common.HexToAddress(k.s.cfg.Arena)
	result, err := k.s.chain.CallContract(ctx, ethereum.CallMsg{To: &arena, Data: data}, nil)
	if err != nil {
		if reason, ok := ethRevertData(err); ok && len(reason) >= 4 &&
			string(reason[:4]) == string(k.s.cfg.ABI.Errors["UnknownMatch"].ID.Bytes()[:4]) {
			return summary, false, nil
		}
		return summary, false, err
	}
	values, err := k.s.cfg.ABI.Methods["getMatch"].Outputs.Unpack(result)
	if err != nil || len(values) != 1 {
		return summary, false, fmt.Errorf("decode Keeper match summary: %v", err)
	}
	summary = *abi.ConvertType(values[0], new(chainMatch)).(*chainMatch)
	return summary, true, nil
}

func ethRevertData(err error) ([]byte, bool) {
	var failure interface{ ErrorData() interface{} }
	if errors.As(err, &failure) {
		if value, ok := failure.ErrorData().(string); ok {
			data, decodeErr := hexutil.Decode(value)
			return data, decodeErr == nil
		}
	}
	return nil, false
}

func (k *keeper) candidate(ctx context.Context, id string) (keeperJob, bool, error) {
	summary, exists, err := k.summary(ctx, id)
	job := keeperJob{MatchID: id, Round: summary.Round, Phase: summary.Phase}
	if err != nil || !exists {
		return job, false, err
	}
	var deadline uint64
	switch summary.Phase {
	case 1:
		job.Operation, deadline = "expireWaitingMatch", summary.JoinDeadline
	case 2, 3:
		job.Operation, deadline = "advanceExpiredPhase", summary.PhaseDeadline
	case 4:
		job.Operation = "settleRound"
		return job, true, nil
	default:
		return job, false, nil
	}
	header, err := k.s.chain.HeaderByNumber(ctx, nil)
	if err != nil {
		return job, false, err
	}
	if header.Time <= deadline && uint64(time.Now().Unix()) > deadline {
		// Idle Anvil has no interval mining. Advance only an actually expired task to wall time.
		var result any
		if err = k.s.rpc.CallContext(ctx, &result, "evm_setNextBlockTimestamp", uint64(time.Now().Unix())); err != nil {
			return job, false, err
		}
		if err = k.s.rpc.CallContext(ctx, &result, "evm_mine"); err != nil {
			return job, false, err
		}
		summary, exists, err = k.summary(ctx, id)
		if err != nil || !exists || summary.Phase != job.Phase || summary.Round != job.Round {
			return job, false, err
		}
		header, err = k.s.chain.HeaderByNumber(ctx, nil)
		if err != nil {
			return job, false, err
		}
	}
	return job, header.Time > deadline, nil
}

func (k *keeper) callData(job keeperJob) ([]byte, error) {
	args := []any{newBigID(job.MatchID)}
	if job.Operation != "expireWaitingMatch" {
		args = append(args, job.Round)
	}
	if job.Operation == "advanceExpiredPhase" {
		args = append(args, job.Phase)
	}
	return k.s.cfg.ABI.Pack(job.Operation, args...)
}

func (k *keeper) eligible(ctx context.Context, job keeperJob) (bool, error) {
	current, eligible, err := k.candidate(ctx, job.MatchID)
	return eligible && current.Round == job.Round && current.Phase == job.Phase && current.Operation == job.Operation, err
}

func canonicalReceipt(ctx context.Context, s *service, hash common.Hash) (*types.Receipt, error) {
	receipt, err := s.chain.TransactionReceipt(ctx, hash)
	if errors.Is(err, ethereum.NotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	header, err := s.chain.HeaderByNumber(ctx, receipt.BlockNumber)
	if errors.Is(err, ethereum.NotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if header.Hash() != receipt.BlockHash {
		return nil, nil
	}
	return receipt, nil
}
