package faravantray

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// NotificationSettings are the app's per-category controls. History and desktop
// delivery are independent: a muted history can still produce a desktop alert.
type NotificationSetting struct {
	History bool `json:"history"`
	Desktop bool `json:"desktop"`
}
type NotificationSettings map[string]NotificationSetting

type BorrowerNotification struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Route    string `json:"route"`
}
type NotificationFeed struct {
	Cursor        string                 `json:"cursor"`
	Notifications []BorrowerNotification `json:"notifications"`
	Settings      NotificationSettings   `json:"settings"`
}

func (c AppClient) Notifications(ctx context.Context, info AppInfo, after string) (NotificationFeed, error) {
	response, err := c.request(ctx, info, http.MethodGet, "/api/notifications?after="+url.QueryEscape(after))
	if err != nil {
		return NotificationFeed{}, err
	}
	defer response.Body.Close()
	var feed NotificationFeed
	if err := json.NewDecoder(response.Body).Decode(&feed); err != nil || feed.Cursor == "" || feed.Settings == nil {
		return NotificationFeed{}, errors.New("Faravan notifications are unavailable")
	}
	return feed, nil
}

// BorrowerTracker owns the feed cursor. A fresh app session starts at the current
// cursor, so restarting the tray does not replay historical jobs. Failed reads
// preserve the cursor and seen ids; repeated responses cannot repeat an alert.
type BorrowerTracker struct {
	app      AppInfo
	cursor   string
	settings NotificationSettings
	current  bool // the last Poll read the settings; false after a failed or missing read
	seen     map[string]bool
	order    []string
	retries  []pendingDelivery
	failed   map[string]int   // not-shown attempts by event id; bounded like seen
	now      func() time.Time // tests only; nil means time.Now
}

// pendingDelivery is an event the desktop definitely did not show (the
// notification service was unreachable). The feed already moved past it, so
// the tracker re-offers it with a growing delay instead of dropping it.
type pendingDelivery struct {
	event BorrowerNotification
	due   time.Time
}

const (
	maxPendingDeliveries = 32
)

func (t *BorrowerTracker) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

func (t *BorrowerTracker) DesktopEnabled(category string) bool { return t.settings[category].Desktop }

// SettingsCurrent is true only when the most recent Poll read the settings.
// Approval alerts wait for it: unknown or stale settings must not decide
// whether a waiting request is announced or silently consumed.
func (t *BorrowerTracker) SettingsCurrent() bool {
	_, known := t.settings["requests"]
	return t.current && known
}

// Requeue re-offers an event whose notification was definitely not displayed.
// Callers must not requeue an uncertain outcome: that could show it twice.
func (t *BorrowerTracker) Requeue(event BorrowerNotification) {
	if t.failed == nil || len(t.failed) > 2*maxPendingDeliveries {
		t.failed = map[string]int{}
	}
	for i, p := range t.retries {
		if p.event.ID == event.ID {
			t.retries = append(t.retries[:i], t.retries[i+1:]...)
			break
		}
	}
	// Saturate the backoff, not delivery: a long desktop-service outage is
	// still a known not-shown result. Keep retrying while the category is on.
	if t.failed[event.ID] < 7 {
		t.failed[event.ID]++
	}
	attempts := t.failed[event.ID]
	delay := 5 * time.Second << (attempts - 1)
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	t.retries = append(t.retries, pendingDelivery{event: event, due: t.clock().Add(delay)})
	if len(t.retries) > maxPendingDeliveries {
		t.retries = t.retries[1:]
	}
}

func (t *BorrowerTracker) Poll(ctx context.Context, client AppClient, info AppInfo) ([]BorrowerNotification, error) {
	if t.app.Port != info.Port || t.app.Token != info.Token {
		*t = BorrowerTracker{app: info, now: t.now}
	}
	t.current = false
	feed, err := client.Notifications(ctx, info, t.cursor)
	if err != nil {
		return nil, err
	}
	t.cursor, t.settings, t.current = feed.Cursor, feed.Settings, true
	if t.seen == nil {
		t.seen = map[string]bool{}
	}
	var fresh []BorrowerNotification
	// Undisplayed events come back first, once due, and only while their category
	// still wants a desktop alert.
	now, waiting := t.clock(), []pendingDelivery(nil)
	for _, p := range t.retries {
		switch {
		case !t.DesktopEnabled(p.event.Category):
		case p.due.After(now):
			waiting = append(waiting, p)
		default:
			fresh = append(fresh, p.event)
		}
	}
	t.retries = waiting
	for _, note := range feed.Notifications {
		if note.ID == "" || t.seen[note.ID] {
			continue
		}
		t.seen[note.ID] = true
		t.order = append(t.order, note.ID)
		if len(t.order) > 2048 {
			delete(t.seen, t.order[0])
			t.order = t.order[1:]
		}
		if t.DesktopEnabled(note.Category) {
			fresh = append(fresh, note)
		}
	}
	return fresh, nil
}

// HandleBorrowerAction opens the exact object using a freshly minted one-time
// handoff. A job event can never decline an approval or carry a durable token URL.
func HandleBorrowerAction(ctx context.Context, client AppClient, info AppInfo, note BorrowerNotification, action Action, openURL func(string) error) error {
	if action != ActionReview {
		return nil
	}
	if note.Route == "" {
		return errors.New("no job was shown")
	}
	payload, _ := json.Marshal(struct {
		Route string `json:"route"`
	}{note.Route})
	response, err := client.requestBody(ctx, info, http.MethodPost, "/api/handoff", string(payload))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.URL == "" {
		return errors.New("Faravan did not give a sign-in link")
	}
	return openURL(body.URL)
}
