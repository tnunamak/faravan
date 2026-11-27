package faravantray

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeChannel(t *testing.T, path, id string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"id":"` + id + `","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestChannelBesideFindsEachInstallLayout(t *testing.T) {
	root := t.TempDir()
	linux := filepath.Join(root, "usr", "lib", "faravan")
	writeChannel(t, filepath.Join(linux, "channel.json"), "preview-linux")
	if got, err := channelBeside(filepath.Join(linux, "faravan-tray")); err != nil || got.ID != "preview-linux" {
		t.Fatalf("linux tray read %q", got)
	}
	app := filepath.Join(root, "Faravan Preview.app", "Contents")
	writeChannel(t, filepath.Join(app, "Resources", "faravan", "channel.json"), "preview-mac")
	if got, err := channelBeside(filepath.Join(app, "MacOS", "faravan-tray")); err != nil || got.ID != "preview-mac" {
		t.Fatalf("mac tray read %q", got)
	}
}

func TestChannelBesideIgnoresStrayParentFiles(t *testing.T) {
	root := t.TempDir()
	writeChannel(t, filepath.Join(root, "channel.json"), "stray")
	writeChannel(t, filepath.Join(root, "Faravan.app", "channel.json"), "stray")
	if got, err := channelBeside(filepath.Join(root, "Faravan.app", "Contents", "MacOS", "faravan-tray")); err != nil || got.ID != "" {
		t.Fatalf("stray channel.json was used: %q", got)
	}
}

func TestChannelValidationMatchesSharedFixtures(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "channel-identity-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name    string          `json:"name"`
		Valid   bool            `json:"valid"`
		Channel json.RawMessage `json:"channel"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			var channel channelFile
			if err := json.Unmarshal(fixture.Channel, &channel); err != nil {
				if fixture.Valid {
					t.Fatal(err)
				}
				return
			}
			if got := validChannel(channel); got != fixture.Valid {
				t.Fatalf("validChannel = %v; want %v", got, fixture.Valid)
			}
		})
	}
}

func TestChannelRejectsEmbeddedControlsInEveryRequiredField(t *testing.T) {
	base := channelFile{ID: "preview", Name: "Preview", DataFolder: "Preview", BundleID: "com.example.preview", HelperBundleID: "com.example.preview.notify", LaunchAgentLabel: "com.example.preview.agent", LinuxPrefix: "preview"}
	for _, field := range []string{"id", "name", "dataFolder", "bundleId", "helperBundleId", "launchAgentLabel", "linuxPrefix"} {
		for _, control := range []string{"\x01", "\x7f"} {
			t.Run(field+"/"+control, func(t *testing.T) {
				channel := base
				value := "A" + control + "B"
				switch field {
				case "id":
					channel.ID = value
				case "name":
					channel.Name = value
				case "dataFolder":
					channel.DataFolder = value
				case "bundleId":
					channel.BundleID = value
				case "helperBundleId":
					channel.HelperBundleID = value
				case "launchAgentLabel":
					channel.LaunchAgentLabel = value
				case "linuxPrefix":
					channel.LinuxPrefix = value
				}
				if validChannel(channel) {
					t.Fatal("control character accepted")
				}
			})
		}
	}
}

func TestChannelBesidePrefersExpectedMetadataAndRejectsWrongLayouts(t *testing.T) {
	root := t.TempDir()
	mac := filepath.Join(root, "App.app", "Contents", "MacOS")
	resources := filepath.Join(root, "App.app", "Contents", "Resources", "faravan", "channel.json")
	adjacent := filepath.Join(mac, "channel.json")
	writeChannel(t, resources, "preview-mac")
	writeChannel(t, adjacent, "preview-other")
	if got, err := channelBeside(filepath.Join(mac, "faravan-tray")); err != nil || got.ID != "preview-mac" {
		t.Fatalf("expected Resources channel did not win: %v, %v", got, err)
	}
	if err := os.Remove(resources); err != nil {
		t.Fatal(err)
	}
	if _, err := channelBeside(filepath.Join(mac, "faravan-tray")); err == nil {
		t.Fatal("wrong-layout-only candidate accepted")
	}
	writeChannel(t, resources, "preview-mac")
	if err := os.WriteFile(resources, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := channelBeside(filepath.Join(mac, "faravan-tray")); err == nil {
		t.Fatal("malformed expected candidate fell back")
	}
}

func TestWindowsDataBaseRequiresAnAbsoluteLocalAppData(t *testing.T) {
	home := `C:\Users\review`
	vectors := []struct {
		name     string
		local    string
		accepted bool
	}{
		{"rooted backslash", `\Data`, false},
		{"rooted slash", `/Data`, false},
		{"drive-relative", `C:Data`, false},
		{"ordinary relative", `relative\data`, false},
		{"drive-absolute", `C:\Data`, true},
		{"UNC absolute", `\\server\share\data`, true},
		{"slash UNC absolute", `//server/share/data`, true},
		{"malformed UNC without share", `\\server`, false},
	}
	fallback := filepath.Join(home, "AppData", "Local")
	for _, vector := range vectors {
		t.Run(vector.name, func(t *testing.T) {
			want := fallback
			if vector.accepted {
				want = vector.local
			}
			if got := windowsDataBase(vector.local, home); got != want {
				t.Errorf("windowsDataBase(%q) = %q; want %q", vector.local, got, want)
			}
		})
	}
}
