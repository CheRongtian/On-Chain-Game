package scenario

import "onchainarena/server/internal/game"

func move(cells ...uint8) game.Action {
	action := game.Action{Kind: game.Move, TargetCell: game.NoCell, PathLength: uint8(len(cells))}
	copy(action.Path[:], cells)
	return action
}

func attack(cell uint8) game.Action {
	return game.Action{Kind: game.Attack, TargetCell: cell}
}

func PointOrders(round uint8) ([3]game.Action, [3]game.Action) {
	a, b := game.HoldActions(), game.HoldActions()
	if round == 2 {
		a[2] = move(32, 33, 34, 35)
		a[2].Kind = game.Dash
	}
	return a, b
}

func EliminationOrders(round uint8) ([3]game.Action, [3]game.Action) {
	a, b := game.HoldActions(), game.HoldActions()
	switch round {
	case 1:
		a[0] = move(9)
		b = [3]game.Action{move(54), move(38, 37), move(31, 30, 29)}
	case 2:
		a[0], a[1] = move(10), attack(26)
		b = [3]game.Action{move(53), move(36, 35), move(28, 27, 26)}
	case 3:
		a[0], a[1] = move(18), attack(26)
		b[0], b[1] = move(52), move(34, 33)
	case 4:
		a = [3]game.Action{attack(26), attack(25), move(32)}
		b[0], b[1] = move(51), move(25)
	case 5:
		a[1], a[2] = attack(25), move(33)
		b[0] = move(50)
	case 6:
		a[1], a[2] = attack(25), attack(25)
		b[0] = move(42)
	case 7:
		b[0] = move(34)
	case 8:
		a[0], a[1] = attack(26), attack(26)
		b[0] = move(26)
	case 9:
		a = [3]game.Action{attack(26), attack(26), move(34)}
	case 10:
		a = [3]game.Action{attack(26), attack(26), attack(26)}
	}
	return a, b
}
