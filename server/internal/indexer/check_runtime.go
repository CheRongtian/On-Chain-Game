package indexer

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

func (c *checker) signalIndexer(pid int, signal string) error {
	if pid <= 1 {
		return fmt.Errorf("expected a Go child process inside the API container, got %d", pid)
	}
	// Cleanup must still be able to resume a process after acceptance is interrupted.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "docker", "compose", "--project-name", "onchain-arena",
		"--project-directory", c.root, "-f", filepath.Join(c.root, "compose.yaml"),
		"exec", "-T", "api", "sh", "-c", `kill "-$1" "$2"`, "sh", signal, strconv.Itoa(pid))
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("signal Go inside the API container: %w: %s", err, output)
	}
	return nil
}
