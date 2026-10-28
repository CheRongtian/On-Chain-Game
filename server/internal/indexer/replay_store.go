package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

func (s *service) replay(ctx context.Context, tx *sql.Tx, id string, meta metadata) (replayResult, error) {
	value := cursor{meta.IndexedBlock, meta.IndexedHash}
	e := newReplay(s.cfg, id, value)
	var stored json.RawMessage
	if err := tx.QueryRowContext(ctx, `SELECT data FROM matches WHERE deployment_id=$1 AND match_id=$2`, s.deploymentID, id).Scan(&stored); err != nil {
		return e.result, err
	}
	if meta.Error != "" || meta.Blocked {
		e.result.Verification.Message = "Indexer recovery or an RPC error prevents current verification."
		return e.result, nil
	}
	if err := s.canonicalCursor(ctx, value); err != nil {
		e.result.Verification.Message = "Canonical chain evidence is unavailable: " + err.Error()
		return e.result, nil
	}
	logs, err := s.replayLogs(ctx, id, uint64(value.Number))
	if err != nil {
		e.result.Verification.Message = "Canonical public history is unavailable: " + err.Error()
		return e.result, nil
	}
	if len(logs) == 0 {
		e.result.Verification.Message = "No canonical creation event exists through the indexed cursor."
		return e.result, nil
	}
	complete, err := s.compareReplayEvents(ctx, tx, e, logs)
	if err != nil {
		return e.result, err
	}
	for i, entry := range logs {
		if !complete || e.result.Verification.Difference != nil {
			break
		}
		name, event, _, decodeErr := decodeEvent(s.cfg.ABI, entry)
		if decodeErr != nil {
			e.mismatch(0, "chain.event", "decodable Arena event", decodeErr.Error())
			break
		}
		if i == 0 && name != "MatchCreated" {
			e.result.Verification.Message = "Canonical history lacks the initial creation event."
			return e.result, nil
		}
		if err = e.apply(name, event, entry); err != nil {
			e.mismatch(event.Round, "replay", "an event sequence accepted by the independent Go rules", err.Error())
		}
		if e.result.Verification.Difference != nil {
			break
		}
	}
	for round := uint8(1); round <= 20; round++ {
		if input := e.inputs[round]; input != nil {
			e.result.Rounds = append(e.result.Rounds, *input)
		}
	}
	if complete && e.result.Verification.Difference == nil {
		if err = s.compareReplayProjections(ctx, tx, e, stored); err != nil {
			return e.result, err
		}
	}
	// Pin the cursor again after RPC reads and database comparisons. A concurrent reorg
	// invalidates this response even when the earlier branch happened to be consistent.
	if err = s.canonicalCursor(ctx, value); err != nil {
		e.result.Verification.Status, e.result.Verification.PrefixVerified = "Incomplete", false
		e.result.Verification.VerifiedRounds = 0
		e.result.Verification.Message = "The source branch changed or became unavailable during verification: " + err.Error()
		e.result.Verification.Difference = nil
		return e.result, nil
	}
	e.result.Verification.Canonical = true
	if complete && e.result.Verification.Difference == nil {
		e.result.Verification.PrefixVerified = true
		if e.result.Verification.Complete {
			e.result.Verification.Status = "Verified"
			e.result.Verification.Message = "Independent replay, indexed records, and canonical chain hashes agree through the finished match."
		} else if e.match.Battle == nil {
			e.result.Verification.Message = "Public room history agrees; this room has no started battle to replay."
		} else {
			e.result.Verification.Message = "Completed rounds agree through the indexed cursor; the match is still in progress."
		}
	}
	return e.result, nil
}

func (s *service) replayLogs(ctx context.Context, id string, through uint64) ([]types.Log, error) {
	number, _ := new(big.Int).SetString(id, 10)
	var logs []types.Log
	for from := s.cfg.From; from <= through; {
		to := min(from+127, through)
		batch, err := s.chain.FilterLogs(ctx, ethereum.FilterQuery{
			FromBlock: new(big.Int).SetUint64(from), ToBlock: new(big.Int).SetUint64(to),
			Addresses: []common.Address{common.HexToAddress(s.cfg.Arena)},
			Topics:    [][]common.Hash{nil, {common.BigToHash(number)}},
		})
		if err != nil {
			return nil, err
		}
		logs = append(logs, batch...)
		from = to + 1
	}
	sort.Slice(logs, func(i, j int) bool {
		if logs[i].BlockNumber != logs[j].BlockNumber {
			return logs[i].BlockNumber < logs[j].BlockNumber
		}
		return logs[i].Index < logs[j].Index
	})
	var previousBlock uint64
	var previousHash common.Hash
	for i, entry := range logs {
		if i == 0 || entry.BlockNumber != previousBlock {
			header, err := s.chain.HeaderByNumber(ctx, new(big.Int).SetUint64(entry.BlockNumber))
			if err != nil {
				return nil, err
			}
			previousBlock, previousHash = entry.BlockNumber, header.Hash()
		}
		if entry.Removed || entry.Address != common.HexToAddress(s.cfg.Arena) || entry.BlockHash != previousHash ||
			entry.BlockNumber < s.cfg.From || entry.BlockNumber > through || len(entry.Topics) < 2 || entry.Topics[1] != common.BigToHash(number) {
			return nil, fmt.Errorf("public logs do not belong to the requested canonical match")
		}
	}
	return logs, nil
}

func (s *service) compareReplayEvents(ctx context.Context, tx *sql.Tx, e *replayEngine, logs []types.Log) (bool, error) {
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM chain_events WHERE deployment_id=$1 AND match_id=$2`, s.deploymentID, e.result.MatchID).Scan(&count); err != nil {
		return false, err
	}
	if count < len(logs) {
		e.result.Verification.Message = "Indexed public history is incomplete."
		return false, nil
	}
	if count > len(logs) {
		e.mismatch(0, "events.count", len(logs), count)
		return false, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT name,round,block_number,block_hash,tx_hash,tx_index,log_index,raw_log,payload
		FROM chain_events WHERE deployment_id=$1 AND match_id=$2 ORDER BY block_number,log_index`, s.deploymentID, e.result.MatchID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var name string
		var round uint8
		var from source
		var txIndex uint
		var raw, payload json.RawMessage
		if err = rows.Scan(&name, &round, &from.Block, &from.BlockHash, &from.TxHash, &txIndex, &from.LogIndex, &raw, &payload); err != nil {
			return false, err
		}
		if i >= len(logs) {
			e.mismatch(round, "events.count", len(logs), i+1)
			return false, nil
		}
		wantName, event, wantPayload, decodeErr := decodeEvent(s.cfg.ABI, logs[i])
		if decodeErr != nil {
			return false, decodeErr
		}
		var got types.Log
		if err = json.Unmarshal(raw, &got); err != nil {
			e.mismatch(round, fmt.Sprintf("events[%d].raw", i), "a canonical log", string(raw))
			return false, nil
		}
		prefix := fmt.Sprintf("events[%d]", i)
		if !e.compare(event.Round, prefix+".name", wantName, name) || !e.compare(event.Round, prefix+".round", event.Round, round) ||
			!e.compare(event.Round, prefix+".source", eventSource(logs[i]), from) || !e.compare(event.Round, prefix+".transactionIndex", logs[i].TxIndex, txIndex) ||
			!e.compare(event.Round, prefix+".payload", json.RawMessage(wantPayload), payload) {
			return false, nil
		}
		if !sameLog(logs[i], got) {
			e.mismatch(round, prefix+".raw", logs[i], got)
			return false, nil
		}
		i++
	}
	if err = rows.Err(); err != nil {
		return false, err
	}
	if i != len(logs) {
		e.result.Verification.Message = "Indexed public history is incomplete."
	}
	return i == len(logs), nil
}

func (s *service) compareReplayProjections(ctx context.Context, tx *sql.Tx, e *replayEngine, stored json.RawMessage) error {
	type snapshot struct {
		Round     uint8       `json:"round"`
		State     any         `json:"state"`
		StateHash common.Hash `json:"stateHash"`
		Source    source      `json:"source"`
	}
	snapshots := make([]snapshot, 0, len(e.result.Frames))
	for _, frame := range e.result.Frames {
		snapshots = append(snapshots, snapshot{frame.State.Round, frame.State, frame.StateHash, frame.Source})
	}
	rounds := []replayedRound{}
	for number := uint8(1); number <= 20; number++ {
		if round := e.rounds[number]; round != nil {
			rounds = append(rounds, *round)
		}
	}
	actions := append([]replayedAction{}, e.actions...)
	sort.Slice(actions, func(i, j int) bool {
		if actions[i].Round != actions[j].Round {
			return actions[i].Round < actions[j].Round
		}
		return actions[i].Player < actions[j].Player
	})
	queries := []struct {
		name string
		sql  string
		want any
	}{
		{"snapshots", `SELECT jsonb_build_object('round',b.round,'state',b.state,'stateHash',b.state_hash,
			'source',jsonb_build_object('block',e.block_number,'blockHash',e.block_hash,'transactionHash',e.tx_hash,'logIndex',e.log_index))
			FROM battle_snapshots b JOIN chain_events e ON e.id=b.source_event WHERE b.deployment_id=$1 AND b.match_id=$2 ORDER BY e.block_number,e.log_index`, snapshots},
		{"rounds", `SELECT jsonb_build_object('round',r.round,'phase',r.phase,'deadline',r.deadline,'beforeHash',r.before_hash,'afterHash',r.after_hash,'resolved',r.resolved,
			'source',jsonb_build_object('block',e.block_number,'blockHash',e.block_hash,'transactionHash',e.tx_hash,'logIndex',e.log_index))
			FROM rounds r JOIN chain_events e ON e.id=r.source_event WHERE r.deployment_id=$1 AND r.match_id=$2 ORDER BY r.round`, rounds},
		{"actions", `SELECT jsonb_build_object('round',a.round,'player',a.player,'commitment',a.commitment,'actions',a.actions,'salt',a.salt,
			'commit',jsonb_build_object('block',c.block_number,'blockHash',c.block_hash,'transactionHash',c.tx_hash,'logIndex',c.log_index),
			'reveal',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('block',r.block_number,'blockHash',r.block_hash,'transactionHash',r.tx_hash,'logIndex',r.log_index) END)
			FROM round_actions a JOIN chain_events c ON c.id=a.commit_event LEFT JOIN chain_events r ON r.id=a.reveal_event
			WHERE a.deployment_id=$1 AND a.match_id=$2 ORDER BY a.round,a.player`, actions},
	}
	for _, query := range queries {
		rows, err := tx.QueryContext(ctx, query.sql, s.deploymentID, e.result.MatchID)
		if err != nil {
			return err
		}
		actual := []json.RawMessage{}
		for rows.Next() {
			var data json.RawMessage
			if err = rows.Scan(&data); err != nil {
				rows.Close()
				return err
			}
			actual = append(actual, data)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		data, err := json.Marshal(query.want)
		if err != nil {
			return err
		}
		var expected []json.RawMessage
		if err = json.Unmarshal(data, &expected); err != nil {
			return err
		}
		for i, want := range expected {
			var row struct {
				Round uint8 `json:"round"`
			}
			if err = json.Unmarshal(want, &row); err != nil {
				return err
			}
			if query.name == "snapshots" {
				row.Round = e.result.Frames[i].Round
			}
			if i >= len(actual) {
				e.mismatch(row.Round, query.name+".count", len(expected), len(actual))
				return nil
			}
			if !e.compare(row.Round, fmt.Sprintf("%s[%d]", query.name, i), want, actual[i]) {
				return nil
			}
		}
		if len(actual) > len(expected) {
			e.mismatch(e.match.Round, query.name+".count", len(expected), len(actual))
			return nil
		}
	}
	e.compare(e.match.Round, "match", e.match, stored)
	return nil
}
