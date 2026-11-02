package indexer

import (
	"context"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

func (s *service) attachSource(ctx context.Context) error {
	var err error
	s.rpc, err = rpc.DialContext(ctx, s.cfg.RPC)
	if err != nil {
		return err
	}
	s.chain = ethclient.NewClient(s.rpc)
	chainID, err := s.chain.ChainID(ctx)
	if err != nil {
		return err
	}
	if chainID.Cmp(new(big.Int).SetUint64(s.cfg.ChainID)) != 0 {
		return fmt.Errorf("RPC chain ID differs from the published deployment")
	}
	s.anchor, err = s.chain.HeaderByNumber(ctx, new(big.Int).SetUint64(s.cfg.From))
	if err != nil {
		return fmt.Errorf("read deployment block: %w", err)
	}
	if s.anchor.Hash().Hex() != s.cfg.DeploymentHash {
		return fmt.Errorf("the published deployment block differs from its chain")
	}
	err = s.db.QueryRowContext(ctx, `INSERT INTO deployments(chain_id,arena,deployment_block,deployment_hash) VALUES($1,$2,$3,$4)
		ON CONFLICT(chain_id,arena,deployment_hash) DO UPDATE SET arena=excluded.arena RETURNING id`,
		chainID.String(), s.cfg.Arena, s.cfg.From, s.anchor.Hash().Hex()).Scan(&s.deploymentID)
	if err != nil {
		return err
	}
	if err = s.ensureIndexerLock(ctx); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO sync_cursors(deployment_id,block_number,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
		s.deploymentID, int64(s.cfg.From)-1, s.anchor.ParentHash.Hex())
	return err
}

func (s *service) openArchives(ctx context.Context, root string) error {
	_, err := os.Stat(filepath.Join(root, "client/public/legacy-deployment.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	cfg, err := readDeploymentConfig(root, "legacy-deployment.json")
	if err != nil {
		return fmt.Errorf("read old deployment: %w", err)
	}
	cfg.KeeperEnabled = false
	legacy := &service{cfg: cfg, db: s.db}
	s.archives = map[string]*service{cfg.DeploymentHash: legacy}
	if err = legacy.attachSource(ctx); err != nil {
		return fmt.Errorf("attach old chain history: %w", err)
	}
	head, err := legacy.sync(ctx, false, nil)
	if err != nil {
		return fmt.Errorf("index old chain history: %w", err)
	}
	legacy.observed = observation{Head: head, Indexed: int64(head), LastSync: time.Now().UTC()}
	return nil
}

func (s *service) closeSource() {
	for _, source := range s.archives {
		source.closeSource()
	}
	s.releaseIndexerLock()
	if s.rpc != nil {
		s.rpc.Close()
	}
}
