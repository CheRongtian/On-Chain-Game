package offline

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"

	"onchainarena/server/internal/game"
)

type Simulation struct {
	Seed         int64             `json:"seed"`
	Games        int               `json:"games"`
	Outcomes     [4]int            `json:"outcomes"`
	Rounds       int               `json:"rounds"`
	InitialState game.BattleState  `json:"initialState"`
	Cases        []game.Comparison `json:"cases"`
}

func Simulate(seed int64, games int, output string) (Simulation, error) {
	result := Simulation{Seed: seed, Games: games, InitialState: game.InitialState(), Cases: []game.Comparison{}}
	if games <= 0 {
		return result, fmt.Errorf("games must be positive")
	}
	rng := rand.New(rand.NewSource(seed))
	var arena game.Address
	arena[18], arena[19] = 0x11, 0xce
	arena[17] = 0x0a
	for index := 0; index < games; index++ {
		context := game.MatchContext{ChainID: game.U256(31337), Arena: arena, MatchID: game.U256(uint64(index + 1))}
		state := result.InitialState
		for state.Outcome == game.Ongoing {
			a, err := game.GenerateActions(state, 0, rng)
			if err != nil {
				return result, saveGenerationFailure(output, seed, index, context, state, a, game.HoldActions(), err)
			}
			b, err := game.GenerateActions(state, 1, rng)
			if err != nil {
				return result, saveGenerationFailure(output, seed, index, context, state, a, b, err)
			}
			next, summary, err := game.Resolve(state, a, b)
			if err != nil {
				return result, saveGenerationFailure(output, seed, index, context, state, a, b, err)
			}
			hash, err := game.StateHash(context, next)
			if err != nil {
				return result, err
			}
			result.Cases = append(result.Cases, game.Comparison{Name: fmt.Sprintf("seed_%d_game_%d_round_%d", seed, index+1, state.Round), Context: context,
				State: state, ActionsA: a, ActionsB: b, ExpectedState: next, ExpectedSummary: summary, ExpectedHash: hash})
			result.Rounds++
			state = next
		}
		result.Outcomes[state.Outcome]++
	}
	return result, nil
}
func saveGenerationFailure(output string, seed int64, index int, context game.MatchContext, state game.BattleState, a, b [3]game.Action, cause error) error {
	if err := os.MkdirAll(output, 0755); err != nil {
		return fmt.Errorf("%w; save reproduction: %v", cause, err)
	}
	path := filepath.Join(output, "repro.json")
	repro := Simulation{Seed: seed, Games: 1, InitialState: state, Cases: []game.Comparison{{Name: fmt.Sprintf("seed_%d_game_%d_round_%d", seed, index+1, state.Round), Context: context, State: state, ActionsA: a, ActionsB: b}}}
	if err := writeJSON(path, repro); err != nil {
		return fmt.Errorf("%w; save reproduction: %v", cause, err)
	}
	return fmt.Errorf("seed %d, game %d, round %d: %w; reproduction: %s", seed, index+1, state.Round, cause, path)
}

// A saved round contains the complete start state, so a failure can be replayed in isolation.
func ReplayInput(path string) (Simulation, error) {
	var result Simulation
	if err := readJSON(path, &result); err != nil {
		return result, err
	}
	if len(result.Cases) == 0 {
		return result, fmt.Errorf("reproduction contains no rounds")
	}
	result.Rounds, result.Outcomes = 0, [4]int{}
	for index := range result.Cases {
		entry := &result.Cases[index]
		next, summary, err := game.Resolve(entry.State, entry.ActionsA, entry.ActionsB)
		if err != nil {
			return result, fmt.Errorf("%s: %w", entry.Name, err)
		}
		hash, err := game.StateHash(entry.Context, next)
		if err != nil {
			return result, err
		}
		entry.ExpectedState, entry.ExpectedSummary, entry.ExpectedHash = next, summary, hash
		result.Rounds++
		if next.Outcome != game.Ongoing {
			result.Outcomes[next.Outcome]++
		}
	}
	return result, nil
}
