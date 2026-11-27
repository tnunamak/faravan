package faravantray

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

const savedStartFailure = `{"version":1,"code":"sandbox_start_failed","kind":"Error","at":123,"message":"PRIVATE_RAW_ERROR"}`

func failureClient(t *testing.T) LocalClient {
	t.Helper()
	c := LocalClient{AppPath: filepath.Join(t.TempDir(), "v1", "app.json"), Alive: func(int) bool { return true }}
	writeRecord(t, filepath.Join(filepath.Dir(c.AppPath), "start-failure.json"), savedStartFailure)
	return c
}

func TestSavedStartFailureMenuAndQuit(t *testing.T) {
	for _, mode := range []string{"missing", "stale", "malformed", "unreachable"} {
		t.Run(mode, func(t *testing.T) {
			c := failureClient(t)
			if mode != "missing" { writeRecord(t, c.AppPath, appRecord(1234)) }
			if mode == "stale" { c.Alive = func(int) bool { return false } }
			if mode == "malformed" { writeRecord(t, c.AppPath, "{") }
			c.AppClient.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("PRIVATE_RAW_ERROR") })}
			connection := c.Discover(context.Background())
			if connection.Menu.Status != "Faravan could not start." { t.Fatalf("headline: %q", connection.Menu.Status) }
			if connection.Menu.Entries[0].Label != connection.Menu.Status || !connection.Menu.Entries[0].Disabled { t.Fatal("failure must be a plain disabled status line") }
			for _, entry := range connection.Menu.Entries {
				if entry.ID == "quit" && entry.Disabled { t.Fatal("Quit disabled during startup backoff") }
			}
			if !hasEntry(connection.Menu, "quit") { t.Fatal("Quit missing") }
			if hasEntry(connection.Menu, "start") != (mode == "missing" || mode == "stale") { t.Fatal("unsafe Start mapping") }
			text := strings.ToLower(strings.Join(connection.Menu.Labels(), " "))
			for _, word := range []string{"private_raw_error", "sandbox_start_failed", "verdict", "receipt", "attempt", "settled", "lease"} {
				if strings.Contains(text, word) { t.Fatalf("unsafe menu word %q", word) }
			}
		})
	}
}

func TestSavedStartFailureLiveAppWins(t *testing.T) {
	c := failureClient(t)
	writeRecord(t, c.AppPath, appRecord(1234))
	c.AppClient.HTTPClient = appHTTP(t, func(r *http.Request) string {
		if r.URL.Path == "/api/approvals" { return `[]` }
		return `{"iconState":"Paused"}`
	})
	connection := c.Discover(context.Background())
	if connection.App == nil || connection.Status == nil || connection.Menu.State != VisualPaused || strings.Contains(connection.Menu.Status, "could not start") { t.Fatal("saved failure overrode live app") }
}

func TestSavedStartFailureRejectsMalformedRecords(t *testing.T) {
	for name, row := range map[string]string{
		"bad JSON": "{", "null": "null", "version": `{"version":2,"code":"app_start_failed","at":1}`,
		"unknown code": `{"version":1,"code":"PRIVATE_RAW_ERROR","at":1}`,
		"missing time": `{"version":1,"code":"app_start_failed"}`,
		"negative time": `{"version":1,"code":"app_start_failed","at":-1}`,
		"fractional time": `{"version":1,"code":"app_start_failed","at":1.5}`,
		"unsafe time": `{"version":1,"code":"app_start_failed","at":9007199254740992}`,
		"oversized": savedStartFailure + strings.Repeat(" ", 4096),
	} {
		t.Run(name, func(t *testing.T) {
			c := failureClient(t)
			writeRecord(t, filepath.Join(filepath.Dir(c.AppPath), "start-failure.json"), row)
			connection := c.Discover(context.Background())
			if connection.Menu.Status != "We can't connect to Faravan on this computer." { t.Fatalf("accepted malformed failure: %q", connection.Menu.Status) }
		})
	}
}
