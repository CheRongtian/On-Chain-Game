package game

import (
	"fmt"
	"math/rand"
)

// Enumeration order is fixed so seed reproducibility never depends on map iteration.
func LegalActions(state BattleState, unitID int) ([]Action, error) {
	if err := ValidateState(state); err != nil {
		return nil, err
	}
	if state.Outcome != Ongoing {
		return nil, fmt.Errorf("InvalidBattleResult: match is finished")
	}
	if unitID < 0 || unitID >= UnitCount {
		return nil, fmt.Errorf("invalid unit ID: %d", unitID)
	}
	blocked, err := blockedCells(state)
	if err != nil {
		return nil, err
	}
	unit := state.Units[unitID]
	actions := []Action{{TargetCell: NoCell}}
	if unit.HP == 0 {
		return actions, nil
	}
	for cell := uint8(0); cell < CellCount; cell++ {
		for _, kind := range []ActionKind{Attack, PowerShot} {
			action := Action{Kind: kind, TargetCell: cell}
			if _, issue := actionCost(unit, action, blocked); issue == "" {
				actions = append(actions, action)
			}
		}
	}
	if unit.UnitType == Guardian {
		actions = append(actions, Action{Kind: Shield, TargetCell: NoCell})
	}
	var walk func(Action, uint8, uint64, uint8)
	walk = func(action Action, previous uint8, visited uint64, limit uint8) {
		if action.PathLength >= limit {
			return
		}
		for _, cell := range []int{int(previous) - 8, int(previous) + 1, int(previous) + 8, int(previous) - 1} {
			if cell < 0 || cell >= CellCount || !adjacent(previous, uint8(cell)) || Contains(blocked|visited, uint8(cell)) {
				continue
			}
			next := action
			next.Path[next.PathLength] = uint8(cell)
			next.PathLength++
			actions = append(actions, next)
			walk(next, uint8(cell), visited|uint64(1)<<cell, limit)
		}
	}
	walk(Action{Kind: Move, TargetCell: NoCell}, unit.Cell, uint64(1)<<unit.Cell, DefaultRules().MoveRange[unit.UnitType-1])
	if unit.UnitType == Scout {
		walk(Action{Kind: Dash, TargetCell: NoCell}, unit.Cell, uint64(1)<<unit.Cell, DefaultRules().DashRange)
	}
	return actions, nil
}
func GenerateActions(state BattleState, player int, rng *rand.Rand) ([3]Action, error) {
	orders := HoldActions()
	if player < 0 || player > 1 {
		return orders, fmt.Errorf("invalid player: %d", player)
	}
	if rng == nil {
		return orders, fmt.Errorf("a seeded random source is required")
	}
	remaining := state.Players[player].Energy
	blocked, err := blockedCells(state)
	if err != nil {
		return orders, err
	}
	for slot := range orders {
		unitID := player*3 + slot
		legal, err := LegalActions(state, unitID)
		if err != nil {
			return orders, err
		}
		var groups [6][]Action
		for _, action := range legal {
			cost, _ := actionCost(state.Units[unitID], action, blocked)
			if cost <= remaining {
				groups[action.Kind] = append(groups[action.Kind], action)
			}
		}
		var kinds []int
		for kind, entries := range groups {
			if len(entries) > 0 {
				kinds = append(kinds, kind)
			}
		}
		choices := groups[kinds[rng.Intn(len(kinds))]]
		orders[slot] = choices[rng.Intn(len(choices))]
		cost, _ := actionCost(state.Units[unitID], orders[slot], blocked)
		remaining -= cost
	}
	_, err = ValidateActions(state, player, orders)
	return orders, err
}
