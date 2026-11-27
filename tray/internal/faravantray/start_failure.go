package faravantray

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// The launcher writes only fixed categories. Never display saved text, paths,
// exception names, or the category itself. A live status always replaces this
// offline fallback. No countdown is invented from an old saved timestamp.
func startFailureLine(appPath string) string {
	const unavailable = "We can't connect to Faravan on this computer."
	file, err := os.Open(filepath.Join(filepath.Dir(appPath), "start-failure.json"))
	if err != nil { return unavailable }
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 { return unavailable }
	var row struct {
		Version int `json:"version"`
		Code string `json:"code"`
		At *int64 `json:"at"`
	}
	if json.Unmarshal(data, &row) != nil || row.Version != 1 || row.At == nil || *row.At < 0 || *row.At > 9007199254740991 { return unavailable }
	// Keep this list aligned with launch-status.mjs. Unknown/new records retain
	// the ordinary unavailable menu until both consumers understand them.
	switch row.Code {
	case "launch_lock_held", "app_unavailable", "app_start_failed", "sandbox_start_failed",
		"sandbox_ready_timeout", "sandbox_credential_store_failed", "cessation_unverified",
		"policy_unenforceable", "host_disk_low", "host_disk_unreadable", "wall_timeout":
		return "Faravan could not start."
	default:
		return unavailable
	}
}
