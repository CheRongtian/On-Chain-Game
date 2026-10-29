package offline

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"onchainarena/server/internal/game"
)

type comparisonResult struct {
	Matched   bool      `json:"matched"`
	Rejected  bool      `json:"rejected"`
	Error     string    `json:"error"`
	CaseIndex int       `json:"caseIndex"`
	Word      int       `json:"word"`
	Expected  game.Hash `json:"expected"`
	Actual    game.Hash `json:"actual"`
}

func compareSolidity(ctx context.Context, root string, entries []game.Comparison, output io.Writer) (comparisonResult, error) {
	var result comparisonResult
	directory := filepath.Join(root, ".local", "simulation")
	encoded, err := game.EncodeComparisons(entries)
	if err != nil {
		return result, err
	}
	input, report := filepath.Join(directory, "rounds.abi"), filepath.Join(directory, "comparison.json")
	if err = os.WriteFile(input, encoded, 0644); err != nil {
		return result, err
	}
	if err = runForge(ctx, root, output, "script/CompareRules.s.sol:CompareRules", "--sig", "run(string,string)", input, report); err != nil {
		return result, err
	}
	if err = readJSON(report, &result); err != nil {
		return result, err
	}
	if !result.Matched && (result.CaseIndex < 0 || result.CaseIndex >= len(entries)) {
		return result, fmt.Errorf("Solidity returned an invalid comparison index")
	}
	return result, nil
}

// Keep only reductions that still disagree with the independent Solidity implementation.
func shrinkDifference(ctx context.Context, root string, entry game.Comparison, result comparisonResult, output io.Writer) (game.Comparison, comparisonResult, error) {
	try := func(candidate game.Comparison) (bool, error) {
		next, summary, err := game.Resolve(candidate.State, candidate.ActionsA, candidate.ActionsB)
		if err != nil {
			return false, nil
		}
		hash, err := game.StateHash(candidate.Context, next)
		if err != nil {
			return false, err
		}
		candidate.ExpectedState, candidate.ExpectedSummary, candidate.ExpectedHash = next, summary, hash
		comparison, err := compareSolidity(ctx, root, []game.Comparison{candidate}, output)
		if err != nil {
			return false, err
		}
		if comparison.Matched {
			return false, nil
		}
		entry, result = candidate, comparison
		return true, nil
	}
	for player := 0; player < 2; player++ {
		for slot := 0; slot < 3; slot++ {
			candidate := entry
			orders := &candidate.ActionsA
			if player == 1 {
				orders = &candidate.ActionsB
			}
			if orders[slot].Kind == game.Hold {
				continue
			}
			orders[slot] = game.Action{TargetCell: game.NoCell}
			changed, err := try(candidate)
			if err != nil {
				return entry, result, err
			}
			if changed {
				continue
			}
			for {
				candidate = entry
				orders = &candidate.ActionsA
				if player == 1 {
					orders = &candidate.ActionsB
				}
				action := &orders[slot]
				if action.PathLength <= 1 {
					break
				}
				action.PathLength--
				action.Path[action.PathLength] = 0
				changed, err = try(candidate)
				if err != nil {
					return entry, result, err
				}
				if !changed {
					break
				}
			}
		}
	}
	for slot := range entry.State.Units {
		if entry.State.Units[slot].HP <= 1 {
			continue
		}
		candidate := entry
		candidate.State.Units[slot].HP = 1
		if _, err := try(candidate); err != nil {
			return entry, result, err
		}
	}
	// The last discarded candidate may have matched; retain the reduced failing comparison.
	result, err := compareSolidity(ctx, root, []game.Comparison{entry}, output)
	if err == nil && result.Matched {
		err = fmt.Errorf("the reduced input no longer reproduces the original difference")
	}
	return entry, result, err
}
