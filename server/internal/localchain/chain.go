package localchain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts/keystore"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/eth"
	"github.com/ethereum/go-ethereum/eth/catalyst"
	"github.com/ethereum/go-ethereum/eth/ethconfig"
	"github.com/ethereum/go-ethereum/eth/filters"
	"github.com/ethereum/go-ethereum/ethdb/pebble"
	gethlog "github.com/ethereum/go-ethereum/log"
	"github.com/ethereum/go-ethereum/node"
	"github.com/ethereum/go-ethereum/p2p"
	"github.com/ethereum/go-ethereum/params"
	"github.com/ethereum/go-ethereum/rpc"
	"github.com/ethereum/go-ethereum/triedb"
)

// These are the public development accounts already used by the browser.
var playerKeys = []string{
	"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	"59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
}

type checkpoint struct {
	Number uint64      `json:"number"`
	Hash   common.Hash `json:"hash"`
}

type Chain struct {
	stack   *node.Node
	backend *eth.Ethereum
	beacon  *catalyst.SimulatedBeacon
	handler *rpc.Server
	archive string
	saved   *checkpoint
	failure string
	mu      sync.Mutex
}

func Open(root string) (_ *Chain, err error) {
	archive := filepath.Join(root, ".local/archive")
	dataDir := filepath.Join(root, ".local/geth")
	if _, exists := os.Stat(filepath.Join(archive, "confirmed.json")); exists == nil {
		if _, err = os.Stat(filepath.Join(dataDir, "geth/chaindata")); err != nil {
			return nil, fmt.Errorf("the confirmed archive has no matching Geth database; restore it before starting: %w", err)
		}
	}
	gethlog.SetDefault(gethlog.NewLogger(gethlog.NewTerminalHandlerWithLevel(os.Stderr, slog.LevelWarn, false)))
	cfg := node.DefaultConfig
	cfg.Name, cfg.Version, cfg.DataDir = "geth", "1.16.5-arena", dataDir
	cfg.HTTPHost, cfg.WSHost, cfg.IPCPath = "", "", ""
	cfg.P2P = p2p.Config{MaxPeers: 0, NoDiscovery: true, ListenAddr: ""}
	stack, err := node.New(&cfg)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = stack.Close()
		}
	}()
	keys := keystore.NewKeyStore(filepath.Join(dataDir, "keystore"), keystore.LightScryptN, keystore.LightScryptP)
	alloc := types.GenesisAlloc{}
	var funder common.Address
	for _, encoded := range playerKeys {
		key, keyErr := crypto.HexToECDSA(encoded)
		if keyErr != nil {
			return nil, keyErr
		}
		address := crypto.PubkeyToAddress(key.PublicKey)
		if funder == (common.Address{}) {
			funder = address
		}
		if !keys.HasAddress(address) {
			if _, err = keys.ImportECDSA(key, ""); err != nil {
				return nil, err
			}
		}
		for _, account := range keys.Accounts() {
			if account.Address == address {
				if err = keys.Unlock(account, ""); err != nil {
					return nil, err
				}
			}
		}
		alloc[address] = types.Account{Balance: new(big.Int).Mul(big.NewInt(1_000_000), big.NewInt(1e18))}
	}
	stack.AccountManager().AddBackend(keys)
	rules := *params.AllDevChainProtocolChanges
	rules.ChainID = big.NewInt(31337)
	rules.PragueTime, rules.OsakaTime, rules.VerkleTime = nil, nil, nil
	ethCfg := ethconfig.Defaults
	ethCfg.Genesis = &core.Genesis{Config: &rules, GasLimit: 30_000_000, Alloc: alloc}
	ethCfg.SyncMode, ethCfg.StateScheme, ethCfg.NoPruning = ethconfig.FullSync, rawdb.HashScheme, true
	ethCfg.TransactionHistory = 0
	ethCfg.TxLookupLimit, ethCfg.LogHistory, ethCfg.SnapshotCache = 0, 0, 0
	ethCfg.DatabaseCache, ethCfg.TrieDirtyCache = 128, 0
	ethCfg.Miner.GasCeil, ethCfg.Miner.GasPrice = 30_000_000, big.NewInt(1)
	// Initialize genesis before the freezer starts reading the canonical head.
	directory := stack.ResolvePath("chaindata")
	if rawdb.PreexistingDatabase(directory) == "" {
		kv, openErr := pebble.New(directory, ethCfg.DatabaseCache, ethCfg.DatabaseHandles, "", false)
		if openErr != nil {
			return nil, openErr
		}
		db := rawdb.NewDatabase(kv)
		trie := triedb.NewDatabase(db, triedb.HashDefaults)
		_, initErr := ethCfg.Genesis.Commit(db, trie)
		if initErr == nil {
			initErr = db.SyncKeyValue()
		}
		if err = errors.Join(initErr, trie.Close(), db.Close()); err != nil {
			return nil, fmt.Errorf("initialize local genesis: %w", err)
		}
	}
	backend, err := eth.New(stack, &ethCfg)
	if err != nil {
		return nil, err
	}
	filterSystem := filters.NewFilterSystem(backend.APIBackend, filters.Config{})
	c := &Chain{stack: stack, backend: backend, archive: archive}
	stack.RegisterAPIs([]rpc.API{
		{Namespace: "eth", Service: filters.NewFilterAPI(filterSystem)},
		{Namespace: "arena", Service: &localAPI{chain: c}},
	})
	if err = stack.Start(); err != nil {
		return nil, err
	}
	beacon, err := catalyst.NewSimulatedBeacon(0, funder, backend)
	if err != nil {
		return nil, err
	}
	c.beacon = beacon
	c.handler, err = stack.RPCHandler()
	if err != nil {
		return nil, err
	}
	data, readErr := os.ReadFile(filepath.Join(archive, "confirmed.json"))
	if readErr == nil {
		var saved checkpoint
		if err = json.Unmarshal(data, &saved); err != nil {
			return nil, fmt.Errorf("invalid durable checkpoint: %w", err)
		}
		if backend.BlockChain().GetCanonicalHash(saved.Number) != saved.Hash {
			return nil, fmt.Errorf("Geth did not recover the previously confirmed block %d; existing files were retained", saved.Number)
		}
		c.saved = &saved
	} else if !os.IsNotExist(readErr) {
		return nil, readErr
	}
	if err = c.persist(); err != nil {
		return nil, err
	}
	if err = c.fundKeeper(funder); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Chain) fundKeeper(funder common.Address) error {
	if value := os.Getenv("KEEPER_ENABLED"); value != "" {
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("KEEPER_ENABLED must be true or false")
		}
		if !enabled {
			return nil
		}
	}
	encoded := os.Getenv("KEEPER_PRIVATE_KEY")
	if encoded == "" {
		encoded = strings.Repeat("0", 63) + "3"
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(encoded, "0x"))
	if err != nil {
		return fmt.Errorf("invalid KEEPER_PRIVATE_KEY")
	}
	address := crypto.PubkeyToAddress(key.PublicKey)
	for _, player := range c.stack.AccountManager().Accounts() {
		if address == player {
			return fmt.Errorf("Keeper must use an account separate from both players")
		}
	}
	client := c.stack.Attach()
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var balance hexutil.Big
	if err = client.CallContext(ctx, &balance, "eth_getBalance", address, "latest"); err != nil {
		return err
	}
	if (*big.Int)(&balance).Sign() != 0 {
		return nil
	}
	var hash common.Hash
	if err = client.CallContext(ctx, &hash, "eth_sendTransaction", map[string]any{
		"from": funder, "to": address, "value": hexutil.EncodeBig(new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1e18))), "gas": "0x5208",
	}); err != nil {
		return fmt.Errorf("fund local Keeper: %w", err)
	}
	if err = c.mine(); err != nil {
		return err
	}
	var receipt *types.Receipt
	if err = client.CallContext(ctx, &receipt, "eth_getTransactionReceipt", hash); err != nil {
		return err
	}
	if receipt == nil || receipt.Status != types.ReceiptStatusSuccessful {
		return fmt.Errorf("Keeper funding was not mined; restart to retry")
	}
	return c.persist()
}

func (c *Chain) mine() error {
	if err := c.backend.TxPool().Sync(); err != nil {
		return err
	}
	pending, _ := c.backend.TxPool().Stats()
	if pending == 0 {
		return nil
	}
	before := c.backend.BlockChain().CurrentBlock().Hash()
	if c.beacon.Commit() == before {
		return fmt.Errorf("Geth could not produce the pending block")
	}
	return nil
}

func (c *Chain) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	err := c.persist()
	_ = c.beacon.Stop()
	return errors.Join(err, c.stack.Close())
}
