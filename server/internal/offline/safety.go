package offline

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"onchainarena/server/internal/game"
)

type gasSample struct {
	Name          string `json:"name"`
	Execution     uint64 `json:"measuredCallGas"`
	WithIntrinsic uint64 `json:"withIntrinsicUpperBound"`
	Budget        uint64 `json:"initialBudget"`
	Limit         uint64 `json:"localBlockGasLimit"`
}

type safetyReport struct {
	Status             string      `json:"status"`
	Error              string      `json:"error,omitempty"`
	GoVersion          string      `json:"goVersion"`
	ConfiguredCompiler string      `json:"configuredCompiler"`
	Started            time.Time   `json:"startedAt"`
	Finished           time.Time   `json:"finishedAt"`
	Seeds              []int64     `json:"matchedSeeds"`
	Games              int         `json:"matchedGames"`
	Rounds             int         `json:"matchedRounds"`
	Rejected           []string    `json:"rejectedInputs"`
	Gas                []gasSample `json:"gasSamples"`
	BudgetMisses       []string    `json:"initialBudgetMisses"`
}

// Called by the existing backend test dispatcher after Foundry and Go fuzzing finish.
func Safety(ctx context.Context, root string, output io.Writer) (failure error) {
	directory := filepath.Join(root, ".local", "safety")
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	report := safetyReport{Status: "running", GoVersion: runtime.Version(), ConfiguredCompiler: "Solidity 0.8.30; Cancun; optimizer 200", Started: time.Now().UTC(), Seeds: []int64{}, Rejected: []string{}, Gas: []gasSample{}, BudgetMisses: []string{}}
	defer func() {
		report.Finished = time.Now().UTC()
		if failure != nil {
			report.Status, report.Error = "failed", failure.Error()
		} else {
			report.Status = "passed"
		}
		if err := writeJSON(filepath.Join(directory, "acceptance.json"), report); err != nil {
			failure = fmt.Errorf("safety result %v; save report: %w", failure, err)
		}
	}()
	counts, err := VerifyVectors(root)
	if err != nil {
		return err
	}
	if err = RunSolidityVectors(ctx, root, output); err != nil {
		return err
	}
	fmt.Fprintf(output, "PASS: fixed Go and Solidity references: %d battles, %d states, %d results, %d commitments.\n", counts.Battles, counts.Hashes, counts.Results, counts.Protocol)
	for _, seed := range []int64{0, 42, 2026, 8675309} {
		if err = ctx.Err(); err != nil {
			return err
		}
		simulation, err := Simulate(seed, 8, directory)
		if err != nil {
			return err
		}
		if err = writeJSON(filepath.Join(directory, fmt.Sprintf("seed-%d.json", seed)), simulation); err != nil {
			return err
		}
		if err = CompareSimulation(ctx, root, simulation, output); err != nil {
			return err
		}
		report.Seeds = append(report.Seeds, seed)
		report.Games += simulation.Games
		report.Rounds += simulation.Rounds
		fmt.Fprintf(output, "PASS: independent long-sequence comparison: seed=%d games=%d rounds=%d; every intermediate state, summary, and hash matched.\n", seed, simulation.Games, simulation.Rounds)
	}
	entries := rejectionCases()
	for _, entry := range entries {
		if _, _, err = game.Resolve(entry.State, entry.ActionsA, entry.ActionsB); err == nil {
			return fmt.Errorf("Go accepted invalid fixture %s", entry.Name)
		}
	}
	if err = writeJSON(filepath.Join(directory, "rejections.json"), entries); err != nil {
		return err
	}
	input, resultPath := filepath.Join(directory, "rejections.abi"), filepath.Join(directory, "rejection-comparison.json")
	if err = os.WriteFile(input, game.EncodeRejections(entries), 0644); err != nil {
		return err
	}
	if err = runForge(ctx, root, output, "script/CompareRules.s.sol:CompareRules", "--sig", "reject(string,string)", input, resultPath); err != nil {
		return err
	}
	var result comparisonResult
	if err = readJSON(resultPath, &result); err != nil {
		return err
	}
	if !result.Matched {
		if result.CaseIndex < 0 || result.CaseIndex >= len(entries) {
			return fmt.Errorf("invalid rejection comparison index")
		}
		return fmt.Errorf("Solidity accepted or panicked on invalid fixture %s (error %s)", entries[result.CaseIndex].Name, result.Error)
	}
	for _, entry := range entries {
		report.Rejected = append(report.Rejected, entry.Name)
	}
	fmt.Fprintf(output, "PASS: Go and Solidity rejected all %d malformed state/order fixtures without a Solidity panic.\n", len(entries))
	for _, name := range []string{"commit-first", "commit-second", "reveal-first", "reveal-second", "settle-all-skills", "settle-six-attacks", "settle-shared-destinations", "settle-maximum-round", "settle-victory-threshold", "commit-timeout", "reveal-timeout"} {
		var sample gasSample
		if err = readJSON(filepath.Join(directory, "gas-"+name+".json"), &sample); err != nil {
			return err
		}
		if sample.Name != name || sample.Execution == 0 || sample.WithIntrinsic < sample.Execution || sample.WithIntrinsic >= sample.Limit {
			return fmt.Errorf("invalid or over-limit gas sample %s", name)
		}
		report.Gas = append(report.Gas, sample)
		fmt.Fprintf(output, "Gas %s: measured call=%d; including intrinsic allowance=%d; local block limit=%d.\n", name, sample.Execution, sample.WithIntrinsic, sample.Limit)
		if sample.Budget > 0 && sample.WithIntrinsic >= sample.Budget {
			report.BudgetMisses = append(report.BudgetMisses, name)
			fmt.Fprintf(output, "GAS BUDGET EXCEEDED: %s measured upper bound %d; target below %d.\n", name, sample.WithIntrinsic, sample.Budget)
		}
	}
	if len(report.BudgetMisses) > 0 {
		return fmt.Errorf("gas budgets exceeded: %v", report.BudgetMisses)
	}
	var reads struct {
		Cold uint64 `json:"coldExecutionGas"`
		Warm uint64 `json:"warmExecutionGas"`
	}
	if err = readJSON(filepath.Join(directory, "gas-reads.json"), &reads); err != nil {
		return err
	}
	if reads.Cold == 0 || reads.Warm == 0 || reads.Warm >= reads.Cold {
		return fmt.Errorf("repeated-read gas sample did not demonstrate warm access")
	}
	fmt.Fprintf(output, "PASS: repeated state access measured cold=%d warm=%d execution gas.\n", reads.Cold, reads.Warm)
	fmt.Fprintf(output, "PASS: safety comparisons completed; %d games, %d rounds, %d rejection fixtures, %d transaction gas samples. All configured gas budgets passed. Local safety evidence saved.\n", report.Games, report.Rounds, len(report.Rejected), len(report.Gas))
	return nil
}
