package indexer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

type config struct {
	ChainID         uint64 `json:"chainId"`
	RPC             string `json:"rpcUrl"`
	Arena           string `json:"arenaAddress"`
	DeploymentBlock string `json:"deploymentBlock"`
	From            uint64
	Database        string
	HTTP            string
	Confirmations   uint64
	ABI             abi.ABI
	KeeperEnabled   bool
	KeeperKey       string `json:"-"`
}

func readConfig(root string) (config, error) {
	var cfg config
	data, err := os.ReadFile(filepath.Join(root, "client/public/deployment.json"))
	if err != nil {
		return cfg, fmt.Errorf("read current local deployment: %w; start the backend first", err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	if cfg.ChainID != 31337 || cfg.RPC != "http://127.0.0.1:8545" || !common.IsHexAddress(cfg.Arena) {
		return cfg, fmt.Errorf("invalid local deployment configuration")
	}
	cfg.Arena = strings.ToLower(cfg.Arena)
	cfg.From, err = strconv.ParseUint(cfg.DeploymentBlock, 10, 63)
	if err != nil {
		return cfg, fmt.Errorf("invalid deployment block: %w", err)
	}
	cfg.Database = os.Getenv("DATABASE_URL")
	if cfg.Database == "" {
		cfg.Database = "postgres://localhost:5432/onchain_arena?sslmode=disable"
	}
	cfg.HTTP = os.Getenv("HTTP_ADDRESS")
	if cfg.HTTP == "" {
		cfg.HTTP = "127.0.0.1:8080"
	}
	cfg.KeeperEnabled = true
	if value := os.Getenv("KEEPER_ENABLED"); value != "" {
		cfg.KeeperEnabled, err = strconv.ParseBool(value)
		if err != nil {
			return cfg, fmt.Errorf("KEEPER_ENABLED must be true or false")
		}
	}
	cfg.KeeperKey = os.Getenv("KEEPER_PRIVATE_KEY")
	if cfg.KeeperKey == "" {
		// Public development key, funded only on this project's local Anvil chain.
		cfg.KeeperKey = strings.Repeat("0", 63) + "3"
	}
	depth := os.Getenv("CONFIRMATION_DEPTH")
	if depth != "" {
		cfg.Confirmations, err = strconv.ParseUint(depth, 10, 63)
		if err != nil {
			return cfg, fmt.Errorf("invalid CONFIRMATION_DEPTH: %w", err)
		}
	}
	data, err = os.ReadFile(filepath.Join(root, "contracts/out/Arena.sol/Arena.json"))
	if err != nil {
		return cfg, fmt.Errorf("read compiled Arena ABI: %w", err)
	}
	var artifact struct {
		ABI json.RawMessage `json:"abi"`
	}
	if err = json.Unmarshal(data, &artifact); err != nil {
		return cfg, err
	}
	cfg.ABI, err = abi.JSON(strings.NewReader(string(artifact.ABI)))
	return cfg, err
}
