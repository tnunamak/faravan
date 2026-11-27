package faravantray

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Opens the real zenity quit dialog on a private X display (xvfb-run -a), never the user's, and lets it
// time out. Exit 5 is zenity's timeout, which proves it accepted every flag, including the extra button,
// and showed the dialog. Nobody clicks it here, so the answer parsing is covered by the fake-runner tests.
func TestRealZenityAcceptsTheQuitDialog(t *testing.T) {
	for _, tool := range []string{"xvfb-run", "Xvfb", "zenity"} {
		if _, err := exec.LookPath(tool); err != nil { t.Skipf("needs %s", tool) }
	}
	var env []string
	for _, kv := range os.Environ() {
		if k := strings.SplitN(kv, "=", 2)[0]; k == "DISPLAY" || k == "WAYLAND_DISPLAY" || k == "XAUTHORITY" || k == "DBUS_SESSION_BUS_ADDRESS" || k == "XDG_RUNTIME_DIR" || k == "GDK_BACKEND" { continue }
		env = append(env, kv)
	}
	// GTK 4 zenity falls back to $XDG_RUNTIME_DIR/wayland-0 when WAYLAND_DISPLAY is unset, which put this
	// dialog on the user's Wayland desktop. Force X11 (the private Xvfb), drop the runtime dir, no portals.
	env = append(env, "GDK_BACKEND=x11", "GTK_USE_PORTAL=0")
	for _, status := range []AppStatus{runningStatus(), {State: "ready"}} {
		args := append([]string{"-a", "zenity"}, ZenityQuitArgs(QuitPromptFor(status))...)
		cmd := exec.Command("xvfb-run", append(args, "--timeout=1")...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if ExitCode(err) != 5 { t.Fatalf("state %s: exit %d (want 5, the timeout): %s", status.State, ExitCode(err), out) }
	}
}
