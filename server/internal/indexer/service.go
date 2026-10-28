package indexer

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed schema.sql
var schema string

type observation struct {
	Head     uint64
	LastSync time.Time
	Error    string
	Blocked  bool
}

type service struct {
	cfg          config
	db           *sql.DB
	rpc          *rpc.Client
	chain        *ethclient.Client
	anchor       *types.Header
	deploymentID int64
	mu           sync.RWMutex
	observed     observation
	keeper       *keeper
	keeperState  keeperStatus
}

func Run(ctx context.Context, root, operation string) error {
	cfg, err := readConfig(root)
	if err != nil {
		return err
	}
	s := &service{cfg: cfg}
	setup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	s.db, err = sql.Open("pgx", cfg.Database)
	if err != nil {
		return fmt.Errorf("invalid PostgreSQL connection configuration; check DATABASE_URL")
	}
	defer s.db.Close()
	s.db.SetMaxOpenConns(8)
	s.db.SetMaxIdleConns(4)
	if err = s.db.PingContext(setup); err != nil {
		return fmt.Errorf("connect PostgreSQL: %w; start PostgreSQL and create the onchain_arena database, or set DATABASE_URL", err)
	}
	if _, err = s.db.ExecContext(setup, schema); err != nil {
		return fmt.Errorf("apply database schema: %w", err)
	}
	s.rpc, err = rpc.DialContext(setup, cfg.RPC)
	if err != nil {
		return err
	}
	defer s.rpc.Close()
	s.chain = ethclient.NewClient(s.rpc)
	chainID, err := s.chain.ChainID(setup)
	if err != nil {
		return err
	}
	if chainID.Cmp(new(big.Int).SetUint64(cfg.ChainID)) != 0 {
		return fmt.Errorf("RPC chain ID differs from the published deployment")
	}
	s.anchor, err = s.chain.HeaderByNumber(setup, new(big.Int).SetUint64(cfg.From))
	if err != nil {
		return fmt.Errorf("read deployment block: %w", err)
	}
	err = s.db.QueryRowContext(setup, `INSERT INTO deployments(chain_id,arena,deployment_block,deployment_hash) VALUES($1,$2,$3,$4)
		ON CONFLICT(chain_id,arena,deployment_hash) DO UPDATE SET arena=excluded.arena RETURNING id`,
		chainID.String(), cfg.Arena, cfg.From, s.anchor.Hash().Hex()).Scan(&s.deploymentID)
	if err != nil {
		return err
	}
	lock, err := s.db.Conn(setup)
	if err != nil {
		return err
	}
	defer lock.Close()
	var acquired bool
	if err = lock.QueryRowContext(setup, `SELECT pg_try_advisory_lock($1)`, s.deploymentID).Scan(&acquired); err != nil {
		return err
	}
	if !acquired {
		return fmt.Errorf("an Indexer is already running for this deployment")
	}
	// Advisory locks belong to a session, so release it before returning the connection to the pool.
	defer func() {
		cleanup, finish := context.WithTimeout(context.Background(), 3*time.Second)
		defer finish()
		_, _ = lock.ExecContext(cleanup, `SELECT pg_advisory_unlock($1)`, s.deploymentID)
	}()
	_, err = s.db.ExecContext(setup, `INSERT INTO sync_cursors(deployment_id,block_number,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
		s.deploymentID, int64(cfg.From)-1, s.anchor.ParentHash.Hex())
	if err != nil {
		return err
	}
	cancel()
	log.Printf("PostgreSQL schema ready. Indexing chain %d Arena %s from block %d (deployment %d).", cfg.ChainID, cfg.Arena, cfg.From, s.deploymentID)
	if operation != "" {
		if err = s.maintenance(ctx, root, operation); err != nil {
			return err
		}
	}
	initial, stop := context.WithTimeout(ctx, 30*time.Second)
	head, err := s.sync(initial, false, nil)
	stop()
	if err != nil {
		return fmt.Errorf("initial indexing: %w", err)
	}
	s.observed = observation{Head: head, LastSync: time.Now().UTC()}
	if cfg.KeeperEnabled {
		prepare, finish := context.WithTimeout(ctx, 15*time.Second)
		s.runKeeper(prepare)
		finish()
	}
	if !cfg.KeeperEnabled {
		log.Print("Keeper disabled. Players can still settle rounds and finalize timeouts.")
	}
	keeperReadiness := "disabled"
	if cfg.KeeperEnabled {
		keeperReadiness = "enabled"
		if s.keeperState.Error != "" {
			keeperReadiness = "unavailable; see the Keeper error above"
		}
	}
	listener, err := net.Listen("tcp", cfg.HTTP)
	if err != nil {
		return fmt.Errorf("listen for read API: %w", err)
	}
	server := &http.Server{Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 45 * time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); s.follow(workerCtx) }()
	log.Printf("Local Arena is ready. Read API: http://%s. Indexed block %d. Keeper: %s. Create rooms in the browser; the host clicks Start game.", cfg.HTTP, head, keeperReadiness)
	select {
	case <-ctx.Done():
		err = nil
	case err = <-done:
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
	}
	stopWorker()
	shutdown, finish := context.WithTimeout(context.Background(), 5*time.Second)
	defer finish()
	if shutdownErr := server.Shutdown(shutdown); shutdownErr != nil {
		_ = server.Close()
		if err == nil {
			err = shutdownErr
		}
	}
	<-workerDone
	return err
}

func (s *service) follow(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		request, cancel := context.WithTimeout(ctx, 30*time.Second)
		head, err := s.sync(request, false, nil)
		cancel()
		if ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		previous := s.observed.Error
		if err == nil {
			s.observed = observation{Head: head, LastSync: time.Now().UTC()}
		} else {
			s.observed.Error = err.Error()
			s.observed.Blocked = errors.Is(err, errFork) || errors.Is(err, errDeploymentChanged)
		}
		s.mu.Unlock()
		if err != nil && err.Error() != previous {
			log.Printf("Indexer paused: %v", err)
		}
		if err == nil && previous != "" {
			log.Print("Indexer caught up after the previous error.")
		}
		if errors.Is(err, errDeploymentChanged) {
			return
		}
		if err == nil && s.cfg.KeeperEnabled {
			request, finish := context.WithTimeout(ctx, 15*time.Second)
			s.runKeeper(request)
			finish()
		}
	}
}
