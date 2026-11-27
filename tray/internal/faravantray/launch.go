package faravantray

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// OwnedByLauncher reports whether the macOS launcher (lib/v1/macos-launch.mjs) started this tray. It then holds the
// write end of the tray's standard input; end of input means the launcher is gone or asked everything to stop.
func OwnedByLauncher(getenv func(string) string) bool { return getenv("FARAVAN_TRAY_OWNER") == "stdin" }

// OwnerGone closes when r reaches end of input or fails. The kernel closes the pipe when the owner exits for any
// reason, including Force Quit, so this needs no signal handler. Data on the pipe is ignored.
func OwnerGone(r io.Reader) <-chan struct{} {
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		_, _ = io.Copy(io.Discard, r)
	}()
	return gone
}

// NotifyHelperPath is FARAVAN_NOTIFY_HELPER when set; else, on macOS, the notification helper app inside the same
// Faravan.app as this tray (Contents/Helpers/FaravanNotify.app/Contents/MacOS/faravan-notify), when present.
func NotifyHelperPath(goos, exe, explicit string) string {
	if explicit != "" { return explicit }
	if goos != "darwin" { return "" }
	contents := filepath.Dir(filepath.Dir(exe)) // exe is Contents/MacOS/faravan-tray
	helper := filepath.Join(contents, "Helpers", "FaravanNotify.app", "Contents", "MacOS", "faravan-notify")
	if isExecutableFile(helper) { return helper }
	return ""
}

// FaravanCLI is the faravan command the tray's Start runs. In Faravan.app that is the wrapper beside the tray, so
// the app starts its own bundled runtime rather than another install; elsewhere PATH, then ~/.local/bin.
func FaravanCLI(goos, exe, home string, lookPath func(string) (string, error)) (string, error) {
	if goos == "darwin" {
		if sibling := filepath.Join(filepath.Dir(exe), "faravan"); isExecutableFile(sibling) { return sibling, nil }
	}
	if path, err := lookPath("faravan"); err == nil { return path, nil }
	if candidate := filepath.Join(home, ".local", "bin", "faravan"); isExecutableFile(candidate) { return candidate, nil }
	return "", fmt.Errorf("faravan CLI not found on PATH or in ~/.local/bin")
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}
