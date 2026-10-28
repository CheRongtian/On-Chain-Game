package game

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

const (
	BoardSize = 8
	CellCount = 64
	NoCell    = 255
	SquadSize = 3
	UnitCount = 6
)

type ActionKind uint8

const (
	Hold ActionKind = iota
	Move
	Attack
	Shield
	PowerShot
	Dash
)

type UnitKind uint8

const (
	NoUnit UnitKind = iota
	Guardian
	Ranger
	Scout
)

type Outcome uint8

const (
	Ongoing Outcome = iota
	PlayerA
	PlayerB
	Draw
)

type EndReason uint8

const (
	NoReason EndReason = iota
	Elimination
	MutualElimination
	VictoryPoints
	RoundLimit
	CommitTimeout
	RevealTimeout
)

type Action struct {
	Kind       ActionKind `json:"kind"`
	TargetCell uint8      `json:"targetCell"`
	PathLength uint8      `json:"pathLength"`
	Path       [4]uint8   `json:"path"`
}
type UnitState struct {
	UnitType UnitKind `json:"unitType"`
	Cell     uint8    `json:"cell"`
	HP       uint8    `json:"hp"`
}
type PlayerState struct {
	Energy        uint8 `json:"energy"`
	VictoryPoints uint8 `json:"victoryPoints"`
}
type BattleState struct {
	MapID   uint8          `json:"mapId"`
	Round   uint8          `json:"round"`
	Players [2]PlayerState `json:"players"`
	Units   [6]UnitState   `json:"units"`
	Outcome Outcome        `json:"outcome"`
	Reason  EndReason      `json:"reason"`
}
type ResolutionSummary struct {
	EnergySpent         [2]uint8 `json:"energySpent"`
	Moved               [6]bool  `json:"moved"`
	DamageTaken         [6]uint8 `json:"damageTaken"`
	EnergyGained        [2]uint8 `json:"energyGained"`
	VictoryPointsGained [2]uint8 `json:"victoryPointsGained"`
}
type Map struct {
	MapID, Width, Height              uint8
	Obstacles, Resources, ControlZone uint64
	SpawnsA, SpawnsB                  [3]uint8
}
type Rules struct {
	InitialEnergy, MaxEnergy, MaxRounds, VictoryThreshold  uint8
	ResourceIncome, ControlAward                           uint8
	PhaseDuration, RoomLifetime                            uint32
	MaxHP, MoveRange, AttackRange, AttackDamage, SkillCost [3]uint8
	ShieldReduction, PowerShotDamage, DashRange            uint8
}
type MatchContext struct {
	ChainID Uint256 `json:"chainId"`
	Arena   Address `json:"arena"`
	MatchID Uint256 `json:"matchId"`
}

// Context integers retain the full uint256 ABI range without floating-point conversion.
type Uint256 [32]byte
type Address [20]byte
type Hash [32]byte

func U256(value uint64) Uint256 {
	var result Uint256
	binary.BigEndian.PutUint64(result[24:], value)
	return result
}
func (value Uint256) String() string               { return new(big.Int).SetBytes(value[:]).String() }
func (value Uint256) MarshalJSON() ([]byte, error) { return []byte(value.String()), nil }
func (value *Uint256) UnmarshalJSON(data []byte) error {
	text := string(data)
	if strings.HasPrefix(text, "\"") {
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
	}
	base := 10
	if strings.HasPrefix(text, "0x") {
		text, base = text[2:], 16
	}
	number, ok := new(big.Int).SetString(text, base)
	if !ok || number.Sign() < 0 || number.BitLen() > 256 {
		return fmt.Errorf("invalid uint256: %s", data)
	}
	number.FillBytes(value[:])
	return nil
}
func decodeHex(text string, size int) ([]byte, error) {
	if !strings.HasPrefix(text, "0x") || len(text) != 2+size*2 {
		return nil, fmt.Errorf("expected a %d-byte hex value", size)
	}
	return hex.DecodeString(text[2:])
}
func ParseAddress(text string) (Address, error) {
	var result Address
	data, err := decodeHex(text, len(result))
	if err != nil {
		return result, err
	}
	copy(result[:], data)
	return result, nil
}
func (value Address) String() string               { return "0x" + hex.EncodeToString(value[:]) }
func (value Address) MarshalJSON() ([]byte, error) { return json.Marshal(value.String()) }
func (value *Address) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	parsed, err := ParseAddress(text)
	if err == nil {
		*value = parsed
	}
	return err
}
func (value Hash) String() string               { return "0x" + hex.EncodeToString(value[:]) }
func (value Hash) MarshalJSON() ([]byte, error) { return json.Marshal(value.String()) }
func (value *Hash) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	decoded, err := decodeHex(text, len(value))
	if err != nil {
		return err
	}
	copy(value[:], decoded)
	return nil
}

func DefaultRules() Rules {
	return Rules{InitialEnergy: 2, MaxEnergy: 5, MaxRounds: 20, VictoryThreshold: 12,
		ResourceIncome: 1, ControlAward: 2, PhaseDuration: 600, RoomLifetime: 86400,
		MaxHP: [3]uint8{10, 6, 5}, MoveRange: [3]uint8{1, 2, 3}, AttackRange: [3]uint8{1, 3, 1},
		AttackDamage: [3]uint8{2, 2, 1}, SkillCost: [3]uint8{1, 2, 1},
		ShieldReduction: 2, PowerShotDamage: 3, DashRange: 4}
}
func DefaultMap() Map {
	return Map{MapID: 1, Width: 8, Height: 8, Obstacles: 0x0000420000420000,
		Resources: 0x0000200000040000, ControlZone: 0x0000001818000000,
		SpawnsA: [3]uint8{8, 24, 40}, SpawnsB: [3]uint8{55, 39, 23}}
}
func InitialState() BattleState {
	rules, board := DefaultRules(), DefaultMap()
	state := BattleState{MapID: board.MapID, Round: 1}
	for player := range state.Players {
		state.Players[player].Energy = rules.InitialEnergy
	}
	for slot := range state.Units {
		cell := board.SpawnsA[slot%3]
		if slot >= 3 {
			cell = board.SpawnsB[slot%3]
		}
		state.Units[slot] = UnitState{UnitType: UnitKind(slot%3 + 1), Cell: cell, HP: rules.MaxHP[slot%3]}
	}
	return state
}
func HoldActions() [3]Action {
	return [3]Action{{TargetCell: NoCell}, {TargetCell: NoCell}, {TargetCell: NoCell}}
}
