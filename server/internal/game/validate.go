package game

import "fmt"

func Contains(bitmap uint64, cell uint8) bool {
	return cell < CellCount && bitmap&(uint64(1)<<cell) != 0
}
func adjacent(from, to uint8) bool {
	if from >= CellCount || to >= CellCount {
		return false
	}
	dx, dy := int(from%8)-int(to%8), int(from/8)-int(to/8)
	if dx < 0 {
		dx = -dx
	}
	if dy < 0 {
		dy = -dy
	}
	return dx+dy == 1
}
func clearRay(from, to, distance uint8, walls uint64) bool {
	if from >= CellCount || to >= CellCount || from == to || Contains(walls, from) {
		return false
	}
	stride := 1
	if from/8 != to/8 {
		if from%8 != to%8 {
			return false
		}
		stride = 8
	}
	steps := int(to) - int(from)
	if steps < 0 {
		steps, stride = -steps, -stride
	}
	length := steps
	if stride == 8 || stride == -8 {
		length /= 8
	}
	if length > int(distance) {
		return false
	}
	for cell := int(from) + stride; ; cell += stride {
		if Contains(walls, uint8(cell)) {
			return false
		}
		if cell == int(to) {
			return true
		}
	}
}
func ValidateState(state BattleState) error {
	rules := DefaultRules()
	if state.MapID != 1 {
		return fmt.Errorf("UnknownMap: %d", state.MapID)
	}
	if state.Round == 0 || state.Round > rules.MaxRounds {
		return fmt.Errorf("InvalidRound: %d", state.Round)
	}
	for player, value := range state.Players {
		if value.Energy > rules.MaxEnergy {
			return fmt.Errorf("InvalidPlayerState: %d", player)
		}
	}
	for slot, unit := range state.Units {
		if unit.UnitType != UnitKind(slot%3+1) || unit.HP > rules.MaxHP[slot%3] ||
			(unit.HP == 0 && unit.Cell != NoCell) || (unit.HP != 0 && unit.Cell >= CellCount) {
			return fmt.Errorf("InvalidUnitState: %d", slot)
		}
	}
	if state.Outcome > Draw || state.Reason > RevealTimeout || (state.Outcome == Ongoing) != (state.Reason == NoReason) {
		return fmt.Errorf("InvalidBattleResult")
	}
	return nil
}
func ValidateEncoding(actions [3]Action) error {
	for slot, action := range actions {
		moves := action.Kind == Move || action.Kind == Dash
		attacks := action.Kind == Attack || action.Kind == PowerShot
		invalid := action.Kind > Dash
		if moves {
			invalid = invalid || action.TargetCell != NoCell || action.PathLength == 0 || action.PathLength > 4
		} else {
			invalid = invalid || action.PathLength != 0 || (attacks && action.TargetCell >= CellCount) || (!attacks && action.TargetCell != NoCell)
		}
		for step, cell := range action.Path {
			if (step < int(action.PathLength) && cell >= CellCount) || (step >= int(action.PathLength) && cell != 0) {
				invalid = true
			}
		}
		if invalid {
			return fmt.Errorf("InvalidActionEncoding: slot %d", slot)
		}
	}
	return nil
}
func blockedCells(state BattleState) (uint64, error) {
	blocked := DefaultMap().Obstacles
	for slot, unit := range state.Units {
		if unit.HP == 0 {
			continue
		}
		if Contains(blocked, unit.Cell) {
			return 0, fmt.Errorf("InvalidUnitState: %d", slot)
		}
		blocked |= uint64(1) << unit.Cell
	}
	return blocked, nil
}
func actionCost(unit UnitState, action Action, blocked uint64) (uint8, string) {
	if unit.HP == 0 && action.Kind != Hold {
		return 0, "InvalidAction"
	}
	rules := DefaultRules()
	index := int(unit.UnitType) - 1
	switch action.Kind {
	case Hold:
		return 0, ""
	case Move, Dash:
		limit, cost := rules.MoveRange[index], uint8(0)
		if action.Kind == Dash {
			if unit.UnitType != Scout {
				return 0, "InvalidAction"
			}
			limit, cost = rules.DashRange, rules.SkillCost[index]
		}
		if action.PathLength == 0 || action.PathLength > limit || action.PathLength > 4 {
			return 0, "InvalidPath"
		}
		visited, previous := uint64(1)<<unit.Cell, unit.Cell
		for _, cell := range action.Path[:action.PathLength] {
			if !adjacent(previous, cell) || Contains(blocked|visited, cell) {
				return 0, "InvalidPath"
			}
			visited |= uint64(1) << cell
			previous = cell
		}
		return cost, ""
	case Attack, PowerShot:
		if action.Kind == PowerShot && unit.UnitType != Ranger {
			return 0, "InvalidAction"
		}
		valid := adjacent(unit.Cell, action.TargetCell)
		if unit.UnitType == Ranger {
			valid = clearRay(unit.Cell, action.TargetCell, rules.AttackRange[index], DefaultMap().Obstacles)
		}
		if !valid {
			return 0, "InvalidTarget"
		}
		if action.Kind == PowerShot {
			return rules.SkillCost[index], ""
		}
		return 0, ""
	case Shield:
		if unit.UnitType == Guardian {
			return rules.SkillCost[index], ""
		}
	}
	return 0, "InvalidAction"
}

// ValidateActions uses the unchanged round-start snapshot for the complete squad.
func ValidateActions(state BattleState, player int, actions [3]Action) (uint8, error) {
	if player < 0 || player >= 2 {
		return 0, fmt.Errorf("InvalidPlayerState: %d", player)
	}
	if err := ValidateState(state); err != nil {
		return 0, err
	}
	if err := ValidateEncoding(actions); err != nil {
		return 0, err
	}
	blocked, err := blockedCells(state)
	if err != nil {
		return 0, err
	}
	var total uint8
	for slot, action := range actions {
		unitID := player*3 + slot
		cost, issue := actionCost(state.Units[unitID], action, blocked)
		if issue != "" {
			return 0, fmt.Errorf("%s: unit %d", issue, unitID)
		}
		total += cost
	}
	if total > state.Players[player].Energy {
		return 0, fmt.Errorf("InsufficientEnergy: player %d needs %d, available %d", player, total, state.Players[player].Energy)
	}
	return total, nil
}
