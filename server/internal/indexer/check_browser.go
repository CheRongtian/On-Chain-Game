package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// BrowserFault supplies local browser acceptance without adding write API routes.
func BrowserFault(root, operation string) error {
	if operation != "corrupt" && operation != "restore" && operation != "database-state" && operation != "hold-keeper" {
		return fmt.Errorf("unknown browser fault operation")
	}
	cfg, err := readConfig(root)
	if err != nil {
		return err
	}
	var report checkReport
	data, err := os.ReadFile(filepath.Join(root, ".local", "indexer", "acceptance.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &report); err != nil {
		return err
	}
	if report.Status != "passed" || report.ChainID != cfg.ChainID || report.Arena != cfg.Arena || len(report.Matches) == 0 {
		return fmt.Errorf("run the Indexer acceptance checks before browser faults")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", cfg.Database)
	if err != nil {
		return err
	}
	defer db.Close()
	var deployment int64
	err = db.QueryRowContext(ctx, `SELECT id FROM deployments WHERE chain_id=$1 AND arena=$2 AND deployment_hash=$3`,
		cfg.ChainID, cfg.Arena, report.DeploymentHash.Hex()).Scan(&deployment)
	if err != nil {
		return err
	}
	if operation == "hold-keeper" {
		gate, err := keeperGate(ctx, db, deployment, true)
		if err != nil {
			return err
		}
		defer releaseKeeperGate(gate, deployment)
		fmt.Println("Keeper paused for browser branch acceptance.")
		// Closing the driver's input releases the lock, including during cleanup.
		_, err = io.Copy(io.Discard, os.Stdin)
		return err
	}
	if operation == "database-state" {
		state := struct {
			Started time.Time                    `json:"startedAt"`
			LockPID int                          `json:"indexerLockPid"`
			Records map[string][]json.RawMessage `json:"records"`
		}{}
		err = db.QueryRowContext(ctx, `SELECT pg_postmaster_start_time(),COALESCE((
			SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
			WHERE a.datname=current_database() AND a.application_name='onchain_arena_backend'
			AND l.locktype='advisory' AND l.classid=0 AND l.objid::bigint=$1 AND l.granted LIMIT 1),0)`, deployment).
			Scan(&state.Started, &state.LockPID)
		if err != nil {
			return err
		}
		store := &service{db: db, deploymentID: deployment}
		state.Records, err = store.export(ctx)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(state)
	}
	backup := struct {
		Deployment int64           `json:"deployment"`
		Event      int64           `json:"event"`
		State      json.RawMessage `json:"state"`
	}{}
	file := filepath.Join(root, ".local", "indexer", "browser-snapshot.json")
	if operation == "restore" {
		data, err = os.ReadFile(file)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(data, &backup); err != nil {
			return err
		}
		if backup.Deployment != deployment {
			return fmt.Errorf("snapshot backup belongs to a different deployment")
		}
		_, err = db.ExecContext(ctx, `UPDATE battle_snapshots SET state=$3 WHERE deployment_id=$1 AND source_event=$2`, deployment, backup.Event, string(backup.State))
		if err == nil {
			fmt.Println("Browser snapshot fault restored.")
		}
		return err
	}
	backup.Deployment = deployment
	from := report.Matches[0].Snapshots[1].Source
	err = db.QueryRowContext(ctx, `SELECT b.source_event,b.state FROM battle_snapshots b JOIN chain_events e ON e.id=b.source_event
		WHERE b.deployment_id=$1 AND b.match_id=$2 AND e.block_hash=$3 AND e.log_index=$4`, deployment, report.Matches[0].ID, from.BlockHash, from.LogIndex).Scan(&backup.Event, &backup.State)
	if err != nil {
		return err
	}
	data, err = json.Marshal(backup)
	if err != nil {
		return err
	}
	if err = os.WriteFile(file, data, 0600); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `UPDATE battle_snapshots SET state=jsonb_set(state,'{units,0,hp}',to_jsonb((state->'units'->0->>'hp')::int-1)) WHERE deployment_id=$1 AND source_event=$2`, deployment, backup.Event)
	if err == nil {
		fmt.Println("Injected a snapshot fault into the browser acceptance match.")
	}
	return err
}
