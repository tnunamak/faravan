package faravantray

import (
	"os"
	"path/filepath"
	"testing"
)

// This models the macOS bundle and data paths on Linux; it does not run a Mac tray.
func TestMacPreviewUpgradeKeepsResourcesChannelDataAndCommand(t *testing.T) {
	for _, stray := range []string{
		`{"id":"faravan","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}`,
		`{`,
	} {
		t.Run(stray, func(t *testing.T) {
			root := t.TempDir()
			contents := filepath.Join(root, "Applications", "Faravan Preview.app", "Contents")
			metadata := filepath.Join(contents, "Resources", "faravan", "channel.json")
			exe := filepath.Join(contents, "MacOS", "faravan-tray")
			previewCommand := filepath.Join(contents, "MacOS", "faravan")
			stableCommand := filepath.Join(root, "Applications", "Faravan.app", "Contents", "MacOS", "faravan")
			bin := filepath.Join(root, "home", ".local", "bin")
			previewData := filepath.Join(root, "home", "Library", "Application Support", "Faravan")
			stableData := filepath.Join(root, "home", ".faravan")
			for _, dir := range []string{filepath.Dir(exe), filepath.Dir(stableCommand), bin, previewData, stableData} {
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for file, content := range map[string]string{
				exe: "preview tray v1", previewCommand: "preview v1", stableCommand: "stable",
				filepath.Join(previewData, "settings.json"): "preview settings",
				filepath.Join(stableData, "settings.json"):  "stable settings",
			} {
				if err := os.WriteFile(file, []byte(content), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(stableCommand, filepath.Join(bin, "faravan")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(previewCommand, filepath.Join(bin, "faravan-preview")); err != nil {
				t.Fatal(err)
			}
			writeChannel(t, metadata, "preview-mac")
			before, err := channelBeside(exe)
			if err != nil || before.ID != "preview-mac" {
				t.Fatalf("install: %v, %v", before, err)
			}

			// Replace preview payload and metadata while an old adjacent file survives.
			writeChannel(t, metadata, "preview-mac")
			if err := os.WriteFile(exe, []byte("preview tray v2"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(previewCommand, []byte("preview v2"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(contents, "MacOS", "channel.json"), []byte(stray), 0o644); err != nil {
				t.Fatal(err)
			}
			after, err := channelBeside(exe)
			if err != nil || after != before {
				t.Fatalf("upgrade changed channel: %v, %v", after, err)
			}
			data := filepath.Join(root, "home", "Library", "Application Support", after.DataFolder)
			if data != previewData {
				t.Fatalf("upgrade selected data %q", data)
			}
			for file, want := range map[string]string{
				filepath.Join(data, "settings.json"):       "preview settings",
				filepath.Join(stableData, "settings.json"): "stable settings",
			} {
				got, err := os.ReadFile(file)
				if err != nil || string(got) != want {
					t.Fatalf("data %s: %q, %v", file, got, err)
				}
			}
			for command, want := range map[string]string{"faravan": stableCommand, "faravan-preview": previewCommand} {
				if got, err := os.Readlink(filepath.Join(bin, command)); err != nil || got != want {
					t.Fatalf("command %s owner: %q, %v", command, got, err)
				}
			}
		})
	}
}
