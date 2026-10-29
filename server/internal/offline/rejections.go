package offline

import "onchainarena/server/internal/game"

// These fixtures keep ABI enums decodable so rejection is checked inside both rule engines.
func rejectionCases() []game.Comparison {
	mutations := []struct {
		name  string
		apply func(*game.Comparison)
	}{
		{"unknown-map", func(c *game.Comparison) { c.State.MapID = 2 }},
		{"zero-round", func(c *game.Comparison) { c.State.Round = 0 }},
		{"past-last-round", func(c *game.Comparison) { c.State.Round = 21 }},
		{"energy-over-cap", func(c *game.Comparison) { c.State.Players[0].Energy = 6 }},
		{"hp-over-cap", func(c *game.Comparison) { c.State.Units[0].HP = 11 }},
		{"dead-cell-retained", func(c *game.Comparison) { c.State.Units[0].HP = 0 }},
		{"live-cell-missing", func(c *game.Comparison) { c.State.Units[0].Cell = game.NoCell }},
		{"overlapping-units", func(c *game.Comparison) { c.State.Units[1].Cell = c.State.Units[0].Cell }},
		{"unit-on-wall", func(c *game.Comparison) { c.State.Units[0].Cell = 17 }},
		{"wrong-unit-slot", func(c *game.Comparison) { c.State.Units[0].UnitType = game.Scout }},
		{"finished-state", func(c *game.Comparison) { c.State.Outcome = game.Draw; c.State.Reason = game.RoundLimit }},
		{"inconsistent-result", func(c *game.Comparison) { c.State.Reason = game.Elimination }},
		{"hold-target", func(c *game.Comparison) { c.ActionsA[0].TargetCell = 0 }},
		{"path-padding", func(c *game.Comparison) { c.ActionsA[0].Path[3] = 1 }},
		{"attack-outside-board", func(c *game.Comparison) { c.ActionsA[0] = game.Action{Kind: game.Attack, TargetCell: 64} }},
		{"move-too-long", func(c *game.Comparison) {
			c.ActionsA[2] = game.Action{Kind: game.Move, TargetCell: game.NoCell, PathLength: 5}
		}},
		{"diagonal-move", func(c *game.Comparison) {
			c.ActionsA[0] = game.Action{Kind: game.Move, TargetCell: game.NoCell, PathLength: 1, Path: [4]uint8{17}}
		}},
		{"occupied-path", func(c *game.Comparison) {
			c.ActionsA[1] = game.Action{Kind: game.Move, TargetCell: game.NoCell, PathLength: 2, Path: [4]uint8{16, 8}}
		}},
		{"wrong-skill", func(c *game.Comparison) { c.ActionsA[0] = game.Action{Kind: game.PowerShot, TargetCell: 16} }},
		{"invalid-ray", func(c *game.Comparison) { c.ActionsA[1] = game.Action{Kind: game.Attack, TargetCell: 63} }},
		{"energy-overspend", func(c *game.Comparison) {
			c.ActionsA[0].Kind = game.Shield
			c.ActionsA[1] = game.Action{Kind: game.PowerShot, TargetCell: 25}
		}},
		{"dead-unit-action", func(c *game.Comparison) {
			c.State.Units[0].HP = 0
			c.State.Units[0].Cell = game.NoCell
			c.ActionsA[0] = game.Action{Kind: game.Attack, TargetCell: 16}
		}},
		{"guardian-range", func(c *game.Comparison) {
			c.ActionsA[0] = game.Action{Kind: game.Move, TargetCell: game.NoCell, PathLength: 2, Path: [4]uint8{9, 10}}
		}},
		{"repeated-path-cell", func(c *game.Comparison) {
			c.ActionsA[2] = game.Action{Kind: game.Move, TargetCell: game.NoCell, PathLength: 2, Path: [4]uint8{32, 40}}
		}},
	}
	entries := make([]game.Comparison, 0, len(mutations))
	for _, mutation := range mutations {
		entry := game.Comparison{Name: mutation.name, State: game.InitialState(), ActionsA: game.HoldActions(), ActionsB: game.HoldActions()}
		mutation.apply(&entry)
		entries = append(entries, entry)
	}
	return entries
}
