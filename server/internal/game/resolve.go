package game

import "fmt"

func Evaluate(state BattleState) (Outcome, EndReason, error) {
	if err := ValidateState(state); err != nil {
		return Ongoing, NoReason, err
	}
	if state.Outcome != Ongoing {
		return state.Outcome, state.Reason, nil
	}
	var hp [2]int
	for slot, unit := range state.Units {
		hp[slot/3] += int(unit.HP)
	}
	if hp[0] == 0 && hp[1] == 0 {
		return Draw, MutualElimination, nil
	}
	if hp[0] == 0 {
		return PlayerB, Elimination, nil
	}
	if hp[1] == 0 {
		return PlayerA, Elimination, nil
	}
	rules := DefaultRules()
	reason := NoReason
	if state.Players[0].VictoryPoints >= rules.VictoryThreshold || state.Players[1].VictoryPoints >= rules.VictoryThreshold {
		reason = VictoryPoints
	} else if state.Round == rules.MaxRounds {
		reason = RoundLimit
	}
	if reason == NoReason {
		return Ongoing, NoReason, nil
	}
	for _, scores := range [][2]int{{int(state.Players[0].VictoryPoints), int(state.Players[1].VictoryPoints)}, hp} {
		if scores[0] > scores[1] {
			return PlayerA, reason, nil
		}
		if scores[1] > scores[0] {
			return PlayerB, reason, nil
		}
	}
	return Draw, reason, nil
}

// Fixed arrays give the resolver an independent value copy of its input state.
func Resolve(initial BattleState, actionsA, actionsB [3]Action) (BattleState, ResolutionSummary, error) {
	var summary ResolutionSummary
	if initial.Outcome != Ongoing {
		return BattleState{}, summary, fmt.Errorf("InvalidBattleResult: match is finished")
	}
	for player, actions := range [2][3]Action{actionsA, actionsB} {
		cost, err := ValidateActions(initial, player, actions)
		if err != nil {
			return BattleState{}, summary, err
		}
		summary.EnergySpent[player] = cost
	}
	next := initial
	for player := range next.Players {
		next.Players[player].Energy -= summary.EnergySpent[player]
	}
	var actions [6]Action
	copy(actions[:3], actionsA[:])
	copy(actions[3:], actionsB[:])
	var candidates [6]bool
	var endpoints [6]uint8
	for slot, action := range actions {
		if action.Kind == Move || action.Kind == Dash {
			candidates[slot] = true
			endpoints[slot] = action.Path[action.PathLength-1]
		}
	}
	for slot, candidate := range candidates {
		if !candidate {
			continue
		}
		unique := true
		for other, moving := range candidates {
			if other != slot && moving && endpoints[other] == endpoints[slot] {
				unique = false
				break
			}
		}
		if unique {
			next.Units[slot].Cell = endpoints[slot]
			summary.Moved[slot] = true
		}
	}
	rules := DefaultRules()
	var incoming [6]uint8
	for slot, action := range actions {
		var damage uint8
		if action.Kind == Attack {
			damage = rules.AttackDamage[next.Units[slot].UnitType-1]
		}
		if action.Kind == PowerShot {
			damage = rules.PowerShotDamage
		}
		if damage == 0 {
			continue
		}
		for other, unit := range next.Units {
			if slot/3 != other/3 && unit.HP > 0 && unit.Cell == action.TargetCell {
				incoming[other] += damage
				break
			}
		}
	}
	for slot, unit := range next.Units {
		damage := incoming[slot]
		if actions[slot].Kind == Shield {
			if damage > rules.ShieldReduction {
				damage -= rules.ShieldReduction
			} else {
				damage = 0
			}
		}
		if damage > unit.HP {
			damage = unit.HP
		}
		summary.DamageTaken[slot] = damage
		next.Units[slot].HP -= damage
		if next.Units[slot].HP == 0 {
			next.Units[slot].Cell = NoCell
		}
	}
	board := DefaultMap()
	var income, control [2]uint8
	for slot, unit := range next.Units {
		if unit.HP == 0 {
			continue
		}
		if Contains(board.Resources, unit.Cell) {
			income[slot/3] += rules.ResourceIncome
		}
		if Contains(board.ControlZone, unit.Cell) {
			control[slot/3]++
		}
	}
	for player := range next.Players {
		credited := income[player]
		if room := rules.MaxEnergy - next.Players[player].Energy; credited > room {
			credited = room
		}
		next.Players[player].Energy += credited
		summary.EnergyGained[player] = credited
		if control[player] > control[1-player] {
			if uint16(next.Players[player].VictoryPoints)+uint16(rules.ControlAward) > 255 {
				return BattleState{}, summary, fmt.Errorf("victory point arithmetic overflow")
			}
			next.Players[player].VictoryPoints += rules.ControlAward
			summary.VictoryPointsGained[player] = rules.ControlAward
		}
	}
	var err error
	next.Outcome, next.Reason, err = Evaluate(next)
	if err != nil {
		return BattleState{}, summary, err
	}
	if next.Outcome == Ongoing {
		next.Round++
	}
	return next, summary, nil
}
