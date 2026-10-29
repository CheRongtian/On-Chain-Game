package offline

import (
	"context"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"

	"onchainarena/server/internal/game"
)

func RunSolidityVectors(ctx context.Context, root string, output io.Writer) error {
	for _, script := range []string{"CheckResults", "CheckBattle"} {
		if err := runForge(ctx, root, output, "script/"+script+".s.sol:"+script, "--sig", "run()"); err != nil {
			return err
		}
	}
	return runForge(ctx, root, output, "script/CompareRules.s.sol:CompareRules", "--sig", "protocol()")
}
func runForge(ctx context.Context, root string, output io.Writer, script string, args ...string) error {
	arguments := []string{"script", script, "--offline", "--use", filepath.Join(root, ".local", "bin", "solc-0.8.30")}
	arguments = append(arguments, args...)
	command := exec.CommandContext(ctx, "forge", arguments...)
	command.Dir = filepath.Join(root, "contracts")
	command.Stdout, command.Stderr = output, output
	if err := command.Run(); err != nil {
		return fmt.Errorf("offline Solidity reference failed: %w", err)
	}
	return nil
}
func CompareSimulation(ctx context.Context, root string, simulation Simulation, output io.Writer) error {
	directory := filepath.Join(root, ".local", "simulation")
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(directory, "simulation.json"), simulation); err != nil {
		return err
	}
	result, err := compareSolidity(ctx, root, simulation.Cases, output)
	if err != nil {
		return err
	}
	if result.Matched {
		return nil
	}
	entry := simulation.Cases[result.CaseIndex]
	repro := Simulation{Seed: simulation.Seed, Games: 1, Rounds: 1, InitialState: entry.State, Cases: []game.Comparison{entry}}
	if err := writeJSON(filepath.Join(directory, "repro-original.json"), repro); err != nil {
		return err
	}
	entry, result, err = shrinkDifference(ctx, root, entry, result, output)
	if err != nil {
		return fmt.Errorf("difference found; shrinking failed: %w; original reproduction retained", err)
	}
	repro.InitialState, repro.Cases[0] = entry.State, entry
	reproPath := filepath.Join(directory, "repro.json")
	if err := writeJSON(reproPath, repro); err != nil {
		return err
	}
	if result.Rejected {
		return fmt.Errorf("%s: Go accepted actions that Solidity rejected (%s); single-round reproduction: %s", entry.Name, result.Error, reproPath)
	}
	want, got := result.Expected.String(), result.Actual.String()
	if result.Word < 44 {
		want = new(big.Int).SetBytes(result.Expected[:]).String()
		got = new(big.Int).SetBytes(result.Actual[:]).String()
	}
	return fmt.Errorf("%s, %s: Go %s, Solidity %s; single-round reproduction: %s", entry.Name, game.ResultField(result.Word), want, got, reproPath)
}
