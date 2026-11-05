package squad

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"onchainarena/server/internal/game"
)

type vector struct {
	Name  string          `json:"name"`
	Kind  uint8           `json:"kind"`
	Input json.RawMessage `json:"input"`
}
type vectorResult struct {
	Name      string      `json:"name"`
	Accepted  bool        `json:"accepted"`
	Encoding  string      `json:"encoding,omitempty"`
	Hash      game.Hash   `json:"hash"`
	Topics    []game.Hash `json:"topics"`
	Rejection string      `json:"rejection,omitempty"`
}

func decodeInput(data json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func evaluate(entry vector) (vectorResult, error) {
	result := vectorResult{Name: entry.Name, Topics: []game.Hash{}}
	var encoded []byte
	var err error
	switch entry.Kind {
	case 0:
		var index uint8
		if err = decodeInput(entry.Input, &index); err != nil {
			return result, err
		}
		result.Hash, err = Domain(index)
		encoded = result.Hash[:]
	case 1:
		var input Rules
		if err = decodeInput(entry.Input, &input); err != nil {
			return result, err
		}
		encoded = EncodeRules(input)
	case 2:
		var input SquadInput
		if err = decodeInput(entry.Input, &input); err != nil {
			return result, err
		}
		encoded, err = EncodeSquad(input)
	case 3:
		var input ActionInput
		if err = decodeInput(entry.Input, &input); err != nil {
			return result, err
		}
		encoded, err = EncodeTurn(input)
	case 4:
		var input StateInput
		if err = decodeInput(entry.Input, &input); err != nil {
			return result, err
		}
		encoded, err = EncodeState(input)
	case 5:
		var input EventInput
		if err = decodeInput(entry.Input, &input); err != nil {
			return result, err
		}
		encoded, result.Topics, err = EncodeEvent(input)
	default:
		return result, fmt.Errorf("unknown protocol vector kind %d", entry.Kind)
	}
	if errors.Is(err, ErrInvalidProtocol) {
		result.Rejection = "InvalidProtocol"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Accepted = true
	result.Encoding = "0x" + hex.EncodeToString(encoded)
	if entry.Kind >= 1 && entry.Kind <= 4 {
		result.Hash = game.Keccak(encoded)
	}
	return result, nil
}

// This command computes independent ABI words; the launcher compares all three languages.
func CheckVectors(root string, output io.Writer) error {
	data, err := os.ReadFile(filepath.Join(root, "config", "squad-protocol-vectors.json"))
	if err != nil {
		return err
	}
	var input struct {
		Cases []vector `json:"cases"`
	}
	if err = json.Unmarshal(data, &input); err != nil {
		return err
	}
	if len(input.Cases) == 0 {
		return fmt.Errorf("squad protocol vectors are empty")
	}
	results := make([]vectorResult, 0, len(input.Cases))
	for _, entry := range input.Cases {
		result, failure := evaluate(entry)
		if failure != nil {
			return fmt.Errorf("%s: %w", entry.Name, failure)
		}
		results = append(results, result)
	}
	return json.NewEncoder(output).Encode(results)
}
