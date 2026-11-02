package localchain

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ethereum/go-ethereum/core/types"
)

func saveJSON(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(file+".tmp", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(file+".tmp", file); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(file))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (c *Chain) persist() error {
	head := c.backend.BlockChain().CurrentBlock()
	if c.saved != nil && c.saved.Hash == head.Hash() {
		return nil
	}
	if c.saved != nil && c.backend.BlockChain().GetCanonicalHash(c.saved.Number) != c.saved.Hash {
		return fmt.Errorf("the durable archive no longer matches the canonical chain; existing archives were retained")
	}
	if err := c.backend.BlockChain().TrieDB().Commit(head.Root, false); err != nil {
		return fmt.Errorf("flush archive state: %w", err)
	}
	if err := c.backend.ChainDb().SyncAncient(); err != nil {
		return fmt.Errorf("sync chain history: %w", err)
	}
	if err := c.backend.ChainDb().SyncKeyValue(); err != nil {
		return fmt.Errorf("sync chain database: %w", err)
	}
	from := uint64(0)
	if c.saved != nil {
		from = c.saved.Number + 1
	}
	for number := from; number <= head.Number.Uint64(); number++ {
		block := c.backend.BlockChain().GetBlockByNumber(number)
		if block == nil {
			return fmt.Errorf("missing archive block %d", number)
		}
		receipts := c.backend.BlockChain().GetReceiptsByHash(block.Hash())
		if len(receipts) != len(block.Transactions()) {
			return fmt.Errorf("incomplete receipts in archive block %d", number)
		}
		record := struct {
			Header       *types.Header      `json:"header"`
			Transactions types.Transactions `json:"transactions"`
			Receipts     types.Receipts     `json:"receipts"`
		}{block.Header(), block.Transactions(), receipts}
		if err := saveJSON(filepath.Join(c.archive, "blocks", fmt.Sprintf("%d.json", number)), record); err != nil {
			return fmt.Errorf("save archive block %d: %w", number, err)
		}
	}
	point := checkpoint{Number: head.Number.Uint64(), Hash: head.Hash()}
	if err := saveJSON(filepath.Join(c.archive, "confirmed.json"), point); err != nil {
		return err
	}
	c.saved = &point
	return nil
}
