package indexer

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"onchainarena/server/internal/game"
)

func (c *checker) checkRecords() error {
	for _, entry := range c.report.Matches {
		if err := c.checkMatch(entry); err != nil {
			return fmt.Errorf("match %s detail: %w", entry.ID, err)
		}
		if err := c.checkEvents(entry); err != nil {
			return fmt.Errorf("match %s events: %w", entry.ID, err)
		}
		if err := c.checkRounds(entry); err != nil {
			return fmt.Errorf("match %s rounds: %w", entry.ID, err)
		}
		if err := c.checkActions(entry); err != nil {
			return fmt.Errorf("match %s actions: %w", entry.ID, err)
		}
		if err := c.checkSnapshots(entry); err != nil {
			return fmt.Errorf("match %s snapshots: %w", entry.ID, err)
		}
	}
	return nil
}

func (c *checker) checkMatch(want *checkedMatch) error {
	var response struct {
		Meta  metadata `json:"meta"`
		Match match    `json:"match"`
	}
	if err := c.get(c.ctx, "/matches/"+want.ID, &response); err != nil {
		return err
	}
	if !response.Meta.Ready || response.Meta.DeploymentHash != c.report.DeploymentHash.Hex() {
		return fmt.Errorf("API detail does not describe a ready current deployment")
	}
	got := response.Match
	if got.ID != want.ID || got.Phase != want.summary.Phase || got.Round != want.summary.Round || got.MapID != want.summary.MapId ||
		got.Outcome != game.Outcome(want.summary.Outcome) || got.Reason != game.EndReason(want.summary.Reason) ||
		got.JoinDeadline != want.summary.JoinDeadline || got.PhaseDeadline != want.summary.PhaseDeadline ||
		got.RulesHash != common.Hash(want.summary.RulesHash) || got.StateHash != want.StateHash || got.Winner != c.accounts[0] ||
		got.Committed != [2]bool{true, true} || got.Revealed != [2]bool{true, true} || got.Source != want.Source {
		return fmt.Errorf("API match fields differ from the chain result and receipt")
	}
	for i, player := range want.summary.Players {
		if player != c.accounts[i] || !strings.EqualFold(got.Players[i], player.Hex()) {
			return fmt.Errorf("player %d differs from the chain result", i)
		}
	}
	if got.Battle == nil || !reflect.DeepEqual(*got.Battle, want.State) {
		return fmt.Errorf("API battle state differs from getBattleState at the settlement block")
	}
	var data []byte
	err := c.db.QueryRowContext(c.ctx, `SELECT data FROM matches WHERE deployment_id=$1 AND match_id=$2`, c.store.deploymentID, want.ID).Scan(&data)
	if err != nil {
		return err
	}
	var stored match
	if err = json.Unmarshal(data, &stored); err != nil {
		return err
	}
	if !reflect.DeepEqual(stored, got) {
		return fmt.Errorf("API detail differs from its stored match")
	}
	return nil
}

func samePayload(a, b json.RawMessage) (bool, error) {
	var left, right any
	if err := json.Unmarshal(a, &left); err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, &right); err != nil {
		return false, err
	}
	return reflect.DeepEqual(left, right), nil
}

func (c *checker) checkEvents(want *checkedMatch) error {
	rows, err := c.db.QueryContext(c.ctx, `SELECT name,round,block_number,block_hash,tx_hash,tx_index,log_index,raw_log,payload
		FROM chain_events WHERE deployment_id=$1 AND match_id=$2 ORDER BY block_number,log_index`, c.store.deploymentID, want.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var name, blockHash, txHash string
		var round uint8
		var block uint64
		var txIndex, logIndex uint
		var raw, payload []byte
		if err = rows.Scan(&name, &round, &block, &blockHash, &txHash, &txIndex, &logIndex, &raw, &payload); err != nil {
			return err
		}
		if i >= len(want.Events) {
			return fmt.Errorf("unexpected extra database event")
		}
		var stored types.Log
		if err = json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		expected := want.Events[i]
		equal, decodeErr := samePayload(payload, expected.Payload)
		if decodeErr != nil {
			return decodeErr
		}
		if name != expected.Name || round != expected.Round || block != expected.Log.BlockNumber || blockHash != expected.Log.BlockHash.Hex() ||
			txHash != expected.Log.TxHash.Hex() || txIndex != expected.Log.TxIndex || logIndex != expected.Log.Index || !sameLog(stored, expected.Log) || !equal {
			return fmt.Errorf("database event %d differs from its transaction receipt (block %d log %d)", i, expected.Log.BlockNumber, expected.Log.Index)
		}
		i++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if i != len(want.Events) {
		return fmt.Errorf("database contains %d events; expected %d", i, len(want.Events))
	}
	if err = rows.Close(); err != nil {
		return err
	}
	for offset := 0; offset < len(want.Events); offset += 20 {
		var page struct {
			Meta  metadata `json:"meta"`
			Items []struct {
				Name    string          `json:"name"`
				Raw     types.Log       `json:"raw"`
				Payload json.RawMessage `json:"payload"`
			} `json:"items"`
			Limit   int  `json:"limit"`
			Offset  int  `json:"offset"`
			HasMore bool `json:"hasMore"`
		}
		path := fmt.Sprintf("/matches/%s/events?limit=20&offset=%d", want.ID, offset)
		if err = c.get(c.ctx, path, &page); err != nil {
			return err
		}
		count := min(20, len(want.Events)-offset)
		if page.Limit != 20 || page.Offset != offset || len(page.Items) != count || page.HasMore != (offset+count < len(want.Events)) ||
			!page.Meta.Ready || page.Meta.DeploymentHash != c.report.DeploymentHash.Hex() {
			return fmt.Errorf("invalid API event pagination at offset %d", offset)
		}
		for j, item := range page.Items {
			expected := want.Events[offset+j]
			equal, decodeErr := samePayload(item.Payload, expected.Payload)
			if decodeErr != nil {
				return decodeErr
			}
			if item.Name != expected.Name || !sameLog(item.Raw, expected.Log) || !equal {
				return fmt.Errorf("API event %d differs from its receipt", offset+j)
			}
		}
	}
	return nil
}

func (c *checker) checkRounds(want *checkedMatch) error {
	rows, err := c.db.QueryContext(c.ctx, `SELECT round,phase,deadline,before_hash,after_hash,resolved FROM rounds WHERE deployment_id=$1 AND match_id=$2 ORDER BY round`, c.store.deploymentID, want.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var round, phase uint8
		var deadline uint64
		var before, after sql.NullString
		var resolved bool
		if err = rows.Scan(&round, &phase, &deadline, &before, &after, &resolved); err != nil {
			return err
		}
		if i >= len(want.Rounds) {
			return fmt.Errorf("unexpected extra round")
		}
		expected := want.Rounds[i]
		expectedPhase := uint8(4)
		if i == len(want.Rounds)-1 {
			expectedPhase = 5
		}
		if round != expected.Number || phase != expectedPhase || deadline != 0 || !resolved || !before.Valid || !after.Valid ||
			before.String != expected.BeforeHash.Hex() || after.String != expected.AfterHash.Hex() {
			return fmt.Errorf("round %d differs from the chain transitions", round)
		}
		i++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if i != len(want.Rounds) {
		return fmt.Errorf("database contains %d rounds; expected %d", i, len(want.Rounds))
	}
	return nil
}

func (c *checker) checkActions(want *checkedMatch) error {
	rows, err := c.db.QueryContext(c.ctx, `SELECT round,player,commitment,actions,salt FROM round_actions WHERE deployment_id=$1 AND match_id=$2 ORDER BY round,player`, c.store.deploymentID, want.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var round uint8
		var player, commitment string
		var salt sql.NullString
		var data []byte
		if err = rows.Scan(&round, &player, &commitment, &data, &salt); err != nil {
			return err
		}
		if round == 0 || int(round) > len(want.Rounds) {
			return fmt.Errorf("unexpected round %d in public actions", round)
		}
		index := -1
		for i, address := range c.accounts {
			if strings.EqualFold(player, address.Hex()) {
				index = i
			}
		}
		if index < 0 {
			return fmt.Errorf("unexpected player in public actions")
		}
		var actions [3]game.Action
		if err = json.Unmarshal(data, &actions); err != nil {
			return err
		}
		expected := want.Rounds[round-1]
		if !salt.Valid || salt.String != common.Hash(expected.Salts[index]).Hex() || commitment != common.Hash(expected.Commitments[index]).Hex() ||
			actions != expected.Orders[index] {
			return fmt.Errorf("round %d player %d commitment or public reveal differs", round, index)
		}
		count++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if count != len(want.Rounds)*2 {
		return fmt.Errorf("database contains %d action bundles; expected %d", count, len(want.Rounds)*2)
	}
	return nil
}

func (c *checker) checkSnapshots(want *checkedMatch) error {
	rows, err := c.db.QueryContext(c.ctx, `SELECT b.round,b.state,b.state_hash,e.block_number,e.block_hash,e.tx_hash,e.log_index
		FROM battle_snapshots b JOIN chain_events e ON e.id=b.source_event WHERE b.deployment_id=$1 AND b.match_id=$2 ORDER BY e.block_number,e.log_index`, c.store.deploymentID, want.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var round uint8
		var data []byte
		var hash string
		var from source
		if err = rows.Scan(&round, &data, &hash, &from.Block, &from.BlockHash, &from.TxHash, &from.LogIndex); err != nil {
			return err
		}
		if i >= len(want.Snapshots) {
			return fmt.Errorf("unexpected extra snapshot")
		}
		var state game.BattleState
		if err = json.Unmarshal(data, &state); err != nil {
			return err
		}
		expected := want.Snapshots[i]
		if round != expected.State.Round || hash != expected.Hash.Hex() || from != expected.Source || state != expected.State {
			return fmt.Errorf("snapshot %d differs from its chain state or source event", i)
		}
		i++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if i != len(want.Snapshots) {
		return fmt.Errorf("database contains %d snapshots; expected %d", i, len(want.Snapshots))
	}
	return nil
}
