package offline

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"onchainarena/server/internal/game"
)

type resultVector struct {
	Name            string           `json:"name"`
	State           game.BattleState `json:"state"`
	ExpectedOutcome game.Outcome     `json:"expectedOutcome"`
	ExpectedReason  game.EndReason   `json:"expectedReason"`
}
type hashVector struct {
	Name         string            `json:"name"`
	Context      game.MatchContext `json:"context"`
	State        game.BattleState  `json:"state"`
	ExpectedHash game.Hash         `json:"expectedHash"`
}
type protocolVector struct {
	Name                string            `json:"name"`
	Context             game.MatchContext `json:"context"`
	Round               uint8             `json:"round"`
	Player              game.Address      `json:"player"`
	Actions             [3]game.Action    `json:"actions"`
	Salt                game.Hash         `json:"salt"`
	ExpectedEncoding    string            `json:"expectedEncoding"`
	ExpectedActionsHash game.Hash         `json:"expectedActionsHash"`
	ExpectedCommitment  game.Hash         `json:"expectedCommitment"`
}
type VectorCounts struct{ Results, Hashes, Battles, Protocol int }

func readJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}
func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}
func firstDifference(path string, expected, actual any) error {
	if reflect.DeepEqual(expected, actual) {
		return nil
	}
	switch want := expected.(type) {
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			break
		}
		keys := make([]string, 0, len(want))
		for key := range want {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if err := firstDifference(path+"."+key, want[key], got[key]); err != nil {
				return err
			}
		}
	case []any:
		got, ok := actual.([]any)
		if !ok || len(want) != len(got) {
			break
		}
		for index := range want {
			if err := firstDifference(fmt.Sprintf("%s[%d]", path, index), want[index], got[index]); err != nil {
				return err
			}
		}
	}
	return fmt.Errorf("%s: expected %v, actual %v", path, expected, actual)
}
func compareFields(name string, expected, actual any) error {
	var want, got any
	left, err := json.Marshal(expected)
	if err != nil {
		return err
	}
	right, err := json.Marshal(actual)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(left, &want); err != nil {
		return err
	}
	if err := json.Unmarshal(right, &got); err != nil {
		return err
	}
	return firstDifference(name, want, got)
}

func compareActionEncoding(name, expected string, actual []byte) error {
	want, err := hex.DecodeString(strings.TrimPrefix(expected, "0x"))
	if err != nil {
		return fmt.Errorf("%s.actionEncoding: %w", name, err)
	}
	if len(want) != len(actual) {
		return fmt.Errorf("%s.actionEncoding: expected %d bytes, actual %d", name, len(want), len(actual))
	}
	fields := [7]string{"kind", "targetCell", "pathLength", "path[0]", "path[1]", "path[2]", "path[3]"}
	for offset := 0; offset < len(actual); offset += 32 {
		if !bytes.Equal(want[offset:offset+32], actual[offset:offset+32]) {
			word := offset / 32
			return fmt.Errorf("%s.actions[%d].%s: expected %s, actual %s", name, word/7, fields[word%7], new(big.Int).SetBytes(want[offset:offset+32]).String(), new(big.Int).SetBytes(actual[offset:offset+32]).String())
		}
	}
	return nil
}

func VerifyVectors(root string) (VectorCounts, error) {
	var counts VectorCounts
	var states struct {
		RulesHash game.Hash      `json:"rulesHash"`
		Results   []resultVector `json:"results"`
		Hashes    []hashVector   `json:"hashes"`
	}
	var battles struct {
		RulesHash game.Hash         `json:"rulesHash"`
		Cases     []game.Comparison `json:"cases"`
	}
	var protocol struct {
		RulesHash game.Hash        `json:"rulesHash"`
		Cases     []protocolVector `json:"cases"`
	}
	for _, entry := range []struct {
		file   string
		target any
	}{{"state-vectors.json", &states}, {"battle-vectors.json", &battles}, {"protocol-vectors.json", &protocol}} {
		if err := readJSON(filepath.Join(root, "config", entry.file), entry.target); err != nil {
			return counts, err
		}
	}
	for _, entry := range []struct {
		name     string
		expected game.Hash
	}{{"state", states.RulesHash}, {"battle", battles.RulesHash}, {"protocol", protocol.RulesHash}} {
		if actual := game.RulesHash(); actual != entry.expected {
			return counts, fmt.Errorf("%s.rulesHash: expected %s, actual %s", entry.name, entry.expected, actual)
		}
	}
	if len(states.Results) == 0 || len(states.Hashes) == 0 || len(battles.Cases) == 0 || len(protocol.Cases) == 0 {
		return counts, fmt.Errorf("vector collections must not be empty")
	}
	for _, entry := range states.Results {
		outcome, reason, err := game.Evaluate(entry.State)
		if err != nil {
			return counts, fmt.Errorf("%s: %w", entry.Name, err)
		}
		if err := compareFields(entry.Name+".outcome", entry.ExpectedOutcome, outcome); err != nil {
			return counts, err
		}
		if err := compareFields(entry.Name+".reason", entry.ExpectedReason, reason); err != nil {
			return counts, err
		}
		counts.Results++
	}
	for _, entry := range states.Hashes {
		actual, err := game.StateHash(entry.Context, entry.State)
		if err != nil {
			return counts, fmt.Errorf("%s: %w", entry.Name, err)
		}
		if actual != entry.ExpectedHash {
			return counts, fmt.Errorf("%s.stateHash: expected %s, actual %s", entry.Name, entry.ExpectedHash, actual)
		}
		counts.Hashes++
	}
	if err := compareFields("initialState", states.Hashes[0].State, game.InitialState()); err != nil {
		return counts, err
	}
	for _, entry := range battles.Cases {
		next, summary, err := game.Resolve(entry.State, entry.ActionsA, entry.ActionsB)
		if err != nil {
			return counts, fmt.Errorf("%s: %w", entry.Name, err)
		}
		if err := compareFields(entry.Name+".state", entry.ExpectedState, next); err != nil {
			return counts, err
		}
		if err := compareFields(entry.Name+".summary", entry.ExpectedSummary, summary); err != nil {
			return counts, err
		}
		hash, err := game.StateHash(entry.Context, next)
		if err != nil {
			return counts, err
		}
		if hash != entry.ExpectedHash {
			return counts, fmt.Errorf("%s.stateHash: expected %s, actual %s", entry.Name, entry.ExpectedHash, hash)
		}
		counts.Battles++
	}
	for _, entry := range protocol.Cases {
		encoding, err := game.EncodeActions(entry.Actions)
		if err != nil {
			return counts, fmt.Errorf("%s: %w", entry.Name, err)
		}
		if err := compareActionEncoding(entry.Name, entry.ExpectedEncoding, encoding); err != nil {
			return counts, err
		}
		actionsHash, err := game.ActionsHash(entry.Actions)
		if err != nil {
			return counts, err
		}
		if actionsHash != entry.ExpectedActionsHash {
			return counts, fmt.Errorf("%s.actionsHash: expected %s, actual %s", entry.Name, entry.ExpectedActionsHash, actionsHash)
		}
		commitment, err := game.Commitment(entry.Context, entry.Round, entry.Player, entry.Actions, entry.Salt)
		if err != nil {
			return counts, err
		}
		if commitment != entry.ExpectedCommitment {
			return counts, fmt.Errorf("%s.commitment: expected %s, actual %s", entry.Name, entry.ExpectedCommitment, commitment)
		}
		counts.Protocol++
	}
	return counts, nil
}
