package game

import (
	"encoding/binary"
	"fmt"

	"golang.org/x/crypto/sha3"
)

func Keccak(data []byte) Hash {
	var result Hash
	hasher := sha3.NewLegacyKeccak256()
	_, _ = hasher.Write(data)
	hasher.Sum(result[:0])
	return result
}

// The frozen protocol consists entirely of static ABI tuples and fixed arrays.
type words []byte

func (encoded *words) number(value uint64) {
	var word [32]byte
	binary.BigEndian.PutUint64(word[24:], value)
	*encoded = append(*encoded, word[:]...)
}
func (encoded *words) hash(value Hash) { *encoded = append(*encoded, value[:]...) }
func (encoded *words) address(value Address) {
	*encoded = append(*encoded, make([]byte, 12)...)
	*encoded = append(*encoded, value[:]...)
}
func (encoded *words) context(value MatchContext) {
	*encoded = append(*encoded, value.ChainID[:]...)
	encoded.address(value.Arena)
	*encoded = append(*encoded, value.MatchID[:]...)
}
func (encoded *words) state(state BattleState) {
	encoded.number(uint64(state.MapID))
	encoded.number(uint64(state.Round))
	for _, player := range state.Players {
		encoded.number(uint64(player.Energy))
		encoded.number(uint64(player.VictoryPoints))
	}
	for _, unit := range state.Units {
		encoded.number(uint64(unit.UnitType))
		encoded.number(uint64(unit.Cell))
		encoded.number(uint64(unit.HP))
	}
	encoded.number(uint64(state.Outcome))
	encoded.number(uint64(state.Reason))
}
func (encoded *words) actions(actions [3]Action) {
	for _, action := range actions {
		encoded.number(uint64(action.Kind))
		encoded.number(uint64(action.TargetCell))
		encoded.number(uint64(action.PathLength))
		for _, cell := range action.Path {
			encoded.number(uint64(cell))
		}
	}
}
func (encoded *words) summary(summary ResolutionSummary) {
	for _, value := range summary.EnergySpent {
		encoded.number(uint64(value))
	}
	for _, value := range summary.Moved {
		if value {
			encoded.number(1)
		} else {
			encoded.number(0)
		}
	}
	for _, value := range summary.DamageTaken {
		encoded.number(uint64(value))
	}
	for _, value := range summary.EnergyGained {
		encoded.number(uint64(value))
	}
	for _, value := range summary.VictoryPointsGained {
		encoded.number(uint64(value))
	}
}
func RulesHash() Hash {
	rules, board := DefaultRules(), DefaultMap()
	var encoded words
	encoded.hash(Keccak([]byte("OnChainTacticalArena.Rules")))
	for _, value := range []uint8{rules.InitialEnergy, rules.MaxEnergy, rules.MaxRounds, rules.VictoryThreshold, rules.ResourceIncome, rules.ControlAward} {
		encoded.number(uint64(value))
	}
	encoded.number(uint64(rules.PhaseDuration))
	encoded.number(uint64(rules.RoomLifetime))
	for _, values := range [5][3]uint8{rules.MaxHP, rules.MoveRange, rules.AttackRange, rules.AttackDamage, rules.SkillCost} {
		for _, value := range values {
			encoded.number(uint64(value))
		}
	}
	for _, value := range []uint8{rules.ShieldReduction, rules.PowerShotDamage, rules.DashRange, board.MapID, board.Width, board.Height} {
		encoded.number(uint64(value))
	}
	for _, value := range []uint64{board.Obstacles, board.Resources, board.ControlZone} {
		encoded.number(value)
	}
	for _, values := range [2][3]uint8{board.SpawnsA, board.SpawnsB} {
		for _, value := range values {
			encoded.number(uint64(value))
		}
	}
	return Keccak(encoded)
}
func EncodeActions(actions [3]Action) ([]byte, error) {
	if err := ValidateEncoding(actions); err != nil {
		return nil, err
	}
	var encoded words
	encoded.actions(actions)
	return encoded, nil
}
func ActionsHash(actions [3]Action) (Hash, error) {
	if err := ValidateEncoding(actions); err != nil {
		return Hash{}, err
	}
	var encoded words
	encoded.hash(Keccak([]byte("OnChainTacticalArena.Actions")))
	encoded.actions(actions)
	return Keccak(encoded), nil
}
func Commitment(context MatchContext, round uint8, player Address, actions [3]Action, salt Hash) (Hash, error) {
	if round == 0 || round > DefaultRules().MaxRounds {
		return Hash{}, fmt.Errorf("InvalidRound: %d", round)
	}
	actionsHash, err := ActionsHash(actions)
	if err != nil {
		return Hash{}, err
	}
	var encoded words
	encoded.hash(Keccak([]byte("ActionCommitment((uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)")))
	encoded.context(context)
	encoded.number(uint64(round))
	encoded.address(player)
	encoded.hash(RulesHash())
	encoded.hash(actionsHash)
	encoded.hash(salt)
	return Keccak(encoded), nil
}
func StateHash(context MatchContext, state BattleState) (Hash, error) {
	if err := ValidateState(state); err != nil {
		return Hash{}, err
	}
	var encoded words
	encoded.hash(Keccak([]byte("OnChainTacticalArena.BattleState")))
	encoded.context(context)
	encoded.hash(RulesHash())
	encoded.state(state)
	return Keccak(encoded), nil
}

// Each record is a static Solidity Comparison tuple. Only the outer array has an offset.
type Comparison struct {
	Name            string            `json:"name"`
	Context         MatchContext      `json:"context"`
	State           BattleState       `json:"state"`
	ActionsA        [3]Action         `json:"actionsA"`
	ActionsB        [3]Action         `json:"actionsB"`
	ExpectedState   BattleState       `json:"expectedState"`
	ExpectedSummary ResolutionSummary `json:"expectedSummary"`
	ExpectedHash    Hash              `json:"expectedHash"`
}

func EncodeComparisons(cases []Comparison) ([]byte, error) {
	var encoded words
	encoded.number(32)
	encoded.number(uint64(len(cases)))
	for _, entry := range cases {
		if err := ValidateState(entry.State); err != nil {
			return nil, err
		}
		if err := ValidateState(entry.ExpectedState); err != nil {
			return nil, err
		}
		if err := ValidateEncoding(entry.ActionsA); err != nil {
			return nil, err
		}
		if err := ValidateEncoding(entry.ActionsB); err != nil {
			return nil, err
		}
		encoded.context(entry.Context)
		encoded.state(entry.State)
		encoded.actions(entry.ActionsA)
		encoded.actions(entry.ActionsB)
		encoded.state(entry.ExpectedState)
		encoded.summary(entry.ExpectedSummary)
		encoded.hash(entry.ExpectedHash)
	}
	return encoded, nil
}

// Result word names match abi.encode(BattleState, ResolutionSummary, bytes32).
func ResultField(word int) string {
	fields := []string{"state.mapId", "state.round"}
	for player := 0; player < 2; player++ {
		fields = append(fields, fmt.Sprintf("state.players[%d].energy", player), fmt.Sprintf("state.players[%d].victoryPoints", player))
	}
	for slot := 0; slot < 6; slot++ {
		for _, name := range []string{"unitType", "cell", "hp"} {
			fields = append(fields, fmt.Sprintf("state.units[%d].%s", slot, name))
		}
	}
	fields = append(fields, "state.outcome", "state.reason")
	for _, group := range []struct {
		name  string
		count int
	}{{"energySpent", 2}, {"moved", 6}, {"damageTaken", 6}, {"energyGained", 2}, {"victoryPointsGained", 2}} {
		for index := 0; index < group.count; index++ {
			fields = append(fields, fmt.Sprintf("summary.%s[%d]", group.name, index))
		}
	}
	fields = append(fields, "stateHash")
	if word < 0 || word >= len(fields) {
		return fmt.Sprintf("ABI word %d", word)
	}
	return fields[word]
}
