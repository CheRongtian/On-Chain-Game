package main

import (
	"fmt"
	"strings"

	"onchainarena/server/internal/game"
)

type order = game.Action

func ordersABI(orders [3]order) string {
	var values [3]string
	for index, order := range orders {
		path := order.Path
		values[index] = fmt.Sprintf("(%d,%d,%d,[%d,%d,%d,%d])", order.Kind, order.TargetCell, order.PathLength, path[0], path[1], path[2], path[3])
	}
	return "[" + strings.Join(values[:], ",") + "]"
}
