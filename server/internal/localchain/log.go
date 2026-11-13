package localchain

import (
	"context"
	"log/slog"
	"strings"
)

// Contract business rejections remain RPC errors; callers and acceptance check them explicitly.
// Keep unknown reverts and node/storage/transport faults visible at their original level.
type contractLogHandler struct{ slog.Handler }

func (h contractLogHandler) Handle(ctx context.Context, record slog.Record) error {
	if record.Message == "Served eth_call" {
		var reason, data string
		record.Attrs(func(attr slog.Attr) bool {
			switch attr.Key {
			case "err":
				reason = attr.Value.String()
			case "errdata":
				data = attr.Value.String()
			}
			return true
		})
		start := strings.Index(data, "0x")
		if reason == "execution reverted" && start >= 0 && len(data) >= start+10 && knownContractRejection(data[start:start+10]) {
			record.Level = slog.LevelDebug
			if !h.Handler.Enabled(ctx, record.Level) {
				return nil
			}
		}
	}
	return h.Handler.Handle(ctx, record)
}

func (h contractLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return contractLogHandler{h.Handler.WithAttrs(attrs)}
}

func (h contractLogHandler) WithGroup(name string) slog.Handler {
	return contractLogHandler{h.Handler.WithGroup(name)}
}

func knownContractRejection(selector string) bool {
	// Frozen SquadArena custom errors, checked against the compiled ABI by acceptance.
	switch selector {
	case "0x64dbd987", "0x879d3b85", "0x5054097b", // AlreadyCommitted, AlreadyRevealed, CommitmentMismatch
		"0x1f489970", "0x67680913", "0x98d23bb0", // DeadlineNotPassed, DeadlinePassed, InvalidPhase
		"0x07f1c7d4", "0x5c31c3b5", "0xc66f47bf", // InvalidProtocol, InvalidTimeoutPhase, NotCreator
		"0x87080b97", "0x56211b68", "0xbc424803", // NotPlayer, OpponentMissing, RoomFull
		"0x901c08ae", "0xbe4b34ba", "0x7dadab21", "0x2687f1b4": // SelfJoin, StaleRound, UnknownMap, UnknownMatch
		return true
	default:
		return false
	}
}
