package indexer

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
)

func (c *checker) expectMetric(name, want string) error {
	response, err := c.client.Get("http://" + c.cfg.HTTP + "/metrics")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode != 200 || !strings.Contains("\n"+string(data), "\n"+name+" "+want+"\n") {
		return fmt.Errorf("operational metric %s did not report %s", name, want)
	}
	return nil
}

// CheckOperations exercises the shared controls without opening a network listener.
func CheckOperations() error {
	transaction := "0x" + strings.Repeat("ab", 32)
	for _, input := range []string{
		"postgres://arena:example-database-password@localhost/db?token=example-token",
		"password='example-database-password' private_key=example-key salt=example-salt",
		`{"password":"example-database-password","privateKey":"example-key","salt":"example-salt"}`,
	} {
		output := Redact(input + " tx=" + transaction)
		for _, secret := range []string{"example-database-password", "example-token", "example-key", "example-salt"} {
			if strings.Contains(output, secret) {
				return fmt.Errorf("diagnostic redaction failed")
			}
		}
		if !strings.Contains(output, transaction) {
			return fmt.Errorf("redaction removed a public transaction hash")
		}
	}
	var budget requestBudget
	now := time.Now()
	for i := 0; i < 32; i++ {
		if !budget.take(now, 8, 32) {
			return fmt.Errorf("request burst allowance is too small")
		}
	}
	if budget.take(now, 8, 32) || !budget.take(now.Add(time.Second/8), 8, 32) {
		return fmt.Errorf("request budget does not enforce or replenish its allowance")
	}
	s := &service{}
	handler := s.limited(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	limited := false
	for i := 0; i < 400; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/deployments", nil))
		if response.Code == 429 {
			limited = true
			if response.Header().Get("Retry-After") != "1" {
				return fmt.Errorf("rate limit lacks a retry instruction")
			}
		}
	}
	if !limited {
		return fmt.Errorf("business requests were never limited")
	}
	for _, path := range []string{"/health", "/ready", "/sync", "/metrics", "/events"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 {
			return fmt.Errorf("health or reconnect traffic inherited business throttling")
		}
	}
	s.ops.streams.Store(16)
	response := httptest.NewRecorder()
	s.stream(response, httptest.NewRequest("GET", "/events", nil))
	if response.Code != 429 || s.ops.streams.Load() != 16 {
		return fmt.Errorf("event stream capacity is not released correctly")
	}
	for _, query := range []string{"limit=0", "limit=101", "limit=-1", "offset=-1", "offset=bad"} {
		if _, _, failure := pagination(httptest.NewRequest("GET", "/matches?"+query, nil)); failure == nil {
			return fmt.Errorf("pagination accepted an unsupported range")
		}
	}
	if limit, _, failure := pagination(httptest.NewRequest("GET", "/matches?limit=100", nil)); failure != nil || limit != 100 {
		return fmt.Errorf("valid pagination was rejected")
	}
	fmt.Println("PASS: operational redaction, request budgets, probe exemptions, stream capacity and pagination boundaries.")
	return nil
}
