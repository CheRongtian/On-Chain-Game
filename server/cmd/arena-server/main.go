package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"onchainarena/server/internal/indexer"
	"onchainarena/server/internal/offline"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Arena command failed:", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		args = []string{"serve"}
	}
	root, err := filepath.Abs("..")
	if err != nil {
		return err
	}
	switch args[0] {
	case "browser-fault":
		if len(args) != 2 {
			return fmt.Errorf("browser-fault requires corrupt or restore")
		}
		return indexer.BrowserFault(root, args[1])
	case "check-indexer":
		if len(args) > 2 || len(args) == 2 && args[1] != "keeper" {
			return fmt.Errorf("check-indexer accepts only the optional keeper scope")
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return indexer.Check(ctx, root, len(args) == 2)
	case "serve":
		operation := ""
		if len(args) > 2 {
			return fmt.Errorf("serve accepts at most one indexing operation")
		}
		if len(args) == 2 {
			operation = args[1]
			if operation != "rescan" && operation != "reindex" {
				return fmt.Errorf("unknown indexing operation %q", operation)
			}
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return indexer.Run(ctx, root, operation)
	case "status":
		if len(args) != 1 {
			return fmt.Errorf("status takes no additional arguments")
		}
		return indexer.Status(root)
	case "verify":
		if len(args) != 1 {
			return fmt.Errorf("verify takes no additional arguments")
		}
		started := time.Now()
		counts, err := offline.VerifyVectors(root)
		if err != nil {
			return err
		}
		fmt.Printf("Go vectors matched: %d results, %d states, %d battles, %d protocol cases.\n", counts.Results, counts.Hashes, counts.Battles, counts.Protocol)
		fmt.Printf("Go vector baseline: %s elapsed.\n", time.Since(started))
		if err := offline.RunSolidityVectors(root, os.Stdout); err != nil {
			return err
		}
		fmt.Println("Solidity and Go matched the same fixed vectors without RPC or database access.")
		return nil
	case "simulate":
		flags := flag.NewFlagSet("simulate", flag.ContinueOnError)
		seed := flags.Int64("seed", 42, "Repeatable random seed")
		games := flags.Int("games", 10, "Number of complete offline games")
		input := flags.String("input", "", "Saved simulation or single-round reproduction JSON")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("unexpected simulation arguments: %v", flags.Args())
		}
		var simulation offline.Simulation
		started := time.Now()
		if *input != "" {
			path := *input
			if !filepath.IsAbs(path) {
				path = filepath.Join(root, path)
			}
			simulation, err = offline.ReplayInput(path)
		} else {
			simulation, err = offline.Simulate(*seed, *games, filepath.Join(root, ".local", "simulation"))
		}
		if err != nil {
			return err
		}
		elapsed := time.Since(started)
		fmt.Printf("Offline simulation: seed %d, %d games, %d rounds; A wins %d, B wins %d, draws %d.\n", simulation.Seed, simulation.Games, simulation.Rounds, simulation.Outcomes[1], simulation.Outcomes[2], simulation.Outcomes[3])
		fmt.Printf("Go simulation baseline: %s, %.0f rounds/second. Timing is separate from the deterministic records.\n", elapsed, float64(simulation.Rounds)/elapsed.Seconds())
		if err := offline.CompareSimulation(root, simulation, os.Stdout); err != nil {
			return err
		}
		fmt.Println("Every generated round matched the independent Solidity resolver. Simulation results do not determine official games.")
		return nil
	default:
		return fmt.Errorf("unknown command %q; use serve, status, verify, simulate, or check-indexer", args[0])
	}
}
