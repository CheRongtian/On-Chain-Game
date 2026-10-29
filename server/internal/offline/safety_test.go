package offline

import (
	"math/rand"
	"testing"

	"onchainarena/server/internal/game"
)

func TestRejectInvalidRulesInput(t *testing.T) {
	for _, entry := range rejectionCases() {
		t.Run(entry.Name, func(t *testing.T) {
			if _, _, err := game.Resolve(entry.State, entry.ActionsA, entry.ActionsB); err == nil {
				t.Fatal("invalid input was accepted")
			}
		})
	}
}

func FuzzGeneratedGames(f *testing.F) {
	for _, seed := range []uint64{0, 1, 42, 2026, ^uint64(0)} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, seed uint64) {
		rng := rand.New(rand.NewSource(int64(seed)))
		state := game.InitialState()
		for round := 0; round < int(game.DefaultRules().MaxRounds); round++ {
			a, err := game.GenerateActions(state, 0, rng)
			if err != nil {
				t.Fatal(err)
			}
			b, err := game.GenerateActions(state, 1, rng)
			if err != nil {
				t.Fatal(err)
			}
			next, summary, err := game.Resolve(state, a, b)
			if err != nil {
				t.Fatalf("seed %d, round %d: %v", seed, state.Round, err)
			}
			assertTransition(t, state, next, summary)
			state = next
			if state.Outcome != game.Ongoing {
				if _, _, err := game.Resolve(state, a, b); err == nil {
					t.Fatal("finished state resolved again")
				}
				return
			}
		}
		t.Fatal("legal game exceeded its round limit")
	})
}

func FuzzActionInput(f *testing.F) {
	seed := make([]byte, 21)
	for slot := 0; slot < 3; slot++ {
		seed[slot*7+1] = game.NoCell
	}
	f.Add(seed)
	malformed := append([]byte(nil), seed...)
	malformed[0] = 6
	f.Add(malformed)
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) != 21 {
			return
		}
		actions := game.HoldActions()
		for slot := range actions {
			offset := slot * 7
			actions[slot] = game.Action{Kind: game.ActionKind(data[offset]), TargetCell: data[offset+1], PathLength: data[offset+2]}
			copy(actions[slot].Path[:], data[offset+3:offset+7])
		}
		state := game.InitialState()
		_, validation := game.ValidateActions(state, 0, actions)
		next, summary, err := game.Resolve(state, actions, game.HoldActions())
		if validation != nil {
			if err == nil {
				t.Fatal("resolver accepted rejected player orders")
			}
			return
		}
		if err != nil {
			t.Fatalf("resolver rejected valid orders: %v", err)
		}
		assertTransition(t, state, next, summary)
	})
}

func assertTransition(t *testing.T, before, after game.BattleState, summary game.ResolutionSummary) {
	t.Helper()
	if err := game.ValidateState(after); err != nil {
		t.Fatal(err)
	}
	occupied := game.DefaultMap().Obstacles
	for slot, unit := range after.Units {
		previous := before.Units[slot]
		if unit.HP > previous.HP || unit.UnitType != previous.UnitType {
			t.Fatalf("unit %d changed HP or type illegally", slot)
		}
		if summary.DamageTaken[slot] != previous.HP-unit.HP {
			t.Fatalf("unit %d damage accounting differs", slot)
		}
		if unit.HP == 0 {
			continue
		}
		if game.Contains(occupied, unit.Cell) {
			t.Fatalf("unit %d overlaps a live unit or wall", slot)
		}
		occupied |= uint64(1) << unit.Cell
	}
	totalPoints := 0
	for player, state := range after.Players {
		previous := before.Players[player]
		if int(state.Energy) != int(previous.Energy)-int(summary.EnergySpent[player])+int(summary.EnergyGained[player]) {
			t.Fatalf("player %d energy accounting differs", player)
		}
		gained := int(state.VictoryPoints) - int(previous.VictoryPoints)
		if gained < 0 || gained > 2 || gained != int(summary.VictoryPointsGained[player]) || state.VictoryPoints > 12 {
			t.Fatalf("player %d scoring differs", player)
		}
		totalPoints += gained
	}
	if totalPoints != 0 && totalPoints != 2 {
		t.Fatal("both players scored together")
	}
	expectedRound := before.Round
	if after.Outcome == game.Ongoing {
		expectedRound++
	}
	if after.Round != expectedRound {
		t.Fatal("round advanced incorrectly")
	}
}
