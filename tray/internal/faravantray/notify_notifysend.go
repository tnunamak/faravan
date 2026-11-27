package faravantray

import (
	"context"
	"strings"
)

// NotifySend is the fallback when there is no session bus address (DBusNotifier is preferred; see its comment).
// It shows a Linux notification through libnotify's notify-send
// (0.8 or newer, for --action and --wait). The desktop-entry hint ties the
// notification to this install's launcher and its icon, so the shell shows the Faravan
// name and icon. Without an action server (some minimal desktops), notify-send
// still shows the text and returns no action.
type NotifySend struct {
	Run Runner
	Brand Branding
}

func NotifySendArgs(n Notification, b Branding) []string {
	args := []string{"--app-name="+b.name(), "--icon=" + b.icon(), "--hint=string:desktop-entry:" + b.entry()}
	if b.ImagePath != "" { args = append(args, "--hint=string:image-path:"+b.ImagePath) }
	args = append(args, "--action=review=Review", "--wait", n.Title, n.Body)
	if n.OpenOnClick { args = append([]string{"--action=default=Open job"}, args...) }
	return args
}

func ParseNotificationAction(out string, note Notification) Action {
	if note.OpenOnClick && strings.TrimSpace(out) == "default" { return ActionReview }
	return ParseAction(out)
}

// ParseAction turns notify-send's output (the chosen action's name, or nothing) into an Action.
func ParseAction(out string) Action {
	switch strings.TrimSpace(out) {
	case string(ActionReview): return ActionReview
	}
	return ActionNone
}

func (n NotifySend) Notify(ctx context.Context, note Notification) (Action, error) {
	out, err := n.Run(ctx, "notify-send", NotifySendArgs(note, n.Brand)...)
	if err != nil { return ActionNone, err }
	return ParseNotificationAction(out, note), nil
}
