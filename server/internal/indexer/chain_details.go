package indexer

import (
	"database/sql"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

func (s *service) deploymentDetails(_ *http.Request, _ *sql.Tx, m metadata) (any, *apiError) {
	return map[string]any{"meta": m, "deployment": s.cfg.PublicDeployment}, nil
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
