package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/core/types"
)

func (s *service) recoverBranch(ctx context.Context) error {
	anchor, err := s.chain.HeaderByNumber(ctx, new(big.Int).SetUint64(s.cfg.From))
	if err != nil {
		return fmt.Errorf("read deployment anchor during recovery: %w", err)
	}
	if anchor.Hash() != s.anchor.Hash() {
		return errDeploymentChanged
	}
	value, err := s.cursor(ctx)
	if err != nil {
		return err
	}
	head, err := s.chain.HeaderByNumber(ctx, nil)
	if err != nil {
		return err
	}
	ancestor := cursor{Number: int64(s.cfg.From) - 1, Hash: s.anchor.ParentHash.Hex()}
	for number := min(value.Number, head.Number.Int64()); number >= int64(s.cfg.From); number-- {
		var stored string
		if err = s.db.QueryRowContext(ctx, `SELECT hash FROM chain_blocks WHERE deployment_id=$1 AND number=$2`, s.deploymentID, number).Scan(&stored); err != nil {
			return err
		}
		canonical, readErr := s.chain.HeaderByNumber(ctx, big.NewInt(number))
		if readErr != nil {
			return readErr
		}
		if strings.EqualFold(stored, canonical.Hash().Hex()) {
			ancestor = cursor{number, stored}
			break
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT match_id::text FROM chain_events WHERE deployment_id=$1 AND block_number>$2 ORDER BY match_id::text`, s.deploymentID, ancestor.Number)
	if err != nil {
		return err
	}
	var affected []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		affected = append(affected, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO orphaned_blocks(deployment_id,number,hash,parent_hash,timestamp,events)
		SELECT b.deployment_id,b.number,b.hash,b.parent_hash,b.timestamp,
		COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.log_index) FROM chain_events e
		WHERE e.deployment_id=b.deployment_id AND e.block_hash=b.hash),'[]'::jsonb)
		FROM chain_blocks b WHERE b.deployment_id=$1 AND b.number>$2
		ON CONFLICT(deployment_id,hash) DO NOTHING`, s.deploymentID, ancestor.Number)
	if err != nil {
		return err
	}
	for _, id := range affected {
		if _, err = tx.ExecContext(ctx, `DELETE FROM matches WHERE deployment_id=$1 AND match_id=$2`, s.deploymentID, id); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM chain_blocks WHERE deployment_id=$1 AND number>$2`, s.deploymentID, ancestor.Number); err != nil {
		return err
	}
	// Rebuild only affected matches from their surviving public logs, in chain order.
	for _, id := range affected {
		if err = s.reprojectMatch(ctx, tx, id); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE sync_cursors SET block_number=$2,block_hash=$3 WHERE deployment_id=$1`, s.deploymentID, ancestor.Number, ancestor.Hash); err != nil {
		return err
	}
	last, err := s.chain.HeaderByNumber(ctx, big.NewInt(ancestor.Number))
	if err != nil {
		return err
	}
	if !strings.EqualFold(last.Hash().Hex(), ancestor.Hash) {
		return errFork
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	log.Printf("Recovered chain branch: cursor %d -> %d; rebuilt %d affected matches and archived displaced blocks.", value.Number, ancestor.Number, len(affected))
	return nil
}

func (s *service) reprojectMatch(ctx context.Context, tx *sql.Tx, matchID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,raw_log FROM chain_events WHERE deployment_id=$1 AND match_id=$2 ORDER BY block_number,log_index`, s.deploymentID, matchID)
	if err != nil {
		return err
	}
	type event struct {
		id  int64
		log types.Log
	}
	var events []event
	for rows.Next() {
		var item event
		var raw []byte
		if err = rows.Scan(&item.id, &raw); err == nil {
			err = json.Unmarshal(raw, &item.log)
		}
		if err != nil {
			rows.Close()
			return err
		}
		events = append(events, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range events {
		name, decoded, _, decodeErr := decodeEvent(s.cfg.ABI, item.log)
		if decodeErr != nil {
			return decodeErr
		}
		if err = s.project(ctx, tx, item.log, item.id, name, decoded); err != nil {
			return err
		}
	}
	return nil
}

// Verification is computed per request; no cached Verified flag survives a branch change.
func (s *service) canonicalCursor(ctx context.Context, value cursor) error {
	anchor, err := s.chain.HeaderByNumber(ctx, new(big.Int).SetUint64(s.cfg.From))
	if err != nil {
		return err
	}
	if anchor.Hash() != s.anchor.Hash() {
		return errDeploymentChanged
	}
	if value.Number < int64(s.cfg.From) {
		return errors.New("the deployment block has not been indexed")
	}
	last, err := s.chain.HeaderByNumber(ctx, big.NewInt(value.Number))
	if err != nil {
		return err
	}
	if !strings.EqualFold(last.Hash().Hex(), value.Hash) {
		return errFork
	}
	return nil
}
