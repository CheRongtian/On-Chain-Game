package offline

import (
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"

	"onchainarena/server/internal/game"
)

func RunSolidityVectors(root string, output io.Writer) error {
	for _, script := range []string{"CheckResults", "CheckBattle"} {
		if err := runForge(root, output, "script/"+script+".s.sol:"+script, "--sig", "run()"); err != nil {
			return err
		}
	}
	return runForge(root, output, "script/CompareRules.s.sol:CompareRules", "--sig", "protocol()")
}
func runForge(root string, output io.Writer, script string, args ...string) error {
	arguments := []string{"script", script, "--offline", "--use", filepath.Join(root, ".local", "bin", "solc-0.8.30")}
	arguments = append(arguments, args...)
	command := exec.Command("forge", arguments...)
	command.Dir = filepath.Join(root, "contracts")
	command.Stdout, command.Stderr = output, output
	if err := command.Run(); err != nil {
		return fmt.Errorf("offline Solidity reference failed: %w", err)
	}
	return nil
}
func CompareSimulation(root string, simulation Simulation, output io.Writer) error {
	directory := filepath.Join(root, ".local", "simulation")
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(directory, "simulation.json"), simulation); err != nil {
		return err
	}
	encoded, err := game.EncodeComparisons(simulation.Cases)
	if err != nil {
		return err
	}
	input, report := filepath.Join(directory, "rounds.abi"), filepath.Join(directory, "comparison.json")
	if err := os.WriteFile(input, encoded, 0644); err != nil {
		return err
	}
	if err := runForge(root, output, "script/CompareRules.s.sol:CompareRules", "--sig", "run(string,string)", input, report); err != nil {
		return err
	}
	var result struct {
		Matched   bool      `json:"matched"`
		Rejected  bool      `json:"rejected"`
		Error     string    `json:"error"`
		CaseIndex int       `json:"caseIndex"`
		Word      int       `json:"word"`
		Expected  game.Hash `json:"expected"`
		Actual    game.Hash `json:"actual"`
	}
	if err := readJSON(report, &result); err != nil {
		return err
	}
	if result.Matched {
		return nil
	}
	if result.CaseIndex < 0 || result.CaseIndex >= len(simulation.Cases) {
		return fmt.Errorf("Solidity returned an invalid comparison index")
	}
	entry := simulation.Cases[result.CaseIndex]
	// A pure resolver needs only this round's full input; earlier games and rounds are removed.
	repro := Simulation{Seed: simulation.Seed, Games: 1, Rounds: 1, InitialState: entry.State, Cases: []game.Comparison{entry}}
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
