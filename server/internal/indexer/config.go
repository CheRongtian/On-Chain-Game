package indexer

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

type config struct {
	ChainID          uint64 `json:"chainId"`
	RPC              string `json:"rpcUrl"`
	Arena            string `json:"arenaAddress"`
	DeploymentBlock  string `json:"deploymentBlock"`
	DeploymentHash   string `json:"deploymentHash"`
	Engine           string `json:"engine"`
	From             uint64
	Database         string
	HTTP             string
	Confirmations    uint64
	ABI              abi.ABI
	KeeperEnabled    bool
	KeeperKey        string          `json:"-"`
	PublicDeployment json.RawMessage `json:"-"`
}

func readConfig(root string) (config, error) {
	return readDeploymentConfig(root, "deployment.json")
}

func readDeploymentConfig(root, file string) (config, error) {
	var cfg config
	data, err := os.ReadFile(filepath.Join(root, "client/public", file))
	if err != nil {
		return cfg, fmt.Errorf("read current local deployment: %w; start the backend first", err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	endpoint, parseErr := url.Parse(cfg.RPC)
	if parseErr != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" || cfg.ChainID != 31337 || !common.IsHexAddress(cfg.Arena) {
		return cfg, fmt.Errorf("invalid local deployment configuration")
	}
	cfg.PublicDeployment = append(json.RawMessage(nil), data...)
	if cfg.Engine == "" {
		cfg.Engine = "anvil"
	}
	if cfg.Engine != "anvil" && cfg.Engine != "geth" {
		return cfg, fmt.Errorf("unsupported local chain engine")
	}
	if internal := os.Getenv("BACKEND_RPC_URL"); internal != "" {
		if file == "deployment.json" && internal != "http://host.docker.internal:"+endpoint.Port() {
			return cfg, fmt.Errorf("BACKEND_RPC_URL must address the managed local chain on the Docker Desktop host")
		}
		cfg.RPC = "http://host.docker.internal:" + endpoint.Port()
	}
	cfg.Arena = strings.ToLower(cfg.Arena)
	cfg.From, err = strconv.ParseUint(cfg.DeploymentBlock, 10, 63)
	if err != nil {
		return cfg, fmt.Errorf("invalid deployment block: %w", err)
	}
	cfg.Database = os.Getenv("DATABASE_URL")
	if cfg.Database == "" {
		cfg.Database = "postgres://arena@127.0.0.1:55432/onchain_arena?sslmode=disable"
	}
	cfg.HTTP = os.Getenv("HTTP_ADDRESS")
	if cfg.HTTP == "" {
		cfg.HTTP = "127.0.0.1:18081"
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
		// Public development key, funded only on this project's local chain.
		cfg.KeeperKey = strings.Repeat("0", 63) + "3"
	}
	depth := os.Getenv("CONFIRMATION_DEPTH")
	if depth != "" {
		cfg.Confirmations, err = strconv.ParseUint(depth, 10, 63)
		if err != nil {
			return cfg, fmt.Errorf("invalid CONFIRMATION_DEPTH: %w", err)
		}
	}
	data, err = os.ReadFile(filepath.Join(root, ".local/deployments", cfg.DeploymentHash+".json"))
	if err != nil {
		return cfg, fmt.Errorf("read archived deployment ABI: %w", err)
	}
	var manifest struct {
		Artifact struct {
			ABI json.RawMessage `json:"abi"`
		} `json:"artifact"`
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		return cfg, err
	}
	data = manifest.Artifact.ABI
	cfg.ABI, err = abi.JSON(strings.NewReader(string(data)))
	return cfg, err
}
