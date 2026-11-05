package indexer

import (
	"io"
	"log"
	"os"
	"regexp"
	"strings"
)

var credentialURL = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)
var credentialField = regexp.MustCompile(`(?i)\b(password|pgpassword|private[_-]?key|keeper_private_key|token|api[_-]?key|secret|salt)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)`)
var credentialJSON = regexp.MustCompile(`(?i)("(?:password|private[_-]?key|keeper_private_key|token|api[_-]?key|secret|salt)"\s*:\s*)"[^"]*"`)

// Redact diagnostics only; public transaction hashes and archived game data remain intact.
func Redact(message string) string {
	message = credentialURL.ReplaceAllString(message, "${1}[redacted]@")
	message = credentialJSON.ReplaceAllString(message, "${1}\"[redacted]\"")
	message = credentialField.ReplaceAllString(message, "${1}${2}[redacted]")
	for _, name := range []string{"PGPASSWORD", "ARENA_DATABASE_PASSWORD", "KEEPER_PRIVATE_KEY"} {
		if value := os.Getenv(name); value != "" {
			message = strings.ReplaceAll(message, value, "[redacted]")
		}
	}
	return message
}

type diagnosticOutput struct{ target io.Writer }

func (w diagnosticOutput) Write(data []byte) (int, error) {
	_, err := io.WriteString(w.target, Redact(string(data)))
	if err != nil {
		return 0, err
	}
	return len(data), nil
}

func ConfigureLogging() { log.SetOutput(diagnosticOutput{log.Writer()}) }
