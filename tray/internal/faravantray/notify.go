package faravantray

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Notification is one native notification. Its text names a person and a
// circle only; a job's title or prompt never leaves the app (EXPERIENCE 6.3).
type Notification struct {
	ID, Title, Body string
	OpenOnClick bool // borrower events open the exact job when the body is clicked
}

// Action is the chosen notification action. A borrower body click is Review;
// approval body clicks, dismissals and expiry are ActionNone.
type Action string

const (
	ActionNone    Action = ""
	ActionReview  Action = "review"
	ActionDecline Action = "decline"
)

// Notifier shows one notification and waits for its outcome. One
// implementation per OS; tests inject a fake.
type Notifier interface {
	Notify(ctx context.Context, n Notification) (Action, error)
}

// ErrNotShown marks a delivery failure that happened before the desktop was
// asked to display anything (for example no session bus). Only these are safe
// to retry: an error after a display attempt may already be on screen.
var ErrNotShown = errors.New("notification was not shown")

type notShownError struct{ err error }

func (e notShownError) Error() string { return e.err.Error() }
func (e notShownError) Unwrap() []error { return []error{ErrNotShown, e.err} }

// Runner runs a command and returns its standard output. The production
// runner is exec; tests inject a fake so no test shows a real notification.
type Runner func(ctx context.Context, name string, args ...string) (string, error)

// ErrNoNotifier means this computer has no way to show a notification with actions.
var ErrNoNotifier = errors.New("no notification tool is available on this computer")

// NewNotifier picks the notifier for an OS. goos is a parameter so each
// path is testable on any host.
func NewNotifier(goos string, run Runner, have func(string) bool, helper string, brand Branding) (Notifier, error) {
	switch goos {
	case "linux":
		// The session bus first: notify-send cannot show buttons under some AppArmor profiles.
		if have("session-bus") { return DBusNotifier{Brand: brand}, nil }
		if have("notify-send") { return NotifySend{Run: run, Brand: brand}, nil }
	case "darwin":
		if helper != "" { return MacNotifier{Run: run, Helper: helper}, nil }
		if have("osascript") { return MacNotifier{Run: run}, nil }
	case "windows":
		if have("powershell.exe") { return ToastNotifier{Run: run}, nil }
	}
	return nil, ErrNoNotifier
}

// ApprovalCard is the part of the app's approval card the tray reads.
type ApprovalCard struct {
	ID string `json:"id"`
	LocalName string `json:"localName"`
	RequesterName string `json:"requesterName"`
	Harness string `json:"harness"`
	RuntimeSeconds int `json:"runtimeSeconds"`
	ExpiresAt float64 `json:"expiresAt"` // epoch milliseconds: when the request stops waiting
	Job struct { Circle string `json:"circle"` } `json:"job"`
	// Kind is "chatgpt" for a remote ChatGPT action (its ID then starts with ChatgptPrefix); empty for a job.
	Kind string `json:"kind"`
	Label string `json:"label"` // ChatGPT: the app's static title for the operation
	What string `json:"what"` // ChatGPT: the effect; shown in the app, never in a notification
}

// ChatgptKind and ChatgptPrefix mark a ChatGPT action inside the tray. The server's raw id is the UUID.
const (
	ChatgptKind = "chatgpt"
	ChatgptPrefix = "chatgpt:"
)

// ChatgptBody is the whole body of a ChatGPT notification: the effect is read only in the app.
const ChatgptBody = "Review the exact effect in Faravan on this computer."

// NotificationForCard writes "Sam asked for help / Weekend projects · up to 20 min of Claude Code".
func NotificationForCard(card ApprovalCard, circleNames map[string]string) Notification {
	if card.Kind == ChatgptKind {
		title := "ChatGPT needs your approval"
		if label := safeLabel(card.Label); label != "" { title = "Allow ChatGPT to " + label }
		return Notification{ID: card.ID, Title: title, Body: ChatgptBody}
	}
	who := firstNonEmpty(card.LocalName, card.RequesterName, "A circle member")
	parts := []string{}
	parts = append(parts, firstNonEmpty(circleNames[card.Job.Circle], "Your circle"))
	agent := agentNames[card.Harness]
	if card.RuntimeSeconds > 0 {
		minutes := (card.RuntimeSeconds + 59) / 60
		limit := fmt.Sprintf("up to %d min", minutes)
		if agent != "" { limit += " of " + agent }
		parts = append(parts, limit)
	} else if agent != "" {
		parts = append(parts, agent)
	}
	return Notification{ID: card.ID, Title: who + " asked for help", Body: strings.Join(parts, " · ")}
}
// safeLabel keeps a static operation title short and free of control characters before it reaches the OS.
func safeLabel(label string) string {
	label = strings.Map(func(r rune) rune { if r < 0x20 || r == 0x7f { return ' ' }; return r }, label)
	label = strings.Join(strings.Fields(label), " ")
	if r := []rune(label); len(r) > 80 { label = string(r[:80]) }
	return label
}
func firstNonEmpty(values ...string) string {
	for _, v := range values { if strings.TrimSpace(v) != "" { return v } }
	return ""
}

// RequestTracker follows the approvals list between polls, so a request is announced once, an answered or
// expired one is noticed, and a failed read is never mistaken for an empty list.
type RequestTracker struct{ known map[string]ApprovalCard }

// Update takes the latest read. ok is false when the read failed: nothing changes then, because "unknown" is not
// "nobody is waiting" (treating it so announced every request again on the next good read).
// fresh are requests not seen before; gone are announced ones that left the list.
func (t *RequestTracker) Update(cards []ApprovalCard, ok bool) (fresh, gone []ApprovalCard) {
	return t.Observe(cards, ok, true)
}

// Observe is Update with a gate. While announce is false (the notification
// settings are unknown or stale) new requests are not consumed, so they are
// still fresh on the next read that can decide; withdrawn ones are reported
// either way so their open notifications close.
func (t *RequestTracker) Observe(cards []ApprovalCard, ok, announce bool) (fresh, gone []ApprovalCard) {
	if !ok { return nil, nil }
	if t.known == nil { t.known = map[string]ApprovalCard{} }
	current := map[string]ApprovalCard{}
	for _, card := range cards {
		if _, seen := t.known[card.ID]; seen {
			current[card.ID] = card
		} else if announce {
			current[card.ID] = card
			fresh = append(fresh, card)
		}
	}
	listed := map[string]bool{}
	for _, card := range cards { listed[card.ID] = true }
	for id, card := range t.known { if !listed[id] { gone = append(gone, card) } }
	t.known = current
	return fresh, gone
}

// Forget lets a request be announced again after its notification was definitely not shown.
func (t *RequestTracker) Forget(id string) { delete(t.known, id) }

// ErrRequestGone: the request was already decided, withdrawn or expired when the answer arrived.
var ErrRequestGone = errors.New("that request is no longer waiting")

// ReviewRoute names the exact request shown in the menu or notification.
const ReviewRoute = "#/request/"

// HandleAction carries out the lender's choice. Review opens the request
// through a one-time link; Not now declines. Neither accepts, so neither starts a job.
func HandleAction(ctx context.Context, client AppClient, info AppInfo, id string, action Action, openURL func(string) error) error {
	switch action {
	case ActionReview:
		if strings.TrimSpace(id) == "" { return errors.New("no request was shown") }
		link, err := client.Handoff(ctx, info)
		if err != nil { return err }
		if uuid, ok := strings.CutPrefix(id, ChatgptPrefix); ok {
			// The app's handoff callback sends the browser on to the action page; a fragment would not survive that.
			sep := "?"
			if strings.Contains(link, "?") { sep = "&" }
			return openURL(link + sep + "chatgpt_action=" + url.QueryEscape(uuid))
		}
		// The browser keeps a fragment across the handoff redirect.
		return openURL(link + ReviewRoute + url.PathEscape(id))
	case ActionDecline:
		err := client.Decline(ctx, info, id)
		var problem *HTTPError
		if errors.As(err, &problem) && problem.Status == 404 { return ErrRequestGone }
		return err
	}
	return nil
}
