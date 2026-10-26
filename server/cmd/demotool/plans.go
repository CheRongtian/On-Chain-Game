package main

import (
	"fmt"
	"strings"
)

type order struct {
	kind   uint8
	target uint8
	path   []uint8
}

func holds() [3]order {
	return [3]order{{target: 255}, {target: 255}, {target: 255}}
}

func move(cells ...uint8) order {
	return order{kind: 1, target: 255, path: cells}
}

func attack(cell uint8) order {
	return order{kind: 2, target: cell}
}

func pointOrders(round uint8) ([3]order, [3]order) {
	a, b := holds(), holds()
	if round == 2 {
		a[2] = order{kind: 5, target: 255, path: []uint8{32, 33, 34, 35}}
	}
	return a, b
}

func eliminationOrders(round uint8) ([3]order, [3]order) {
	a, b := holds(), holds()
	switch round {
	case 1:
		a[0] = move(9)
		b = [3]order{move(54), move(38, 37), move(31, 30, 29)}
	case 2:
		a[0], a[1] = move(10), attack(26)
		b = [3]order{move(53), move(36, 35), move(28, 27, 26)}
	case 3:
		a[0], a[1] = move(18), attack(26)
		b[0], b[1] = move(52), move(34, 33)
	case 4:
		a = [3]order{attack(26), attack(25), move(32)}
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
		a = [3]order{attack(26), attack(26), move(34)}
	case 10:
		a = [3]order{attack(26), attack(26), attack(26)}
	}
	return a, b
}

func ordersABI(orders [3]order) string {
	var values [3]string
	for index, order := range orders {
		var path [4]uint8
		copy(path[:], order.path)
		values[index] = fmt.Sprintf("(%d,%d,%d,[%d,%d,%d,%d])", order.kind, order.target, len(order.path), path[0], path[1], path[2], path[3])
	}
	return "[" + strings.Join(values[:], ",") + "]"
}
