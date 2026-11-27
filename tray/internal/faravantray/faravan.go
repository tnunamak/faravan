// Package faravantray is the small boundary between the native Faravan tray
// helper and the local v1 app. It owns no lending logic.
package faravantray

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"
)

const defaultPollInterval = 2 * time.Second

// VisualState is the small visual vocabulary exposed by the tray icon.
type VisualState string

const (
	VisualActive    VisualState = "active"
	VisualIdle      VisualState = "idle"
	VisualAttention VisualState = "attention"
	VisualPaused    VisualState = "paused"
	VisualError     VisualState = "error"
)

// HomePath mirrors the app's single data directory. The app moves old profiles.
func HomePath() (string, error) {
  if home := os.Getenv("FARAVAN_HOME"); home != "" { return home, nil }
  if home := os.Getenv("FARAVAN_DATA_HOME"); home != "" {
    if !filepath.IsAbs(home) { return "", fmt.Errorf("FARAVAN_DATA_HOME must be absolute") }
    return home, nil
  }
  home, err := os.UserHomeDir()
  if err != nil { return "", err }
  if _, err := installedChannel(); err != nil { return "", err }
  if runtime.GOOS == "darwin" { return filepath.Join(home, "Library", "Application Support", "Faravan"), nil }
  if runtime.GOOS == "windows" { return filepath.Join(windowsDataBase(os.Getenv("LOCALAPPDATA"), home), "Faravan"), nil }
  base := os.Getenv("XDG_DATA_HOME")
  if base == "" || !filepath.IsAbs(base) { base = filepath.Join(home, ".local", "share") }
  return filepath.Join(base, "Faravan"), nil
}

type channelFile struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	DataFolder       string `json:"dataFolder"`
	BundleID         string `json:"bundleId"`
	HelperBundleID   string `json:"helperBundleId"`
	LaunchAgentLabel string `json:"launchAgentLabel"`
	LinuxPrefix      string `json:"linuxPrefix"`
}

func validChannel(ch channelFile) bool {
	fields := []string{ch.ID, ch.Name, ch.DataFolder, ch.BundleID, ch.HelperBundleID, ch.LaunchAgentLabel, ch.LinuxPrefix}
	for _, field := range fields {
		if strings.TrimSpace(field) == "" || field != strings.TrimSpace(field) || hasChannelControl(field) {
			return false
		}
	}
	if !validBundleID(ch.BundleID) || !validBundleID(ch.HelperBundleID) {
		return false
	}
	if ch.ID != strings.TrimSpace(ch.ID) || strings.Contains(ch.DataFolder, "..") || strings.HasSuffix(ch.DataFolder, ".") || strings.HasSuffix(ch.DataFolder, " ") {
		return false
	}
	for i, r := range ch.DataFolder {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune(" ._+-", r)) {
			return false
		}
		if i == 0 && !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("._+-", r)) {
			return false
		}
	}
	if ch.ID == "faravan" {
		return ch.Name == "Faravan" && ch.DataFolder == "Faravan" && ch.BundleID == "com.faravan.app" &&
			ch.HelperBundleID == "com.faravan.app.notify" && ch.LaunchAgentLabel == "com.faravan.agent" && ch.LinuxPrefix == "faravan"
	}
	return true
}

func validBundleID(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, r := range part {
			if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	return true
}

func hasChannelControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) && (r <= 0x1f || r == 0x7f) {
			return true
		}
	}
	return false
}

func absoluteWindowsPath(value string) bool {
	if len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z' || value[0] >= 'a' && value[0] <= 'z') && value[1] == ':' && (value[2] == '\\' || value[2] == '/')) {
		return true
	}
	unc := strings.ReplaceAll(value, "/", `\`)
	if !strings.HasPrefix(unc, `\\`) {
		return false
	}
	parts := strings.Split(unc[2:], `\`)
	return len(parts) >= 2 && parts[0] != "" && parts[1] != ""
}

func windowsDataBase(localAppData, home string) string {
	if absoluteWindowsPath(localAppData) {
		return localAppData
	}
	return filepath.Join(home, "AppData", "Local")
}

func installedChannel() (channelFile, error) {
	exe, err := os.Executable()
	if err != nil {
		return channelFile{}, nil
	}
	return channelBeside(exe)
}

// channelBeside gives the installed app's channel.json authority over stray
// metadata beside a Mac executable. Wrong-layout-only metadata is an error.
func channelBeside(exe string) (channelFile, error) {
	dir := filepath.Dir(exe)
	adjacent := filepath.Join(dir, "channel.json")
	macResources := filepath.Join(dir, "..", "Resources", "faravan", "channel.json")
	expected, alternate := adjacent, macResources
	if filepath.Base(dir) == "MacOS" {
		expected, alternate = macResources, adjacent
	}
	channelAt := func(path string) (channelFile, bool, error) {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return channelFile{}, false, nil
		}
		if err != nil {
			return channelFile{}, false, fmt.Errorf("read channel metadata %s: %w", path, err)
		}
		var ch channelFile
		if err := json.Unmarshal(data, &ch); err != nil {
			return channelFile{}, true, fmt.Errorf("invalid channel metadata at %s: %w", path, err)
		}
		if !validChannel(ch) {
			return channelFile{}, true, fmt.Errorf("invalid channel metadata at %s: expected a complete channel identity with a safe dataFolder", path)
		}
		return ch, true, nil
	}
	ch, found, err := channelAt(expected)
	if err != nil {
		return channelFile{}, err
	}
	if found {
		return ch, nil
	}
	_, otherFound, err := channelAt(alternate)
	if err != nil {
		return channelFile{}, err
	}
	if otherFound {
		return channelFile{}, fmt.Errorf("channel metadata exists only at the wrong layout: %s", alternate)
	}
	return channelFile{}, nil
}

// TooltipForVisualState gives every visual state an accessible text equivalent.
func TooltipForVisualState(state VisualState) string {
	switch state {
	case VisualActive:
		return "Faravan — On or finishing a job"
	case VisualIdle:
		return "Faravan — Off or paused"
	case VisualPaused:
		return "Faravan — Paused"
	case VisualError:
		return "Faravan — Status needs attention"
	default:
		return "Faravan — Needs you"
	}
}

func localURL(port int, endpoint string) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", port, endpoint)
}

// PollInterval exposes the intentionally low-frequency ambient polling rate.
func PollInterval() time.Duration { return defaultPollInterval }
