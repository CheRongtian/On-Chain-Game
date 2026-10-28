package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"onchainarena/server/internal/game"
)

type historyCheck struct {
	Name         string        `json:"name"`
	MatchID      string        `json:"matchId,omitempty"`
	Verification *verification `json:"verification,omitempty"`
	Block        uint64        `json:"block"`
	BlockHash    common.Hash   `json:"blockHash"`
}

type replayPage struct {
	Meta         metadata      `json:"meta"`
	Verification verification  `json:"verification"`
	Items        []replayFrame `json:"items"`
	Rounds       []replayRound `json:"rounds"`
	Limit        int           `json:"limit"`
	Offset       int           `json:"offset"`
	HasMore      bool          `json:"hasMore"`
}

func (c *checker) checkHistory() error {
	for _, entry := range c.report.Matches {
		if err := c.checkReplay(entry); err != nil {
			return fmt.Errorf("independent replay for match %s: %w", entry.ID, err)
		}
	}
	log.Print("PASS: independent replay hashes, public orders, pagination, and round snapshot queries matched both complete matches.")
	if err := c.checkTamperedSnapshot(c.report.Matches[0]); err != nil {
		return err
	}
	if err := c.checkMissingHistory(c.report.Matches[0]); err != nil {
		return err
	}
	if _, err := c.expectVerification(c.report.Matches[0].ID, "Verified"); err != nil {
		return fmt.Errorf("restoring isolated database faults: %w", err)
	}
	return c.checkBranches()
}

func (c *checker) expectVerification(id, status string) (verification, error) {
	var response struct {
		Meta         metadata     `json:"meta"`
		Verification verification `json:"verification"`
	}
	if err := c.get(c.ctx, "/matches/"+id+"/verification", &response); err != nil {
		return response.Verification, err
	}
	got := response.Verification
	if got.Status != status || status == "Verified" && (!got.Complete || !got.Canonical || !got.PrefixVerified || got.Difference != nil) {
		return got, fmt.Errorf("match %s expected %s, got %s: %s; difference=%+v", id, status, got.Status, got.Message, got.Difference)
	}
	if response.Meta.DeploymentHash != c.report.DeploymentHash.Hex() {
		return got, fmt.Errorf("verification belongs to a different deployment")
	}
	return got, nil
}

func (c *checker) recordHistory(name, id string, result verification) {
	c.report.History = append(c.report.History, historyCheck{name, id, &result, uint64(max(result.ThroughBlock, 0)), common.HexToHash(result.ThroughHash)})
}

func (c *checker) checkReplay(entry *checkedMatch) error {
	result, err := c.expectVerification(entry.ID, "Verified")
	if err != nil {
		return err
	}
	if result.VerifiedRounds != len(entry.Rounds) {
		return fmt.Errorf("expected %d verified rounds, got %d", len(entry.Rounds), result.VerifiedRounds)
	}
	for offset := 0; offset < len(entry.Snapshots); offset += 3 {
		var page replayPage
		if err = c.get(c.ctx, fmt.Sprintf("/matches/%s/replay?limit=3&offset=%d", entry.ID, offset), &page); err != nil {
			return err
		}
		count := min(3, len(entry.Snapshots)-offset)
		if page.Verification.Status != "Verified" || page.Limit != 3 || page.Offset != offset || len(page.Items) != count ||
			page.HasMore != (offset+count < len(entry.Snapshots)) || len(page.Rounds) != len(entry.Rounds) {
			return fmt.Errorf("invalid replay pagination or round inputs at offset %d", offset)
		}
		for i, frame := range page.Items {
			want := entry.Snapshots[offset+i]
			if frame.Index != offset+i || frame.State != want.State || frame.StateHash != want.Hash || frame.ComputedHash != want.Hash || frame.Source != want.Source {
				return fmt.Errorf("reconstructed frame %d differs from the confirmed chain snapshot", offset+i)
			}
			if frame.Index == 0 {
				if frame.Kind != "MatchStarted" || frame.Round != 1 || frame.Summary != nil {
					return fmt.Errorf("invalid initial replay frame")
				}
			} else {
				input := entry.Rounds[frame.Index-1]
				_, summary, resolveErr := game.Resolve(entry.Snapshots[frame.Index-1].State, input.Orders[0], input.Orders[1])
				if resolveErr != nil {
					return resolveErr
				}
				if frame.Kind != "RoundResolved" || frame.Round != input.Number || frame.Summary == nil || *frame.Summary != summary {
					return fmt.Errorf("round %d replay effects differ", input.Number)
				}
			}
		}
		for i, input := range page.Rounds {
			want := entry.Rounds[i]
			if input.Round != want.Number || input.Committed != [2]bool{true, true} {
				return fmt.Errorf("round %d replay commitment status differs", want.Number)
			}
			for player := range c.accounts {
				if input.Reveals[player] == nil || input.Reveals[player].Actions != want.Orders[player] ||
					input.Reveals[player].Salt != common.Hash(want.Salts[player]) || input.Commitments[player] != common.Hash(want.Commitments[player]) {
					return fmt.Errorf("round %d player %d replay inputs differ", want.Number, player)
				}
			}
		}
	}
	var snapshots replayPage
	if err = c.get(c.ctx, "/matches/"+entry.ID+"/snapshots?round=1&limit=100", &snapshots); err != nil {
		return err
	}
	if snapshots.Verification.Status != "Verified" || len(snapshots.Items) != 2 || snapshots.Items[0].Kind != "MatchStarted" || snapshots.Items[1].Kind != "RoundResolved" || snapshots.Items[1].Round != 1 {
		return fmt.Errorf("round snapshot retrieval did not preserve the initial and resolved states")
	}
	c.recordHistory("complete-replay", entry.ID, result)
	return nil
}

func (c *checker) checkTamperedSnapshot(entry *checkedMatch) (err error) {
	var eventID int64
	var original json.RawMessage
	from := entry.Snapshots[1].Source
	err = c.db.QueryRowContext(c.ctx, `SELECT b.source_event,b.state FROM battle_snapshots b JOIN chain_events e ON e.id=b.source_event
		WHERE b.deployment_id=$1 AND b.match_id=$2 AND e.block_hash=$3 AND e.log_index=$4`,
		c.store.deploymentID, entry.ID, from.BlockHash, from.LogIndex).Scan(&eventID, &original)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, restoreErr := c.db.ExecContext(cleanup, `UPDATE battle_snapshots SET state=$3 WHERE deployment_id=$1 AND source_event=$2`, c.store.deploymentID, eventID, string(original))
		err = errors.Join(err, restoreErr)
	}()
	_, err = c.db.ExecContext(c.ctx, `UPDATE battle_snapshots SET state=jsonb_set(state,'{units,0,hp}',to_jsonb((state->'units'->0->>'hp')::int-1))
		WHERE deployment_id=$1 AND source_event=$2`, c.store.deploymentID, eventID)
	if err != nil {
		return err
	}
	result, err := c.expectVerification(entry.ID, "Mismatch")
	if err != nil {
		return err
	}
	if result.Difference == nil || result.Difference.Round != 1 || !strings.HasSuffix(result.Difference.Field, ".state.units[0].hp") {
		return fmt.Errorf("tampered snapshot did not identify the first affected round and HP field: %+v", result.Difference)
	}
	values, err := c.read(nil, "getMatch", newBigID(entry.ID))
	if err != nil {
		return err
	}
	data, err := json.Marshal(values[0])
	if err != nil {
		return err
	}
	var summary chainMatch
	if err = json.Unmarshal(data, &summary); err != nil {
		return err
	}
	if common.Hash(summary.StateHash) != entry.StateHash {
		return fmt.Errorf("chain state changed during the isolated database fault")
	}
	c.recordHistory("tampered-snapshot", entry.ID, result)
	log.Printf("PASS: a changed snapshot was marked Mismatch at %s; the chain result was unchanged.", result.Difference.Field)
	return nil
}

func (c *checker) checkMissingHistory(entry *checkedMatch) (err error) {
	// Move one already-public log out of this match's indexed history, preserving its
	// row and references so restoration does not cascade through derived records.
	var eventID int64
	err = c.db.QueryRowContext(c.ctx, `SELECT id FROM chain_events WHERE deployment_id=$1 AND match_id=$2 AND name='ActionRevealed' ORDER BY block_number,log_index LIMIT 1`, c.store.deploymentID, entry.ID).Scan(&eventID)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, restoreErr := c.db.ExecContext(cleanup, `UPDATE chain_events SET match_id=$3 WHERE deployment_id=$1 AND id=$2`, c.store.deploymentID, eventID, entry.ID)
		err = errors.Join(err, restoreErr)
	}()
	_, err = c.db.ExecContext(c.ctx, `UPDATE chain_events SET match_id=$3 WHERE deployment_id=$1 AND id=$2`, c.store.deploymentID, eventID,
		"115792089237316195423570985008687907853269984665640564039457584007913129639935")
	if err != nil {
		return err
	}
	result, err := c.expectVerification(entry.ID, "Incomplete")
	if err != nil {
		return err
	}
	if result.PrefixVerified || result.Difference != nil {
		return fmt.Errorf("a missing public event was incorrectly certified")
	}
	c.recordHistory("missing-public-history", entry.ID, result)
	log.Print("PASS: missing indexed public history was marked Incomplete.")
	return nil
}
