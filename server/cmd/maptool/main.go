package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

type mapConfig struct {
	MapID       int      `json:"mapId"`
	Name        string   `json:"name"`
	Width       int      `json:"width"`
	Height      int      `json:"height"`
	Obstacles   []int    `json:"obstacles"`
	Resources   []int    `json:"resources"`
	ControlZone []int    `json:"controlZone"`
	ASCII       []string `json:"ascii"`
	Spawns      struct {
		A []int `json:"A"`
		B []int `json:"B"`
	} `json:"spawns"`
	Bitmaps struct {
		Obstacles   string `json:"obstacles"`
		Resources   string `json:"resources"`
		ControlZone string `json:"controlZone"`
		SpawnA      string `json:"spawnA"`
		SpawnB      string `json:"spawnB"`
	} `json:"bitmaps"`
}

type cellGroup struct {
	name     string
	cells    []int
	bitmap   string
	symbol   byte
	expected int
}

func main() {
	mapPath := flag.String("map", "../config/map.json", "Path to the map configuration")
	flag.Parse()
	if err := validateMap(*mapPath); err != nil {
		fmt.Fprintln(os.Stderr, "Map validation failed:", err)
		os.Exit(1)
	}
}

func validateMap(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var config mapConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return err
	}
	if config.MapID != 1 || config.Width != 8 || config.Height != 8 {
		return fmt.Errorf("expected map 1 and an 8x8 board")
	}
	groups := []cellGroup{
		{"obstacles", config.Obstacles, config.Bitmaps.Obstacles, '#', 4},
		{"resources", config.Resources, config.Bitmaps.Resources, 'R', 2},
		{"controlZone", config.ControlZone, config.Bitmaps.ControlZone, 'O', 4},
		{"spawnA", config.Spawns.A, config.Bitmaps.SpawnA, 'A', 3},
		{"spawnB", config.Spawns.B, config.Bitmaps.SpawnB, 'B', 3},
	}
	var masks [5]uint64
	var occupied uint64
	for index, group := range groups {
		if len(group.cells) != group.expected {
			return fmt.Errorf("%s: expected %d cells", group.name, group.expected)
		}
		for _, cell := range group.cells {
			if cell < 0 || cell >= 64 {
				return fmt.Errorf("%s: cell %d is outside the board", group.name, cell)
			}
			bit := uint64(1) << uint(cell)
			if occupied&bit != 0 {
				return fmt.Errorf("cell %d is duplicated or belongs to overlapping groups", cell)
			}
			occupied |= bit
			masks[index] |= bit
		}
		if actual := fmt.Sprintf("0x%016x", masks[index]); actual != group.bitmap {
			return fmt.Errorf("%s: declared bitmap %q does not match %s", group.name, group.bitmap, actual)
		}
	}
	if masks[1] != (uint64(1)<<18 | uint64(1)<<45) {
		return fmt.Errorf("resource cells must be (2,2) and (5,5)")
	}
	if masks[2] != (uint64(1)<<27 | uint64(1)<<28 | uint64(1)<<35 | uint64(1)<<36) {
		return fmt.Errorf("the control zone must contain the central four cells")
	}
	for index := 0; index < 3; index++ {
		if rotateMask(masks[index]) != masks[index] {
			return fmt.Errorf("%s is not 180-degree symmetric", groups[index].name)
		}
	}
	for slot, cell := range config.Spawns.A {
		if config.Spawns.B[slot] != 63-cell {
			return fmt.Errorf("spawn slot %d is not mirrored between players", slot)
		}
	}
	if err := validateASCII(config.ASCII, groups, masks); err != nil {
		return err
	}
	spawns := append(append([]int{}, config.Spawns.A...), config.Spawns.B...)
	targets := append(append([]int{}, config.Resources...), config.ControlZone...)
	for _, spawn := range spawns {
		reachable := reachableCells(spawn, masks[0])
		for _, target := range targets {
			if !reachable[target] {
				return fmt.Errorf("spawn cell %d cannot reach objective cell %d", spawn, target)
			}
		}
	}
	fmt.Printf("Map %d (%s): 8x8\n", config.MapID, config.Name)
	for _, row := range config.ASCII {
		fmt.Println(row)
	}
	for index, group := range groups {
		fmt.Printf("%s: 0x%016x\n", group.name, masks[index])
	}
	fmt.Println("ASCII/bitmap round-trip and 180-degree symmetry: passed.")
	fmt.Println("All six spawn slots can reach both resources and all four control cells.")
	fmt.Println("Map validation passed.")
	return nil
}

func validateASCII(rows []string, groups []cellGroup, masks [5]uint64) error {
	if len(rows) != 8 {
		return fmt.Errorf("ASCII map must have eight rows")
	}
	var decoded [5]uint64
	for y, row := range rows {
		if len(row) != 8 {
			return fmt.Errorf("ASCII row %d must have eight characters", y)
		}
		for x := 0; x < 8; x++ {
			cell := y*8 + x
			bit := uint64(1) << uint(cell)
			expected := byte('.')
			for index, group := range groups {
				if masks[index]&bit != 0 {
					expected = group.symbol
				}
				if row[x] == group.symbol {
					decoded[index] |= bit
				}
			}
			if row[x] != expected {
				return fmt.Errorf("ASCII cell (%d,%d): expected %q, got %q", x, y, expected, row[x])
			}
		}
	}
	for index, group := range groups {
		if decoded[index] != masks[index] {
			return fmt.Errorf("%s does not survive the ASCII/bitmap round-trip", group.name)
		}
	}
	return nil
}

func rotateMask(mask uint64) uint64 {
	var rotated uint64
	for cell := 0; cell < 64; cell++ {
		if mask&(uint64(1)<<uint(cell)) != 0 {
			rotated |= uint64(1) << uint(63-cell)
		}
	}
	return rotated
}

func reachableCells(start int, blocked uint64) [64]bool {
	var seen [64]bool
	seen[start] = true
	queue := []int{start}
	for head := 0; head < len(queue); head++ {
		cell := queue[head]
		x, y := cell%8, cell/8
		neighbors := [][2]int{{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}}
		for _, next := range neighbors {
			if next[0] < 0 || next[0] >= 8 || next[1] < 0 || next[1] >= 8 {
				continue
			}
			index := next[1]*8 + next[0]
			if seen[index] || blocked&(uint64(1)<<uint(index)) != 0 {
				continue
			}
			seen[index] = true
			queue = append(queue, index)
		}
	}
	return seen
}
