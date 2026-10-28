package indexer

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"onchainarena/server/internal/game"
)

type replayDifference struct {
	Round    uint8  `json:"round"`
	Field    string `json:"field"`
	Expected any    `json:"expected"`
	Actual   any    `json:"actual"`
}

type verification struct {
	Status         string            `json:"status"`
	Message        string            `json:"message"`
	Complete       bool              `json:"complete"`
	Canonical      bool              `json:"canonical"`
	PrefixVerified bool              `json:"prefixVerified"`
	VerifiedRounds int               `json:"verifiedRounds"`
	ThroughBlock   int64             `json:"throughBlock"`
	ThroughHash    string            `json:"throughHash"`
	CheckedAt      time.Time         `json:"checkedAt"`
	Difference     *replayDifference `json:"difference,omitempty"`
}

type publicReveal struct {
	Actions [3]game.Action `json:"actions"`
	Salt    common.Hash    `json:"salt"`
	Source  source         `json:"source"`
}

type replayRound struct {
	Round       uint8            `json:"round"`
	Commitments [2]common.Hash   `json:"commitments"`
	Committed   [2]bool          `json:"committed"`
	Reveals     [2]*publicReveal `json:"reveals"`
}

type replayFrame struct {
	Index        int                     `json:"index"`
	Kind         string                  `json:"kind"`
	Round        uint8                   `json:"round"`
	State        game.BattleState        `json:"state"`
	StateHash    common.Hash             `json:"stateHash"`
	ComputedHash common.Hash             `json:"computedHash"`
	Summary      *game.ResolutionSummary `json:"summary,omitempty"`
	Source       source                  `json:"source"`
}

type replayResult struct {
	MatchID      string          `json:"matchId"`
	Match        json.RawMessage `json:"match"`
	Verification verification    `json:"verification"`
	Frames       []replayFrame   `json:"frames"`
	Rounds       []replayRound   `json:"rounds"`
}

type replayedRound struct {
	Round      uint8   `json:"round"`
	Phase      uint8   `json:"phase"`
	Deadline   uint64  `json:"deadline"`
	BeforeHash *string `json:"beforeHash"`
	AfterHash  *string `json:"afterHash"`
	Resolved   bool    `json:"resolved"`
	Source     source  `json:"source"`
}

type replayedAction struct {
	Round      uint8           `json:"round"`
	Player     string          `json:"player"`
	Commitment string          `json:"commitment"`
	Actions    *[3]game.Action `json:"actions"`
	Salt       *string         `json:"salt"`
	Commit     source          `json:"commit"`
	Reveal     *source         `json:"reveal"`
}

type replayEngine struct {
	result  replayResult
	context game.MatchContext
	match   match
	rounds  map[uint8]*replayedRound
	inputs  map[uint8]*replayRound
	actions []replayedAction
}

func newReplay(cfg config, id string, value cursor) *replayEngine {
	engine := &replayEngine{rounds: make(map[uint8]*replayedRound), inputs: make(map[uint8]*replayRound)}
	engine.context = game.MatchContext{ChainID: game.U256(cfg.ChainID), Arena: game.Address(common.HexToAddress(cfg.Arena))}
	// Match IDs have already passed the API's uint256 parser.
	_ = engine.context.MatchID.UnmarshalJSON([]byte(id))
	engine.result = replayResult{MatchID: id, Frames: []replayFrame{}, Rounds: []replayRound{}, Verification: verification{
		Status: "Incomplete", Message: "History has not been verified.", ThroughBlock: value.Number, ThroughHash: value.Hash, CheckedAt: time.Now().UTC()}}
	return engine
}

func (e *replayEngine) mismatch(round uint8, field string, expected, actual any) {
	if e.result.Verification.Difference == nil {
		e.result.Verification.Status = "Mismatch"
		e.result.Verification.Message = "The first difference is recorded below."
		e.result.Verification.Difference = &replayDifference{round, field, expected, actual}
	}
}

func (e *replayEngine) compare(round uint8, field string, expected, actual any) bool {
	difference := firstDifference(field, expected, actual)
	if difference == nil {
		return true
	}
	e.mismatch(round, difference.Field, difference.Expected, difference.Actual)
	return false
}

func eventSource(entry types.Log) source {
	return source{entry.BlockNumber, entry.BlockHash.Hex(), entry.TxHash.Hex(), entry.Index}
}

func (e *replayEngine) frame(kind string, round uint8, hash common.Hash, from source, summary *game.ResolutionSummary) error {
	computed, err := game.StateHash(e.context, *e.match.Battle)
	if err != nil {
		return err
	}
	e.result.Frames = append(e.result.Frames, replayFrame{len(e.result.Frames), kind, round, *e.match.Battle, hash, common.Hash(computed), summary, from})
	e.compare(round, "chain.stateHash", common.Hash(computed), hash)
	e.match.StateHash = hash
	return nil
}

func (e *replayEngine) apply(name string, event decoded, entry types.Log) error {
	from := eventSource(entry)
	m := &e.match
	switch name {
	case "MatchCreated":
		if m.ID != "" {
			return fmt.Errorf("duplicate MatchCreated")
		}
		*m = match{ID: event.MatchID, MapID: event.MapID, RulesHash: event.RulesHash, Phase: 1, JoinDeadline: event.JoinDeadline,
			Players: [2]string{strings.ToLower(event.Creator.Hex()), strings.ToLower(common.Address{}.Hex())}}
		if !e.compare(0, "rulesHash", common.Hash(game.RulesHash()), event.RulesHash) {
			return nil
		}
	case "PlayerJoined":
		m.Players[1] = strings.ToLower(event.Player.Hex())
	case "MatchStarted":
		if event.InitialState == nil {
			return fmt.Errorf("MatchStarted has no initial state")
		}
		if !e.compare(1, "initialState", game.InitialState(), *event.InitialState) {
			return nil
		}
		state := *event.InitialState
		m.Battle, m.Round = &state, state.Round
		if err := e.frame(name, state.Round, event.StateHash, from, nil); err != nil {
			return err
		}
	case "PhaseAdvanced":
		m.Phase, m.Round, m.PhaseDeadline = event.Phase, event.Round, 0
		if event.Phase == 2 || event.Phase == 3 {
			m.PhaseDeadline = event.Deadline
		}
		if event.Phase == 2 {
			m.Committed, m.Revealed = [2]bool{}, [2]bool{}
		}
		if event.Round > 0 {
			round := e.rounds[event.Round]
			if round == nil {
				round = &replayedRound{Round: event.Round}
				e.rounds[event.Round] = round
				e.inputs[event.Round] = &replayRound{Round: event.Round}
			}
			round.Phase, round.Deadline, round.Source = event.Phase, m.PhaseDeadline, from
		}
	case "ActionCommitted", "ActionRevealed":
		player := -1
		for i, address := range m.Players {
			if strings.EqualFold(address, event.Player.Hex()) {
				player = i
			}
		}
		input := e.inputs[event.Round]
		if player < 0 || input == nil || m.Battle == nil || event.Round != m.Battle.Round {
			return fmt.Errorf("submission has no matching player or round-start state")
		}
		if name == "ActionCommitted" {
			if input.Committed[player] {
				return fmt.Errorf("duplicate commitment")
			}
			input.Committed[player], input.Commitments[player], m.Committed[player] = true, event.Commitment, true
			e.actions = append(e.actions, replayedAction{Round: event.Round, Player: m.Players[player], Commitment: event.Commitment.Hex(), Commit: from})
		} else {
			if event.Actions == nil || !input.Committed[player] || input.Reveals[player] != nil {
				return fmt.Errorf("reveal lacks its commitment or duplicates an earlier reveal")
			}
			commitment, err := game.Commitment(e.context, event.Round, game.Address(event.Player), *event.Actions, game.Hash(event.Salt))
			if err != nil {
				return err
			}
			if !e.compare(event.Round, "commitment", input.Commitments[player], common.Hash(commitment)) {
				return nil
			}
			if _, err = game.ValidateActions(*m.Battle, player, *event.Actions); err != nil {
				return err
			}
			input.Reveals[player] = &publicReveal{*event.Actions, event.Salt, from}
			m.Revealed[player] = true
			for i := range e.actions {
				action := &e.actions[i]
				if action.Round == event.Round && action.Player == m.Players[player] {
					salt := event.Salt.Hex()
					action.Actions, action.Salt, action.Reveal = event.Actions, &salt, &from
				}
			}
		}
	case "RoundResolved":
		input, round := e.inputs[event.Round], e.rounds[event.Round]
		if m.Battle == nil || m.Battle.Round != event.Round || input == nil || round == nil || input.Reveals[0] == nil || input.Reveals[1] == nil {
			return fmt.Errorf("settlement lacks its initial state or both public reveals")
		}
		before, err := game.StateHash(e.context, *m.Battle)
		if err != nil {
			return err
		}
		if !e.compare(event.Round, "chain.beforeStateHash", common.Hash(before), event.BeforeStateHash) {
			return nil
		}
		next, summary, err := game.Resolve(*m.Battle, input.Reveals[0].Actions, input.Reveals[1].Actions)
		if err != nil {
			return err
		}
		m.Battle, m.Round, m.Outcome, m.Reason = &next, next.Round, next.Outcome, next.Reason
		if !e.compare(event.Round, "chain.players", next.Players, event.Players) ||
			!e.compare(event.Round, "chain.outcome", next.Outcome, event.Outcome) || !e.compare(event.Round, "chain.reason", next.Reason, event.Reason) {
			return nil
		}
		beforeText, afterText := event.BeforeStateHash.Hex(), event.AfterStateHash.Hex()
		round.BeforeHash, round.AfterHash, round.Resolved, round.Source = &beforeText, &afterText, true, from
		if err = e.frame(name, event.Round, event.AfterStateHash, from, &summary); err != nil {
			return err
		}
		if e.result.Verification.Difference == nil {
			e.result.Verification.VerifiedRounds++
		}
	case "MatchFinished":
		if m.Battle == nil || event.Round != m.Battle.Round {
			return fmt.Errorf("finished match lacks its matching battle state")
		}
		if event.Reason == game.CommitTimeout || event.Reason == game.RevealTimeout {
			state := *m.Battle
			submitted := m.Committed
			if event.Reason == game.RevealTimeout {
				submitted = m.Revealed
			}
			state.Outcome, state.Reason = game.Draw, event.Reason
			if submitted[0] != submitted[1] {
				state.Outcome = game.PlayerB
				if submitted[0] {
					state.Outcome = game.PlayerA
				}
			}
			m.Battle = &state
			if err := e.frame(name, event.Round, event.StateHash, from, nil); err != nil {
				return err
			}
		}
		winner := common.Address{}
		if m.Battle.Outcome == game.PlayerA {
			winner = common.HexToAddress(m.Players[0])
		} else if m.Battle.Outcome == game.PlayerB {
			winner = common.HexToAddress(m.Players[1])
		}
		if !e.compare(event.Round, "chain.outcome", m.Battle.Outcome, event.Outcome) ||
			!e.compare(event.Round, "chain.reason", m.Battle.Reason, event.Reason) ||
			!e.compare(event.Round, "chain.winner", winner, event.Winner) || !e.compare(event.Round, "chain.stateHash", m.StateHash, event.StateHash) {
			return nil
		}
		m.Outcome, m.Reason, m.Winner = m.Battle.Outcome, m.Battle.Reason, winner
		e.result.Verification.Complete = true
	default:
		return fmt.Errorf("unsupported event %s", name)
	}
	m.Source = from
	return nil
}

// JSON paths make a changed snapshot or projection useful to diagnose without an ABI-word index.
func firstDifference(path string, expected, actual any) *replayDifference {
	left, leftErr := json.Marshal(expected)
	right, rightErr := json.Marshal(actual)
	if leftErr != nil || rightErr != nil {
		return &replayDifference{Field: path, Expected: expected, Actual: actual}
	}
	var a, b any
	_ = json.Unmarshal(left, &a)
	_ = json.Unmarshal(right, &b)
	return jsonDifference(path, a, b)
}

func jsonDifference(path string, expected, actual any) *replayDifference {
	if reflect.DeepEqual(expected, actual) {
		return nil
	}
	switch a := expected.(type) {
	case map[string]any:
		if b, ok := actual.(map[string]any); ok {
			keys := make([]string, 0, len(a)+len(b))
			for key := range a {
				keys = append(keys, key)
			}
			for key := range b {
				if _, exists := a[key]; !exists {
					keys = append(keys, key)
				}
			}
			sort.Strings(keys)
			for _, key := range keys {
				if difference := jsonDifference(path+"."+key, a[key], b[key]); difference != nil {
					return difference
				}
			}
		}
	case []any:
		if b, ok := actual.([]any); ok {
			for i := 0; i < min(len(a), len(b)); i++ {
				if difference := jsonDifference(fmt.Sprintf("%s[%d]", path, i), a[i], b[i]); difference != nil {
					return difference
				}
			}
		}
	}
	return &replayDifference{Field: path, Expected: expected, Actual: actual}
}
