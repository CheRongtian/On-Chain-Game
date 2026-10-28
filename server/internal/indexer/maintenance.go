package indexer

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

func (s *service) maintenance(ctx context.Context, root, operation string) error {
	if operation != "rescan" && operation != "reindex" {
		return fmt.Errorf("unknown indexing operation %q", operation)
	}
	request, cancel := context.WithTimeout(ctx, 30*time.Second)
	value, _, err := s.validateCursor(request)
	if err != nil {
		cancel()
		return err
	}
	before, err := s.export(request)
	cancel()
	if err != nil {
		return err
	}
	if value.Number < int64(s.cfg.From) {
		return fmt.Errorf("index at least the deployment block before requesting %s", operation)
	}
	dir := filepath.Join(root, ".local", "indexer")
	if err = os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	report := struct {
		Operation      string                       `json:"operation"`
		Status         string                       `json:"status"`
		ChainID        uint64                       `json:"chainId"`
		Arena          string                       `json:"arena"`
		DeploymentHash string                       `json:"deploymentHash"`
		Block          uint64                       `json:"comparedThroughBlock"`
		Matched        bool                         `json:"matched"`
		Before         map[string][]json.RawMessage `json:"before"`
		After          map[string][]json.RawMessage `json:"after"`
	}{operation, "pending", s.cfg.ChainID, s.cfg.Arena, s.anchor.Hash().Hex(), uint64(value.Number), false, before, nil}
	writeReport := func() error {
		data, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, operation+".json"), append(data, '\n'), 0600)
	}
	// Save the original public records before removing anything for reconstruction.
	if err = writeReport(); err != nil {
		return err
	}
	if operation == "reindex" {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `DELETE FROM matches WHERE deployment_id=$1`, s.deploymentID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM chain_blocks WHERE deployment_id=$1`, s.deploymentID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE sync_cursors SET block_number=$2,block_hash=$3 WHERE deployment_id=$1`,
			s.deploymentID, int64(s.cfg.From)-1, s.anchor.ParentHash.Hex()); err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	// Compare at the original cursor, even if players produce new blocks during reconstruction.
	target := uint64(value.Number)
	request, cancel = context.WithTimeout(ctx, 5*time.Minute)
	_, err = s.sync(request, operation == "rescan", &target)
	if err != nil {
		cancel()
		return fmt.Errorf("%w; the local indexing report retains the pre-operation records", err)
	}
	after, err := s.export(request)
	cancel()
	if err != nil {
		return err
	}
	matched := reflect.DeepEqual(before, after)
	report.After, report.Matched, report.Status = after, matched, "compared"
	if err = writeReport(); err != nil {
		return err
	}
	if !matched {
		return fmt.Errorf("%s changed indexed records; before/after evidence is saved in the local indexing report", operation)
	}
	log.Printf("%s matched through block %d: %d matches, %d events; all records and cursor are unchanged. Local comparison report saved.",
		operation, target, len(after["matches"]), len(after["events"]))
	return nil
}

func (s *service) export(ctx context.Context) (map[string][]json.RawMessage, error) {
	queries := []struct{ name, sql string }{
		{"blocks", `SELECT jsonb_build_object('number',number,'hash',hash,'parentHash',parent_hash,'timestamp',timestamp) FROM chain_blocks WHERE deployment_id=$1 ORDER BY number`},
		{"events", `SELECT jsonb_build_object('block',block_number,'blockHash',block_hash,'txHash',tx_hash,'txIndex',tx_index,'logIndex',log_index,'name',name,'matchId',match_id::text,'round',round,'raw',raw_log,'payload',payload) FROM chain_events WHERE deployment_id=$1 ORDER BY block_number,log_index`},
		{"matches", `SELECT data FROM matches WHERE deployment_id=$1 ORDER BY match_id`},
		{"rounds", `SELECT jsonb_build_object('matchId',r.match_id::text,'round',r.round,'phase',r.phase,'deadline',r.deadline,'beforeHash',r.before_hash,'afterHash',r.after_hash,'resolved',r.resolved,'block',e.block_number,'logIndex',e.log_index) FROM rounds r JOIN chain_events e ON e.id=r.source_event WHERE r.deployment_id=$1 ORDER BY r.match_id,r.round`},
		{"actions", `SELECT jsonb_build_object('matchId',a.match_id::text,'round',a.round,'player',a.player,'commitment',a.commitment,'actions',a.actions,'salt',a.salt,'commitBlock',c.block_number,'commitLogIndex',c.log_index,'revealBlock',r.block_number,'revealLogIndex',r.log_index) FROM round_actions a JOIN chain_events c ON c.id=a.commit_event LEFT JOIN chain_events r ON r.id=a.reveal_event WHERE a.deployment_id=$1 ORDER BY a.match_id,a.round,a.player`},
		{"snapshots", `SELECT jsonb_build_object('matchId',b.match_id::text,'round',b.round,'state',b.state,'stateHash',b.state_hash,'block',e.block_number,'logIndex',e.log_index) FROM battle_snapshots b JOIN chain_events e ON e.id=b.source_event WHERE b.deployment_id=$1 ORDER BY b.match_id,e.block_number,e.log_index`},
		{"cursor", `SELECT jsonb_build_object('block',block_number,'hash',block_hash) FROM sync_cursors WHERE deployment_id=$1`},
	}
	result := make(map[string][]json.RawMessage)
	for _, query := range queries {
		rows, err := s.db.QueryContext(ctx, query.sql, s.deploymentID)
		if err != nil {
			return nil, err
		}
		result[query.name] = []json.RawMessage{}
		for rows.Next() {
			var data json.RawMessage
			if err = rows.Scan(&data); err != nil {
				rows.Close()
				return nil, err
			}
			result[query.name] = append(result[query.name], data)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
