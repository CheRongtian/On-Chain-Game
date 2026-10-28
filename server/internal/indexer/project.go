package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"onchainarena/server/internal/game"
)

type source struct {
	Block     uint64 `json:"block"`
	BlockHash string `json:"blockHash"`
	TxHash    string `json:"transactionHash"`
	LogIndex  uint   `json:"logIndex"`
}

type match struct {
	ID            string            `json:"id"`
	Players       [2]string         `json:"players"`
	MapID         uint8             `json:"mapId"`
	RulesHash     common.Hash       `json:"rulesHash"`
	Phase         uint8             `json:"phase"`
	Round         uint8             `json:"round"`
	JoinDeadline  uint64            `json:"joinDeadline"`
	PhaseDeadline uint64            `json:"phaseDeadline"`
	StateHash     common.Hash       `json:"stateHash"`
	Outcome       game.Outcome      `json:"outcome"`
	Reason        game.EndReason    `json:"reason"`
	Winner        common.Address    `json:"winner"`
	Committed     [2]bool           `json:"committed"`
	Revealed      [2]bool           `json:"revealed"`
	Battle        *game.BattleState `json:"battleState,omitempty"`
	Source        source            `json:"source"`
}

type decoded struct {
	MatchID         string            `json:"matchId"`
	Round           uint8             `json:"round"`
	Creator         common.Address    `json:"creator"`
	Player          common.Address    `json:"player"`
	MapID           uint8             `json:"mapId"`
	RulesHash       common.Hash       `json:"rulesHash"`
	JoinDeadline    uint64            `json:"joinDeadline"`
	InitialState    *game.BattleState `json:"initialState"`
	StateHash       common.Hash       `json:"stateHash"`
	Commitment      common.Hash       `json:"commitment"`
	Actions         *[3]game.Action   `json:"actions"`
	Salt            common.Hash       `json:"salt"`
	Phase           uint8             `json:"phase"`
	Deadline        uint64            `json:"deadline"`
	BeforeStateHash common.Hash       `json:"beforeStateHash"`
	AfterStateHash  common.Hash       `json:"afterStateHash"`
	Outcome         game.Outcome      `json:"outcome"`
	Reason          game.EndReason    `json:"reason"`
	Winner          common.Address    `json:"winner"`
}

func decodeEvent(contract abi.ABI, entry types.Log) (string, decoded, []byte, error) {
	var result decoded
	if len(entry.Topics) == 0 || entry.Removed {
		return "", result, nil, fmt.Errorf("removed or anonymous log cannot be indexed as canonical")
	}
	event, err := contract.EventByID(entry.Topics[0])
	if err != nil {
		return "", result, nil, err
	}
	values := make(map[string]any)
	if err = event.Inputs.NonIndexed().UnpackIntoMap(values, entry.Data); err != nil {
		return "", result, nil, err
	}
	var indexed abi.Arguments
	for _, field := range event.Inputs {
		if field.Indexed {
			indexed = append(indexed, field)
		}
	}
	if err = abi.ParseTopicsIntoMap(values, indexed, entry.Topics[1:]); err != nil {
		return "", result, nil, err
	}
	for key, value := range values {
		switch value := value.(type) {
		case [32]byte:
			values[key] = common.Hash(value).Hex()
		case *big.Int:
			values[key] = value.String()
		}
	}
	payload, err := json.Marshal(values)
	if err != nil {
		return "", result, nil, err
	}
	if err = json.Unmarshal(payload, &result); err != nil {
		return "", result, nil, err
	}
	if result.MatchID == "" || result.MatchID == "0" {
		return "", result, nil, fmt.Errorf("event has no valid match ID")
	}
	if result.InitialState != nil {
		result.Round = result.InitialState.Round
	}
	return event.Name, result, payload, nil
}

func (s *service) project(ctx context.Context, tx *sql.Tx, entry types.Log, eventID int64, name string, event decoded) error {
	var m match
	var data []byte
	err := tx.QueryRowContext(ctx, `SELECT data FROM matches WHERE deployment_id=$1 AND match_id=$2`, s.deploymentID, event.MatchID).Scan(&data)
	if name == "MatchCreated" {
		if !errors.Is(err, sql.ErrNoRows) {
			if err == nil {
				return fmt.Errorf("match %s was already created", event.MatchID)
			}
			return err
		}
		m = match{ID: event.MatchID, Players: [2]string{strings.ToLower(event.Creator.Hex()), strings.ToLower(common.Address{}.Hex())},
			MapID: event.MapID, RulesHash: event.RulesHash, Phase: 1, JoinDeadline: event.JoinDeadline}
		if event.RulesHash != common.Hash(game.RulesHash()) {
			return fmt.Errorf("unsupported rules hash in match %s", m.ID)
		}
		err = nil
	} else {
		if err != nil {
			return fmt.Errorf("load match %s for %s: %w", event.MatchID, name, err)
		}
		if err = json.Unmarshal(data, &m); err != nil {
			return err
		}
	}
	m.Source = source{entry.BlockNumber, entry.BlockHash.Hex(), entry.TxHash.Hex(), entry.Index}

	switch name {
	case "MatchCreated":
	case "PlayerJoined":
		m.Players[1] = strings.ToLower(event.Player.Hex())
	case "MatchStarted":
		if event.InitialState == nil {
			return fmt.Errorf("MatchStarted lacks initial state")
		}
		m.Battle, m.Round, m.StateHash = event.InitialState, event.InitialState.Round, event.StateHash
		if err = s.snapshot(ctx, tx, m, eventID); err != nil {
			return err
		}
	case "PhaseAdvanced":
		m.Phase, m.Round = event.Phase, event.Round
		m.PhaseDeadline = 0
		if event.Phase == 2 || event.Phase == 3 {
			m.PhaseDeadline = event.Deadline
		}
		if event.Phase == 2 {
			m.Committed, m.Revealed = [2]bool{}, [2]bool{}
		}
	case "ActionCommitted", "ActionRevealed":
		player := strings.ToLower(event.Player.Hex())
		index := -1
		for i, address := range m.Players {
			if address == player {
				index = i
			}
		}
		if index < 0 {
			return fmt.Errorf("event player does not belong to match %s", m.ID)
		}
		if name == "ActionCommitted" {
			m.Committed[index] = true
			_, err = tx.ExecContext(ctx, `INSERT INTO round_actions(deployment_id,match_id,round,player,commitment,commit_event)
				VALUES($1,$2,$3,$4,$5,$6)`, s.deploymentID, m.ID, event.Round, player, event.Commitment.Hex(), eventID)
		} else {
			if event.Actions == nil {
				return fmt.Errorf("ActionRevealed lacks orders")
			}
			m.Revealed[index] = true
			actions, marshalErr := json.Marshal(event.Actions)
			if marshalErr != nil {
				return marshalErr
			}
			var result sql.Result
			result, err = tx.ExecContext(ctx, `UPDATE round_actions SET actions=$5,salt=$6,reveal_event=$7
				WHERE deployment_id=$1 AND match_id=$2 AND round=$3 AND player=$4`,
				s.deploymentID, m.ID, event.Round, player, string(actions), event.Salt.Hex(), eventID)
			if err == nil {
				count, countErr := result.RowsAffected()
				if countErr != nil {
					return countErr
				}
				if count != 1 {
					return fmt.Errorf("Reveal has no indexed commitment")
				}
			}
		}
	case "RoundResolved":
		if m.Battle == nil || m.Battle.Round != event.Round {
			return fmt.Errorf("round %d has no matching round-start state", event.Round)
		}
		var actions [2][3]game.Action
		for i, player := range m.Players {
			var raw []byte
			if err = tx.QueryRowContext(ctx, `SELECT actions FROM round_actions WHERE deployment_id=$1 AND match_id=$2 AND round=$3 AND player=$4 AND reveal_event IS NOT NULL`,
				s.deploymentID, m.ID, event.Round, player).Scan(&raw); err != nil {
				return fmt.Errorf("load publicly revealed orders: %w", err)
			}
			if err = json.Unmarshal(raw, &actions[i]); err != nil {
				return err
			}
		}
		// These snapshots are projections; independent historical verification belongs to Replay.
		next, _, resolveErr := game.Resolve(*m.Battle, actions[0], actions[1])
		if resolveErr != nil {
			return resolveErr
		}
		m.Battle, m.Round, m.StateHash = &next, next.Round, event.AfterStateHash
		m.Outcome, m.Reason = event.Outcome, event.Reason
		_, err = tx.ExecContext(ctx, `UPDATE rounds SET before_hash=$4,after_hash=$5,resolved=TRUE,source_event=$6 WHERE deployment_id=$1 AND match_id=$2 AND round=$3`,
			s.deploymentID, m.ID, event.Round, event.BeforeStateHash.Hex(), event.AfterStateHash.Hex(), eventID)
		if err == nil {
			err = s.snapshot(ctx, tx, m, eventID)
		}
	case "MatchFinished":
		m.Outcome, m.Reason, m.Winner, m.StateHash = event.Outcome, event.Reason, event.Winner, event.StateHash
		if m.Battle == nil {
			return fmt.Errorf("MatchFinished lacks preceding battle state")
		}
		m.Battle.Outcome, m.Battle.Reason = event.Outcome, event.Reason
		if event.Reason == game.CommitTimeout || event.Reason == game.RevealTimeout {
			err = s.snapshot(ctx, tx, m, eventID)
		}
	default:
		return fmt.Errorf("unsupported Arena event %s", name)
	}
	if err != nil {
		return err
	}
	data, err = json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO matches(deployment_id,match_id,phase,data) VALUES($1,$2,$3,$4)
		ON CONFLICT(deployment_id,match_id) DO UPDATE SET phase=excluded.phase,data=excluded.data`, s.deploymentID, m.ID, m.Phase, string(data))
	if err == nil && name == "PhaseAdvanced" && event.Round > 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO rounds(deployment_id,match_id,round,phase,deadline,source_event) VALUES($1,$2,$3,$4,$5,$6)
			ON CONFLICT(deployment_id,match_id,round) DO UPDATE SET phase=excluded.phase,deadline=excluded.deadline,source_event=excluded.source_event`,
			s.deploymentID, m.ID, event.Round, event.Phase, event.Deadline, eventID)
	}
	return err
}

func (s *service) snapshot(ctx context.Context, tx *sql.Tx, m match, eventID int64) error {
	state, err := json.Marshal(m.Battle)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO battle_snapshots(deployment_id,match_id,round,source_event,state,state_hash) VALUES($1,$2,$3,$4,$5,$6)`,
		s.deploymentID, m.ID, m.Round, eventID, string(state), m.StateHash.Hex())
	return err
}
