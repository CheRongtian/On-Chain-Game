package indexer

import (
	"database/sql"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

func (s *service) deploymentDetails(_ *http.Request, _ *sql.Tx, m metadata) (any, *apiError) {
	return map[string]any{"meta": m, "deployment": s.cfg.PublicDeployment}, nil
}

func (s *service) accountDetails(r *http.Request, _ *sql.Tx, m metadata) (any, *apiError) {
	if !common.IsHexAddress(r.PathValue("address")) {
		return nil, &apiError{400, "invalid_address", "Enter a 20-byte account or contract address."}
	}
	var number *big.Int
	if text := r.URL.Query().Get("block"); text != "" && text != "latest" {
		value, err := strconv.ParseUint(text, 10, 63)
		if err != nil {
			return nil, &apiError{400, "invalid_block", "Use latest or a nonnegative decimal block number."}
		}
		number = new(big.Int).SetUint64(value)
	}
	address := common.HexToAddress(r.PathValue("address"))
	header, err := s.chain.HeaderByNumber(r.Context(), number)
	if errors.Is(err, ethereum.NotFound) {
		return nil, &apiError{404, "block_unavailable", "The requested block is unavailable on this chain."}
	}
	if err != nil {
		return nil, &apiError{503, "rpc_unavailable", "The local chain is temporarily unavailable."}
	}
	balance, err := s.chain.BalanceAt(r.Context(), address, header.Number)
	if err != nil {
		message := "The requested historical account state could not be read."
		if s.cfg.Engine == "anvil" {
			message += " Old Anvil history retains only its saved state window."
		}
		return nil, &apiError{503, "state_unavailable", message}
	}
	nonce, err := s.chain.NonceAt(r.Context(), address, header.Number)
	if err != nil {
		return nil, &apiError{503, "state_unavailable", "The account nonce could not be read."}
	}
	code, err := s.chain.CodeAt(r.Context(), address, header.Number)
	if err != nil {
		return nil, &apiError{503, "state_unavailable", "The contract bytecode could not be read."}
	}
	value := map[string]any{"address": address.Hex(), "blockNumber": header.Number.String(), "blockHash": header.Hash().Hex(),
		"balanceWei": balance.String(), "nonce": nonce, "code": "0x" + hex.EncodeToString(code)}
	if slot := r.URL.Query().Get("slot"); slot != "" {
		if len(slot) != 66 || slot[:2] != "0x" {
			return nil, &apiError{400, "invalid_slot", "Use a 32-byte hexadecimal storage slot."}
		}
		if _, err := hex.DecodeString(slot[2:]); err != nil {
			return nil, &apiError{400, "invalid_slot", "Use a hexadecimal storage slot."}
		}
		stored, err := s.chain.StorageAt(r.Context(), address, common.HexToHash(slot), header.Number)
		if err != nil {
			return nil, &apiError{503, "state_unavailable", "The historical storage value could not be read."}
		}
		value["slot"], value["storage"] = slot, "0x"+hex.EncodeToString(stored)
	}
	return map[string]any{"meta": m, "account": value}, nil
}

func (s *service) transactionDetails(r *http.Request, _ *sql.Tx, m metadata) (any, *apiError) {
	hash := r.PathValue("hash")
	if len(hash) != 66 || hash[:2] != "0x" {
		return nil, &apiError{400, "invalid_transaction", "Enter a 32-byte transaction hash."}
	}
	if _, err := hex.DecodeString(hash[2:]); err != nil {
		return nil, &apiError{400, "invalid_transaction", "Enter a hexadecimal transaction hash."}
	}
	transaction, pending, err := s.chain.TransactionByHash(r.Context(), common.HexToHash(hash))
	if errors.Is(err, ethereum.NotFound) {
		return nil, &apiError{404, "transaction_not_found", "This transaction is not present on the current chain."}
	}
	if err != nil {
		return nil, &apiError{503, "rpc_unavailable", "The local chain is temporarily unavailable."}
	}
	from, err := types.Sender(types.LatestSignerForChainID(transaction.ChainId()), transaction)
	if err != nil {
		return nil, &apiError{503, "invalid_transaction", "The transaction sender could not be recovered."}
	}
	detail := map[string]any{
		"hash": transaction.Hash().Hex(), "from": from.Hex(), "to": transaction.To(),
		"nonce": transaction.Nonce(), "valueWei": transaction.Value().String(),
		"gasLimit": transaction.Gas(), "status": "Pending", "fictitiousCurrency": true,
	}
	if pending {
		return map[string]any{"meta": m, "transaction": detail}, nil
	}
	receipt, err := s.chain.TransactionReceipt(r.Context(), transaction.Hash())
	if errors.Is(err, ethereum.NotFound) {
		return nil, &apiError{404, "transaction_not_found", "The transaction receipt is no longer on the current chain."}
	}
	if err != nil {
		return nil, &apiError{503, "rpc_unavailable", "The transaction receipt could not be read."}
	}
	header, err := s.chain.HeaderByNumber(r.Context(), receipt.BlockNumber)
	if err != nil {
		return nil, &apiError{503, "rpc_unavailable", "The transaction block could not be read."}
	}
	if header.Hash() != receipt.BlockHash {
		return nil, &apiError{409, "reorganized_transaction", "The transaction belongs to a replaced branch. Refresh after indexing catches up."}
	}
	if receipt.Status == types.ReceiptStatusSuccessful {
		detail["status"] = "Succeeded"
	} else {
		detail["status"] = "Failed"
	}
	price := receipt.EffectiveGasPrice
	if price == nil {
		price = transaction.GasPrice()
	}
	detail["blockNumber"], detail["blockHash"] = receipt.BlockNumber.String(), receipt.BlockHash.Hex()
	detail["blockTime"] = time.Unix(int64(header.Time), 0).UTC()
	detail["gasUsed"], detail["effectiveGasPriceWei"] = receipt.GasUsed, price.String()
	detail["feeWei"] = new(big.Int).Mul(new(big.Int).SetUint64(receipt.GasUsed), price).String()
	detail["contractAddress"], detail["transactionIndex"] = receipt.ContractAddress, receipt.TransactionIndex
	detail["confirmation"] = m.confirmation(receipt.BlockNumber.Uint64())
	return map[string]any{"meta": m, "transaction": detail}, nil
}
