package localchain

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestContractLogHandlerKeepsUnexpectedFaults(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(contractLogHandler{slog.NewTextHandler(&output, &slog.HandlerOptions{Level: slog.LevelWarn})}).With("conn", "local")
	logger.Warn("Served eth_call", "err", "execution reverted", "errdata", `"0x1f48997000000000"`, "case", "known")
	logger.Warn("Served eth_call", "err", "execution reverted", "errdata", `"0xdeadbeef"`, "case", "unknown")
	logger.Warn("Served eth_call", "err", "execution timeout", "errdata", `"0x1f489970"`, "case", "timeout")
	logger.Warn("Served eth_sendRawTransaction", "err", "execution reverted", "errdata", `"0x1f489970"`, "case", "broadcast")
	logger.Warn("Unclean shutdown detected", "case", "shutdown")
	text := output.String()
	if strings.Contains(text, "case=known") {
		t.Fatal("known contract rejection remained a warning")
	}
	for _, name := range []string{"unknown", "timeout", "broadcast", "shutdown"} {
		if !strings.Contains(text, "case="+name) {
			t.Fatalf("lost real diagnostic %s: %s", name, text)
		}
	}
}
