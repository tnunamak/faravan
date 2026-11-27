package faravantray

import (
	"context"
	"strings"
)

// MacNotifier shows a macOS notification. Review needs
// UNUserNotificationCenter, which only a signed app bundle may use, so the
// bundle carries a helper (packaging/macos/notify) that shows the notification
// with a "request" category and prints the chosen action. Without the helper
// (a Homebrew build of the tray alone), osascript shows the text with no
// buttons; the lender can still use the menu.
type MacNotifier struct {
	Run Runner
	Helper string
}

func MacHelperArgs(n Notification) []string {
	args := []string{"--id", n.ID, "--title", n.Title, "--body", n.Body, "--review", "Review"}
	if n.OpenOnClick { args = append(args, "--open-on-click") }
	return args
}

// AppleScriptString quotes text for osascript so a name cannot end the string and run code.
func AppleScriptString(text string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ", "\r", " ").Replace(text) + `"`
}

func OsascriptArgs(n Notification) []string {
	return []string{"-e", "display notification " + AppleScriptString(n.Body) + " with title " + AppleScriptString(n.Title)}
}

func (m MacNotifier) Notify(ctx context.Context, n Notification) (Action, error) {
	if m.Helper == "" {
		_, err := m.Run(ctx, "osascript", OsascriptArgs(n)...)
		return ActionNone, err
	}
	out, err := m.Run(ctx, m.Helper, MacHelperArgs(n)...)
	if err != nil { return ActionNone, err }
	return ParseAction(out), nil
}
