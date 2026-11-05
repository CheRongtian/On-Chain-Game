package squad

import (
	"encoding/binary"
	"errors"

	"onchainarena/server/internal/game"
)

var ErrInvalidProtocol = errors.New("invalid squad protocol")

type Context = game.MatchContext
type Action struct {
	ActionType uint8  `json:"actionType"`
	TargetCell uint8  `json:"targetCell"`
	TargetUnit uint8  `json:"targetUnit"`
	PathLength uint8  `json:"pathLength"`
	PathBits   uint32 `json:"pathBits"`
}
type Unit struct {
	UnitType    uint8  `json:"unitType"`
	Position    uint8  `json:"position"`
	HP          uint8  `json:"hp"`
	Alive       bool   `json:"alive"`
	LockedRound uint16 `json:"lockedRound"`
}
type State struct {
	MapID          uint8    `json:"mapId"`
	BattleStarted  bool     `json:"battleStarted"`
	CompletedRound uint16   `json:"completedRound"`
	Units          [6]Unit  `json:"units"`
	Energy         [2]uint8 `json:"energy"`
	VictoryPoints  [2]uint8 `json:"victoryPoints"`
	Outcome        uint8    `json:"outcome"`
	Reason         uint8    `json:"reason"`
}
type Effects struct {
	EnergySpent         [2]uint8  `json:"energySpent"`
	Moved               [6]bool   `json:"moved"`
	Healed              [6]uint8  `json:"healed"`
	CoverReduced        [6]uint8  `json:"coverReduced"`
	ShieldReduced       [6]uint8  `json:"shieldReduced"`
	DamageTaken         [6]uint8  `json:"damageTaken"`
	LockedRoundApplied  [6]uint16 `json:"lockedRoundApplied"`
	EnergyGained        [2]uint8  `json:"energyGained"`
	VictoryPointsGained [2]uint8  `json:"victoryPointsGained"`
}
type Rules struct {
	SemanticsID game.Hash    `json:"semanticsId"`
	MatchRules  [8]uint8     `json:"matchRules"`
	UnitRules   [5][5]uint8  `json:"unitRules"`
	SkillRules  [10]uint8    `json:"skillRules"`
	Windows     [5]uint32    `json:"windows"`
	Schemas     [3]uint16    `json:"schemas"`
	MapHashes   [3]game.Hash `json:"mapHashes"`
}
type SquadInput struct {
	Context   Context      `json:"context"`
	Player    game.Address `json:"player"`
	RulesetID game.Hash    `json:"rulesetId"`
	UnitTypes [3]uint8     `json:"unitTypes"`
	Salt      game.Hash    `json:"salt"`
}
type ActionInput struct {
	Context     Context      `json:"context"`
	Round       uint16       `json:"round"`
	Player      game.Address `json:"player"`
	RulesetID   game.Hash    `json:"rulesetId"`
	Side        uint8        `json:"side"`
	UnitTypes   [3]uint8     `json:"unitTypes"`
	Alive       [3]bool      `json:"alive"`
	LockedRound [3]uint16    `json:"lockedRound"`
	Actions     [3]Action    `json:"actions"`
	Salt        game.Hash    `json:"salt"`
}
type StateInput struct {
	Context   Context   `json:"context"`
	RulesetID game.Hash `json:"rulesetId"`
	State     State     `json:"state"`
}

type words []byte

func (w *words) number(value uint64) {
	var word [32]byte
	binary.BigEndian.PutUint64(word[24:], value)
	*w = append(*w, word[:]...)
}
func (w *words) hash(value game.Hash) { *w = append(*w, value[:]...) }
func (w *words) address(value game.Address) {
	*w = append(*w, make([]byte, 12)...)
	*w = append(*w, value[:]...)
}
func (w *words) uint256(value game.Uint256) { *w = append(*w, value[:]...) }
func (w *words) boolean(value bool) {
	if value {
		w.number(1)
	} else {
		w.number(0)
	}
}
func (w *words) context(value Context) {
	w.uint256(value.ChainID)
	w.address(value.Arena)
	w.uint256(value.MatchID)
}
func (w *words) actions(actions [3]Action) {
	for _, value := range actions {
		w.number(uint64(value.ActionType))
		w.number(uint64(value.TargetCell))
		w.number(uint64(value.TargetUnit))
		w.number(uint64(value.PathLength))
		w.number(uint64(value.PathBits))
	}
}
func (w *words) state(value State) {
	w.number(uint64(value.MapID))
	w.boolean(value.BattleStarted)
	w.number(uint64(value.CompletedRound))
	for _, unit := range value.Units {
		w.number(uint64(unit.UnitType))
		w.number(uint64(unit.Position))
		w.number(uint64(unit.HP))
		w.boolean(unit.Alive)
		w.number(uint64(unit.LockedRound))
	}
	for _, energy := range value.Energy {
		w.number(uint64(energy))
	}
	for _, points := range value.VictoryPoints {
		w.number(uint64(points))
	}
	w.number(uint64(value.Outcome))
	w.number(uint64(value.Reason))
}
func (w *words) effects(value Effects) {
	for _, amount := range value.EnergySpent {
		w.number(uint64(amount))
	}
	for _, moved := range value.Moved {
		w.boolean(moved)
	}
	for _, amounts := range [4][6]uint8{value.Healed, value.CoverReduced, value.ShieldReduced, value.DamageTaken} {
		for _, amount := range amounts {
			w.number(uint64(amount))
		}
	}
	for _, round := range value.LockedRoundApplied {
		w.number(uint64(round))
	}
	for _, amounts := range [2][2]uint8{value.EnergyGained, value.VictoryPointsGained} {
		for _, amount := range amounts {
			w.number(uint64(amount))
		}
	}
}

func Domain(index uint8) (game.Hash, error) {
	names := [4]string{"OTA_RULESET_V2", "OTA_SQUAD_V2", "OTA_ACTION_V2", "OTA_STATE_V2"}
	if index >= uint8(len(names)) {
		return game.Hash{}, ErrInvalidProtocol
	}
	return game.Keccak([]byte(names[index])), nil
}
func begin(index uint8) words { value, _ := Domain(index); var w words; w.hash(value); return w }
func ValidateSquad(types [3]uint8) error {
	for i, value := range types {
		if value < 1 || value > 5 {
			return ErrInvalidProtocol
		}
		for j := 0; j < i; j++ {
			if types[j] == value {
				return ErrInvalidProtocol
			}
		}
	}
	return nil
}
func EncodeRules(input Rules) []byte {
	w := begin(0)
	w.hash(input.SemanticsID)
	for _, value := range input.MatchRules {
		w.number(uint64(value))
	}
	for _, row := range input.UnitRules {
		for _, value := range row {
			w.number(uint64(value))
		}
	}
	for _, value := range input.SkillRules {
		w.number(uint64(value))
	}
	for _, value := range input.Windows {
		w.number(uint64(value))
	}
	for _, value := range input.Schemas {
		w.number(uint64(value))
	}
	for _, value := range input.MapHashes {
		w.hash(value)
	}
	return w
}
func EncodeSquad(input SquadInput) ([]byte, error) {
	if err := ValidateSquad(input.UnitTypes); err != nil {
		return nil, err
	}
	w := begin(1)
	w.context(input.Context)
	w.address(input.Player)
	w.hash(input.RulesetID)
	for _, value := range input.UnitTypes {
		w.number(uint64(value))
	}
	w.hash(input.Salt)
	return w, nil
}
func EncodeTurn(input ActionInput) ([]byte, error) {
	if input.Round == 0 || input.Round > 20 || input.Side > 1 {
		return nil, ErrInvalidProtocol
	}
	if err := ValidateSquad(input.UnitTypes); err != nil {
		return nil, err
	}
	ranges := [5]uint8{1, 2, 3, 2, 2}
	for slot, action := range input.Actions {
		kind := input.UnitTypes[slot]
		if action.ActionType > 3 || (!input.Alive[slot] && action.ActionType != 0) || (input.LockedRound[slot] == input.Round && action.ActionType == 3) {
			return nil, ErrInvalidProtocol
		}
		skill := action.ActionType == 3
		moves := action.ActionType == 1 || (skill && kind == 3)
		if moves {
			limit := ranges[kind-1]
			if skill {
				limit = 4
			}
			if action.TargetCell != 255 || action.TargetUnit != 255 || action.PathLength < 1 || action.PathLength > limit {
				return nil, ErrInvalidProtocol
			}
		} else {
			if action.PathLength != 0 {
				return nil, ErrInvalidProtocol
			}
			cell := action.ActionType == 2 || (skill && (kind == 2 || kind == 5))
			target := skill && kind == 4
			if (cell && action.TargetCell >= 64) || (!cell && action.TargetCell != 255) || (target && action.TargetUnit >= 6) || (!target && action.TargetUnit != 255) {
				return nil, ErrInvalidProtocol
			}
			if target && (action.TargetUnit/3 != input.Side || !input.Alive[action.TargetUnit%3]) {
				return nil, ErrInvalidProtocol
			}
		}
		if uint64(action.PathBits)>>(uint(action.PathLength)*6) != 0 {
			return nil, ErrInvalidProtocol
		}
		var visited uint64
		for step := uint8(0); step < action.PathLength; step++ {
			cell := (action.PathBits >> (uint(step) * 6)) & 63
			if visited&(uint64(1)<<cell) != 0 {
				return nil, ErrInvalidProtocol
			}
			visited |= uint64(1) << cell
			if step > 0 {
				previous := (action.PathBits >> (uint(step-1) * 6)) & 63
				dx := int(cell%8) - int(previous%8)
				dy := int(cell/8) - int(previous/8)
				if dx < 0 {
					dx = -dx
				}
				if dy < 0 {
					dy = -dy
				}
				if dx+dy != 1 {
					return nil, ErrInvalidProtocol
				}
			}
		}
	}
	w := begin(2)
	w.context(input.Context)
	w.number(uint64(input.Round))
	w.address(input.Player)
	w.hash(input.RulesetID)
	w.actions(input.Actions)
	w.hash(input.Salt)
	return w, nil
}
func EncodeState(input StateInput) ([]byte, error) {
	s := input.State
	if s.MapID < 1 || s.MapID > 3 || s.CompletedRound > 20 || s.Outcome > 3 || s.Reason > 8 || (s.Outcome == 0) != (s.Reason == 0) {
		return nil, ErrInvalidProtocol
	}
	if !s.BattleStarted {
		if s.CompletedRound != 0 || (s.Reason != 0 && s.Reason < 7) || s.Energy != [2]uint8{} || s.VictoryPoints != [2]uint8{} {
			return nil, ErrInvalidProtocol
		}
		for _, u := range s.Units {
			if u.UnitType != 0 || u.Position != 255 || u.HP != 0 || u.Alive || u.LockedRound != 0 {
				return nil, ErrInvalidProtocol
			}
		}
	} else {
		if s.Reason > 6 || (s.CompletedRound == 20 && (s.Outcome == 0 || s.Reason > 4)) || (s.Reason >= 1 && s.Reason <= 4 && s.CompletedRound == 0) {
			return nil, ErrInvalidProtocol
		}
		for p := 0; p < 2; p++ {
			if s.Energy[p] > 5 {
				return nil, ErrInvalidProtocol
			}
			if err := ValidateSquad([3]uint8{s.Units[p*3].UnitType, s.Units[p*3+1].UnitType, s.Units[p*3+2].UnitType}); err != nil {
				return nil, err
			}
		}
		maxHp := [5]uint8{10, 6, 5, 7, 6}
		obstacles := [3]uint64{0x0000420000420000, 0x0030002244000c00, 0x0010004422000800}
		var occupied uint64
		for _, u := range s.Units {
			if u.HP > maxHp[u.UnitType-1] || u.Alive != (u.HP > 0) {
				return nil, ErrInvalidProtocol
			}
			if u.Alive {
				if u.Position >= 64 {
					return nil, ErrInvalidProtocol
				}
				bit := uint64(1) << u.Position
				if occupied&bit != 0 || obstacles[s.MapID-1]&bit != 0 {
					return nil, ErrInvalidProtocol
				}
				occupied |= bit
				if u.LockedRound != 0 && (s.CompletedRound == 0 || u.LockedRound != s.CompletedRound+1) {
					return nil, ErrInvalidProtocol
				}
			} else if u.Position != 255 || u.LockedRound != 0 {
				return nil, ErrInvalidProtocol
			}
		}
	}
	w := begin(3)
	w.context(input.Context)
	w.hash(input.RulesetID)
	w.state(s)
	return w, nil
}

type EventInput struct {
	EventType  uint8        `json:"eventType"`
	MatchID    game.Uint256 `json:"matchId"`
	Round      uint16       `json:"round"`
	Player     game.Address `json:"player"`
	RulesetID  game.Hash    `json:"rulesetId"`
	MapID      uint8        `json:"mapId"`
	MapHash    game.Hash    `json:"mapHash"`
	Deadline   uint64       `json:"deadline"`
	Commitment game.Hash    `json:"commitment"`
	UnitTypes  [3]uint8     `json:"unitTypes"`
	Salt       game.Hash    `json:"salt"`
	State      State        `json:"state"`
	Actions    [3]Action    `json:"actions"`
	FromPhase  uint8        `json:"fromPhase"`
	ToPhase    uint8        `json:"toPhase"`
	BeforeHash game.Hash    `json:"beforeHash"`
	AfterHash  game.Hash    `json:"afterHash"`
	Effects    Effects      `json:"effects"`
	Winner     game.Address `json:"winner"`
}

const actionTuple = "(uint8,uint8,uint8,uint8,uint32)"
const stateTuple = "(uint8,bool,uint16,(uint8,uint8,uint8,bool,uint16)[6],uint8[2],uint8[2],uint8,uint8)"
const effectsTuple = "(uint8[2],bool[6],uint8[6],uint8[6],uint8[6],uint8[6],uint16[6],uint8[2],uint8[2])"

func EncodeEvent(value EventInput) ([]byte, []game.Hash, error) {
	signatures := [10]string{
		"MatchCreated(uint256,address,bytes32,uint8,bytes32,uint64)",
		"PlayerJoined(uint256,address,uint8,uint64)",
		"SquadCommitted(uint256,address,bytes32)",
		"SquadRevealed(uint256,address,uint8[3],bytes32)",
		"GameStarted(uint256," + stateTuple + ",bytes32)",
		"ActionCommitted(uint256,uint16,address,bytes32)",
		"ActionRevealed(uint256,uint16,address," + actionTuple + "[3],bytes32)",
		"PhaseAdvanced(uint256,uint16,uint8,uint8,uint64)",
		"RoundResolved(uint256,uint16,bytes32,bytes32," + stateTuple + "," + effectsTuple + ")",
		"MatchFinished(uint256,uint16,address,bool,uint16,uint8,uint8,bytes32)",
	}
	if value.EventType >= 10 {
		return nil, nil, ErrInvalidProtocol
	}
	topics := []game.Hash{game.Keccak([]byte(signatures[value.EventType])), game.Hash(value.MatchID)}
	var data words
	addPlayer := func(player game.Address) {
		var w words
		w.address(player)
		var hash game.Hash
		copy(hash[:], w)
		topics = append(topics, hash)
	}
	addRound := func() {
		var w words
		w.number(uint64(value.Round))
		var hash game.Hash
		copy(hash[:], w)
		topics = append(topics, hash)
	}
	switch value.EventType {
	case 0:
		addPlayer(value.Player)
		data.hash(value.RulesetID)
		data.number(uint64(value.MapID))
		data.hash(value.MapHash)
		data.number(value.Deadline)
	case 1:
		addPlayer(value.Player)
		data.number(uint64(value.ToPhase))
		data.number(value.Deadline)
	case 2:
		addPlayer(value.Player)
		data.hash(value.Commitment)
	case 3:
		addPlayer(value.Player)
		for _, kind := range value.UnitTypes {
			data.number(uint64(kind))
		}
		data.hash(value.Salt)
	case 4:
		data.state(value.State)
		data.hash(value.AfterHash)
	case 5:
		addRound()
		addPlayer(value.Player)
		data.hash(value.Commitment)
	case 6:
		addRound()
		addPlayer(value.Player)
		data.actions(value.Actions)
		data.hash(value.Salt)
	case 7:
		addRound()
		data.number(uint64(value.FromPhase))
		data.number(uint64(value.ToPhase))
		data.number(value.Deadline)
	case 8:
		addRound()
		data.hash(value.BeforeHash)
		data.hash(value.AfterHash)
		data.state(value.State)
		data.effects(value.Effects)
	case 9:
		addPlayer(value.Winner)
		data.number(uint64(value.Round))
		data.boolean(value.State.BattleStarted)
		data.number(uint64(value.State.CompletedRound))
		data.number(uint64(value.State.Outcome))
		data.number(uint64(value.State.Reason))
		data.hash(value.AfterHash)
	}
	return data, topics, nil
}
