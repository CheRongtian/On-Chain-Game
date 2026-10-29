package indexer

import (
	"context"
	"fmt"
	"time"
)

func (s *service) ensureIndexerLock(ctx context.Context) error {
	if s.indexerLock != nil {
		if err := s.indexerLock.PingContext(ctx); err == nil {
			return nil
		}
		_ = s.indexerLock.Close()
		s.indexerLock = nil
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	var acquired bool
	if err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, s.deploymentID).Scan(&acquired); err != nil || !acquired {
		conn.Close()
		if err != nil {
			return err
		}
		return fmt.Errorf("another Indexer owns this deployment; waiting for its database session lock")
	}
	s.indexerLock = conn
	return nil
}

func (s *service) releaseIndexerLock() {
	if s.indexerLock == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = s.indexerLock.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, s.deploymentID)
	_ = s.indexerLock.Close()
}
