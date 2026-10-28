package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rpc"
)

var errFork = errors.New("canonical chain changed while indexing")
var errDeploymentChanged = errors.New("the deployment block left the canonical chain; restart the backend with the current deployment")

type cursor struct {
	Number int64
	Hash   string
}

func (s *service) cursor(ctx context.Context) (cursor, error) {
	var value cursor
	err := s.db.QueryRowContext(ctx, `SELECT block_number,block_hash FROM sync_cursors WHERE deployment_id=$1`, s.deploymentID).Scan(&value.Number, &value.Hash)
	return value, err
}

func (s *service) validateCursor(ctx context.Context) (cursor, uint64, error) {
	value, err := s.cursor(ctx)
	if err != nil {
		return value, 0, err
	}
	head, err := s.chain.HeaderByNumber(ctx, nil)
	if err != nil {
		return value, 0, err
	}
	if !head.Number.IsInt64() {
		return value, 0, fmt.Errorf("chain height exceeds database range")
	}
	if value.Number > head.Number.Int64() {
		return value, 0, errFork
	}
	if value.Number >= 0 {
		stored, readErr := s.chain.HeaderByNumber(ctx, big.NewInt(value.Number))
		if errors.Is(readErr, ethereum.NotFound) {
			return value, 0, errFork
		}
		if readErr != nil {
			return value, 0, readErr
		}
		if !strings.EqualFold(stored.Hash().Hex(), value.Hash) {
			return value, 0, errFork
		}
	}
	return value, head.Number.Uint64(), nil
}

func (s *service) sync(ctx context.Context, rescan bool, until *uint64) (uint64, error) {
	head, err := s.syncBranch(ctx, rescan, until)
	if !errors.Is(err, errFork) {
		return head, err
	}
	s.mu.Lock()
	s.observed.Error = "Recovering the canonical branch."
	s.observed.Blocked = true
	s.mu.Unlock()
	if err = s.recoverBranch(ctx); err != nil {
		return head, err
	}
	return s.syncBranch(ctx, rescan, until)
}

func (s *service) syncBranch(ctx context.Context, rescan bool, until *uint64) (uint64, error) {
	value, head, err := s.validateCursor(ctx)
	if err != nil {
		return head, err
	}
	if until != nil {
		head = min(head, *until)
	}
	from, parent := uint64(value.Number+1), value.Hash
	if rescan {
		from, parent = s.cfg.From, s.anchor.ParentHash.Hex()
	}
	for from <= head {
		to := min(from+127, head)
		headers := make([]*types.Header, to-from+1)
		batch := make([]rpc.BatchElem, len(headers))
		for i := range batch {
			batch[i] = rpc.BatchElem{Method: "eth_getBlockByNumber", Args: []any{hexutil.EncodeUint64(from + uint64(i)), false}, Result: &headers[i]}
		}
		if err = s.rpc.BatchCallContext(ctx, batch); err != nil {
			return head, fmt.Errorf("read block range: %w", err)
		}
		for i, item := range batch {
			if item.Error != nil {
				return head, item.Error
			}
			if headers[i] == nil || headers[i].Number == nil || headers[i].Number.Uint64() != from+uint64(i) {
				return head, fmt.Errorf("RPC returned an incomplete block range")
			}
			expectedParent := parent
			if i > 0 {
				expectedParent = headers[i-1].Hash().Hex()
			}
			if !strings.EqualFold(headers[i].ParentHash.Hex(), expectedParent) {
				return head, errFork
			}
			if headers[i].Number.Uint64() == s.cfg.From && headers[i].Hash() != s.anchor.Hash() {
				return head, errFork
			}
		}
		logs, readErr := s.chain.FilterLogs(ctx, ethereum.FilterQuery{
			FromBlock: new(big.Int).SetUint64(from), ToBlock: new(big.Int).SetUint64(to),
			Addresses: []common.Address{common.HexToAddress(s.cfg.Arena)},
		})
		if readErr != nil {
			return head, fmt.Errorf("read event range: %w", readErr)
		}
		sort.Slice(logs, func(i, j int) bool {
			if logs[i].BlockNumber != logs[j].BlockNumber {
				return logs[i].BlockNumber < logs[j].BlockNumber
			}
			return logs[i].Index < logs[j].Index
		})
		for _, entry := range logs {
			if entry.BlockNumber < from || entry.BlockNumber > to || entry.Removed ||
				entry.Address != common.HexToAddress(s.cfg.Arena) || entry.BlockHash != headers[entry.BlockNumber-from].Hash() {
				return head, fmt.Errorf("RPC logs do not match the requested canonical headers")
			}
		}
		// A range query can straddle a reorg; pin its final header again before committing.
		end, readErr := s.chain.HeaderByNumber(ctx, new(big.Int).SetUint64(to))
		if readErr != nil {
			return head, readErr
		}
		if end.Hash() != headers[len(headers)-1].Hash() {
			return head, errFork
		}
		if err = s.saveRange(ctx, headers, logs); err != nil {
			return head, err
		}
		parent, from = end.Hash().Hex(), to+1
	}
	return head, nil
}

func (s *service) saveRange(ctx context.Context, headers []*types.Header, logs []types.Log) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	indexed := 0
	var finished []string
	for _, header := range headers {
		var existing string
		err = tx.QueryRowContext(ctx, `SELECT hash FROM chain_blocks WHERE deployment_id=$1 AND number=$2`, s.deploymentID, header.Number.Int64()).Scan(&existing)
		if err == nil {
			if !strings.EqualFold(existing, header.Hash().Hex()) {
				return errFork
			}
		} else if errors.Is(err, sql.ErrNoRows) {
			_, err = tx.ExecContext(ctx, `INSERT INTO chain_blocks(deployment_id,number,hash,parent_hash,timestamp) VALUES($1,$2,$3,$4,$5)`,
				s.deploymentID, header.Number.Int64(), header.Hash().Hex(), header.ParentHash.Hex(), header.Time)
			if err != nil {
				return err
			}
		} else {
			return err
		}
	}
	for _, entry := range logs {
		name, event, payload, decodeErr := decodeEvent(s.cfg.ABI, entry)
		if decodeErr != nil {
			return fmt.Errorf("decode block %d log %d: %w", entry.BlockNumber, entry.Index, decodeErr)
		}
		raw, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			return marshalErr
		}
		var id int64
		err = tx.QueryRowContext(ctx, `INSERT INTO chain_events(deployment_id,block_number,block_hash,tx_hash,tx_index,log_index,name,match_id,round,raw_log,payload)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
			s.deploymentID, entry.BlockNumber, entry.BlockHash.Hex(), entry.TxHash.Hex(), entry.TxIndex, entry.Index,
			name, event.MatchID, event.Round, string(raw), string(payload)).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if err = s.project(ctx, tx, entry, id, name, event); err != nil {
			return fmt.Errorf("project %s match %s at block %d log %d: %w", name, event.MatchID, entry.BlockNumber, entry.Index, err)
		}
		indexed++
		if name == "MatchFinished" {
			finished = append(finished, fmt.Sprintf("Indexed finished match %s: outcome=%d reason=%d stateHash=%s.", event.MatchID, event.Outcome, event.Reason, event.StateHash.Hex()))
		}
	}
	last := headers[len(headers)-1]
	_, err = tx.ExecContext(ctx, `UPDATE sync_cursors SET block_number=$2,block_hash=$3 WHERE deployment_id=$1 AND block_number<$2`,
		s.deploymentID, last.Number.Int64(), last.Hash().Hex())
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if indexed > 0 {
		log.Printf("Indexed blocks %d-%d: %d new Arena events; cursor %d.", headers[0].Number.Uint64(), last.Number.Uint64(), indexed, last.Number.Uint64())
		for _, message := range finished {
			log.Print(message)
		}
	}
	return nil
}
