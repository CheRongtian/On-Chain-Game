package squad

import (
	"errors"
	"math/big"
	"regexp"
	"strings"
)

type RulesetProfile struct {
	RulesetID string   `json:"rulesetId"`
	Schemas   []uint16 `json:"schemas"`
	ABI       string   `json:"abi"`
	Engine    string   `json:"engine"`
	Replay    bool     `json:"replay"`
}
type DeploymentBinding struct {
	ChainID        string   `json:"chainId"`
	Arena          string   `json:"arena"`
	DeploymentHash string   `json:"deploymentHash"`
	RulesetID      string   `json:"rulesetId"`
	Schemas        []uint16 `json:"schemas"`
	ABI            string   `json:"abi"`
}
type Selection struct {
	Engine    string `json:"engine"`
	GlobalKey string `json:"globalKey"`
	LocalKey  string `json:"localKey"`
	URL       string `json:"url"`
}

var decimalID = regexp.MustCompile(`^[1-9][0-9]*$`)
var addressID = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
var hashID = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

func validID(value string) bool {
	if !decimalID.MatchString(value) {
		return false
	}
	n, ok := new(big.Int).SetString(value, 10)
	return ok && n.BitLen() <= 256
}
func normalizeBinding(value DeploymentBinding) (DeploymentBinding, error) {
	if !validID(value.ChainID) || !addressID.MatchString(value.Arena) || !hashID.MatchString(value.DeploymentHash) || !hashID.MatchString(value.RulesetID) || len(value.Schemas) != 3 {
		return value, errors.New("invalid_identity")
	}
	for _, schema := range value.Schemas {
		if schema == 0 {
			return value, errors.New("invalid_identity")
		}
	}
	value.Arena = strings.ToLower(value.Arena)
	value.DeploymentHash = strings.ToLower(value.DeploymentHash)
	value.RulesetID = strings.ToLower(value.RulesetID)
	return value, nil
}
func sameSchemas(a, b []uint16) bool {
	if len(a) != 3 || len(b) != 3 {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Selection does not advertise a replay implementation while only codecs exist.
func SelectRuleset(profiles []RulesetProfile, registered, observed DeploymentBinding, capability, matchID string) (Selection, error) {
	var empty Selection
	expected, err := normalizeBinding(registered)
	if err != nil {
		return empty, err
	}
	actual, err := normalizeBinding(observed)
	if err != nil {
		return empty, err
	}
	if !validID(matchID) {
		return empty, errors.New("invalid_identity")
	}
	if expected.ChainID != actual.ChainID || expected.Arena != actual.Arena || expected.DeploymentHash != actual.DeploymentHash || expected.RulesetID != actual.RulesetID || expected.ABI != actual.ABI || !sameSchemas(expected.Schemas, actual.Schemas) {
		return empty, errors.New("metadata_mismatch")
	}
	var selected *RulesetProfile
	for i := range profiles {
		profile := &profiles[i]
		if strings.ToLower(profile.RulesetID) != actual.RulesetID || profile.ABI != actual.ABI || !sameSchemas(profile.Schemas, actual.Schemas) {
			continue
		}
		if selected != nil {
			return empty, errors.New("unsupported_ruleset")
		}
		selected = profile
	}
	if selected == nil || (selected.Engine != "fixed" && selected.Engine != "squad") {
		return empty, errors.New("unsupported_ruleset")
	}
	if capability == "replay" && !selected.Replay {
		return empty, errors.New("replay_unavailable")
	}
	return Selection{selected.Engine, actual.ChainID + ":" + actual.Arena + ":" + matchID, actual.ChainID + ":" + actual.Arena + ":" + actual.DeploymentHash + ":" + matchID, "/chains/" + actual.ChainID + "/arenas/" + actual.Arena + "/matches/" + matchID + "?deployment=" + actual.DeploymentHash}, nil
}
