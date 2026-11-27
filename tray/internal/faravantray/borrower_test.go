package faravantray

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func TestBorrowerPollingDeduplicatesAndRespectsDesktop(t *testing.T) {
	var cursors []string
	var broken bool
	feed := NotificationFeed{Cursor: "first", Settings: NotificationSettings{"job_ready": {History: true, Desktop: true}, "needs_attention": {History: true, Desktop: false}}}
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		if r.URL.Path != "/api/notifications" {
			t.Fatalf("wrong endpoint %s", r.URL)
		}
		cursors = append(cursors, r.URL.Query().Get("after"))
		if broken {
			return `broken`
		}
		b, _ := json.Marshal(feed)
		return string(b)
	})}
	var tracker BorrowerTracker
	info := AppInfo{Token: "private", Port: 1234}
	if n, err := tracker.Poll(context.Background(), client, info); err != nil || len(n) != 0 {
		t.Fatal(n, err)
	}
	feed.Cursor = "second"
	feed.Notifications = []BorrowerNotification{{ID: "ready", Category: "job_ready", Route: "#/job/sha256%3A" + strings.Repeat("a", 64)}, {ID: "failed", Category: "needs_attention"}}
	n, err := tracker.Poll(context.Background(), client, info)
	if err != nil || len(n) != 1 || n[0].ID != "ready" {
		t.Fatal(n, err)
	}
	feed.Settings["needs_attention"] = NotificationSetting{Desktop: true}
	if n, err := tracker.Poll(context.Background(), client, info); err != nil || len(n) != 0 {
		t.Fatal("duplicate or muted event replayed", n, err)
	}
	broken = true
	if _, err := tracker.Poll(context.Background(), client, info); err == nil {
		t.Fatal("bad JSON accepted")
	}
	broken = false
	feed.Notifications = nil
	_, _ = tracker.Poll(context.Background(), client, info)
	info.Token = "restarted"
	_, _ = tracker.Poll(context.Background(), client, info)
	if !reflect.DeepEqual(cursors, []string{"", "first", "second", "second", "second", ""}) {
		t.Fatal(cursors)
	}
}

func TestBorrowerReviewUsesHandoffRouteOnly(t *testing.T) {
	route := "#/job/sha256%3A" + strings.Repeat("a", 64) + "/circle"
	var payload map[string]string
	calls := 0
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		calls++
		if r.Method != "POST" || r.URL.Path != "/api/handoff" {
			t.Fatal(r.Method, r.URL)
		}
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &payload); err != nil {
			t.Fatal(err)
		}
		return `{"url":"http://127.0.0.1:1234/auth/handoff?code=once"}`
	})}
	var opened string
	note := BorrowerNotification{ID: "ready", Route: route}
	open := func(s string) error { opened = s; return nil }
	if err := HandleBorrowerAction(context.Background(), client, AppInfo{Port: 1234, Token: "secret"}, note, ActionReview, open); err != nil {
		t.Fatal(err)
	}
	if payload["route"] != route || opened != "http://127.0.0.1:1234/auth/handoff?code=once" {
		t.Fatal(payload, opened)
	}
	if err := HandleBorrowerAction(context.Background(), client, AppInfo{}, note, ActionDecline, open); err != nil || calls != 1 {
		t.Fatal("job event declined a request", calls, err)
	}
	client = AppClient{HTTPClient: appHTTP(t, func(*http.Request) string { return `{}` })}
	if err := HandleBorrowerAction(context.Background(), client, AppInfo{}, note, ActionReview, open); err == nil {
		t.Fatal("missing handoff accepted")
	}
}

func TestBorrowerNotifierIsInjected(t *testing.T) {
	failure := errors.New("test session bus unavailable")
	called := false
	notifier := DBusNotifier{Connect: func() (*dbus.Conn, error) { called = true; return nil, failure }}
	_, err := notifier.Notify(context.Background(), Notification{ID: "ready", Title: "Your job is ready"})
	if !called || !errors.Is(err, failure) {
		t.Fatal(called, err)
	}
}

func TestBorrowerBodyClickIsReviewOnlyForBorrowerEvents(t *testing.T) {
	note := Notification{ID: "job", OpenOnClick: true}
	if ParseNotificationAction("default", note) != ActionReview || ParseNotificationAction("default", Notification{}) != ActionNone {
		t.Fatal("default click changed approval behavior")
	}
	if !strings.Contains(strings.Join(NotifySendArgs(note, Branding{}), " "), "--action=default=Open job") {
		t.Fatal("missing notify-send body action")
	}
	if !strings.Contains(ToastXML(note), `launch="review"`) {
		t.Fatal("missing Windows body action")
	}
	if !strings.Contains(strings.Join(MacHelperArgs(note), " "), "--open-on-click") {
		t.Fatal("missing macOS body action")
	}
}

// A notification shown before an app restart must open the job on the app that runs now.
func TestNotificationClickAfterRestartUsesCurrentDiscovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.json")
	write := func(port int, token string) {
		record := fmt.Sprintf(`{"port":%d,"token":%q,"pid":4242,"started_at":"2026-10-20T14:00:00Z"}`, port, token)
		if err := os.WriteFile(path, []byte(record), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	client := LocalClient{AppPath: path, Alive: func(int) bool { return true }}
	write(1111, "before-restart")
	shown := client.CurrentApp(AppInfo{})
	write(2222, "after-restart")
	if got := client.CurrentApp(shown); got.Port != 2222 || got.Token != "after-restart" {
		t.Fatalf("click used the pre-restart app: %+v", got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if got := client.CurrentApp(shown); got != shown {
		t.Fatalf("without a record the shown app must be kept: %+v", got)
	}
	var authorization, host, method, endpoint, route, opened string
	calls := 0
	api := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		calls++
		authorization = r.Header.Get("X-Faravan-Session-Token")
		host, method, endpoint = r.URL.Host, r.Method, r.URL.Path
		var payload struct {
			Route string `json:"route"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		route = payload.Route
		return `{"url":"http://127.0.0.1:2222/auth/handoff?code=once"}`
	})}
	write(2222, "after-restart")
	note := BorrowerNotification{ID: "ready", Route: "#/job/sha256%3A" + strings.Repeat("b", 64) + "/circle"}
	if err := HandleBorrowerAction(context.Background(), api, client.CurrentApp(shown), note, ActionReview, func(s string) error { opened = s; return nil }); err != nil {
		t.Fatal(err)
	}
	if authorization != "after-restart" {
		t.Fatalf("handoff was not requested with the current app's token")
	}
	if calls != 1 || host != "127.0.0.1:2222" || method != http.MethodPost || endpoint != "/api/handoff" {
		t.Fatal("click did not request one handoff from the restarted app", calls, host, method, endpoint)
	}
	if route != note.Route || opened != "http://127.0.0.1:2222/auth/handoff?code=once" {
		t.Fatal("click did not open the original notification's job through the new handoff", route, opened)
	}
}

func card(id string) ApprovalCard { return ApprovalCard{ID: id} }

// Approvals seen while the settings are unknown stay unannounced, so a later
// good read can still notify them; withdrawn ones are still reported.
func TestRequestsWaitForCurrentSettings(t *testing.T) {
	var tracker RequestTracker
	fresh, _ := tracker.Observe([]ApprovalCard{card("a")}, true, false)
	if len(fresh) != 0 {
		t.Fatalf("announced before settings were known: %v", fresh)
	}
	fresh, _ = tracker.Observe([]ApprovalCard{card("a")}, true, true)
	if len(fresh) != 1 || fresh[0].ID != "a" {
		t.Fatalf("a request seen under unknown settings was consumed: %v", fresh)
	}
	fresh, gone := tracker.Observe([]ApprovalCard{card("b")}, true, false)
	if len(fresh) != 0 || len(gone) != 1 || gone[0].ID != "a" {
		t.Fatalf("cleanup must continue under unknown settings: fresh=%v gone=%v", fresh, gone)
	}
	tracker.Forget("b")
	if fresh, _ = tracker.Observe([]ApprovalCard{card("b")}, true, true); len(fresh) != 1 {
		t.Fatalf("a request that was not shown must be announced again: %v", fresh)
	}
}

func TestBorrowerSettingsAreCurrentOnlyAfterASuccessfulRead(t *testing.T) {
	broken := false
	client := AppClient{HTTPClient: appHTTP(t, func(*http.Request) string {
		if broken {
			return `broken`
		}
		return `{"cursor":"c","settings":{"requests":{"history":true,"desktop":true}},"notifications":[]}`
	})}
	var tracker BorrowerTracker
	info := AppInfo{Token: "private", Port: 1234}
	if tracker.SettingsCurrent() {
		t.Fatal("settings are current before any read")
	}
	if _, err := tracker.Poll(context.Background(), client, info); err != nil || !tracker.SettingsCurrent() || !tracker.DesktopEnabled("requests") {
		t.Fatal("a good read must make the settings current", err)
	}
	broken = true
	if _, err := tracker.Poll(context.Background(), client, info); err == nil || tracker.SettingsCurrent() {
		t.Fatal("a failed read must leave the stale settings marked not current", err)
	}
}

// The notification service being unreachable must not consume the event: it is
// re-offered after a delay, once, and never for a category now muted.
func TestBorrowerEventsSurviveDisplayFailure(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	feed := NotificationFeed{Cursor: "1", Settings: NotificationSettings{"job_ready": {Desktop: true}}}
	client := AppClient{HTTPClient: appHTTP(t, func(*http.Request) string { b, _ := json.Marshal(feed); return string(b) })}
	tracker := BorrowerTracker{now: func() time.Time { return now }}
	info := AppInfo{Token: "private", Port: 1234}
	_, _ = tracker.Poll(context.Background(), client, info)
	feed.Cursor, feed.Notifications = "2", []BorrowerNotification{{ID: "ready", Category: "job_ready"}}
	got, _ := tracker.Poll(context.Background(), client, info)
	if len(got) != 1 {
		t.Fatal(got)
	}
	tracker.Requeue(got[0])
	if got, _ = tracker.Poll(context.Background(), client, info); len(got) != 0 {
		t.Fatalf("retried with no backoff: %v", got)
	}
	now = now.Add(10 * time.Second)
	if got, _ = tracker.Poll(context.Background(), client, info); len(got) != 1 || got[0].ID != "ready" {
		t.Fatalf("the undisplayed event was lost: %v", got)
	}
	if got, _ = tracker.Poll(context.Background(), client, info); len(got) != 0 {
		t.Fatalf("an in-flight event was offered twice: %v", got)
	}
	tracker.Requeue(BorrowerNotification{ID: "ready", Category: "job_ready"})
	feed.Settings["job_ready"] = NotificationSetting{Desktop: false}
	now = now.Add(time.Hour)
	if got, _ = tracker.Poll(context.Background(), client, info); len(got) != 0 {
		t.Fatalf("a muted category was retried: %v", got)
	}
	for range 20 {
		tracker.Requeue(BorrowerNotification{ID: "doomed", Category: "job_ready"})
	}
	if len(tracker.retries) != 1 || tracker.retries[0].due.Sub(now) != 5*time.Minute {
		t.Fatalf("repeated not-shown failures must keep one retry with a five-minute cap: %v", tracker.retries)
	}
	feed.Settings["job_ready"] = NotificationSetting{Desktop: true}
	now = now.Add(time.Hour)
	if got, _ = tracker.Poll(context.Background(), client, info); len(got) != 1 || got[0].ID != "doomed" {
		t.Fatalf("a long notification-service outage must not silently drop undisplayed events: %v", got)
	}
	for i := 0; i < 100; i++ {
		tracker.Requeue(BorrowerNotification{ID: fmt.Sprintf("pending-%d", i), Category: "job_ready"})
	}
	if len(tracker.retries) > maxPendingDeliveries {
		t.Fatal("pending queue grew without bound")
	}
}

func TestSessionBusFailureIsNotShown(t *testing.T) {
	failure := errors.New("no bus")
	_, err := DBusNotifier{Connect: func() (*dbus.Conn, error) { return nil, failure }}.Notify(context.Background(), Notification{ID: "x"})
	if !errors.Is(err, ErrNotShown) || !errors.Is(err, failure) {
		t.Fatal(err)
	}
}

func TestEmptySettingsAreUnknownForApprovalNotifications(t *testing.T) {
	tracker := BorrowerTracker{current: true, settings: NotificationSettings{}}
	if tracker.SettingsCurrent() {
		t.Fatal("missing request preferences cannot consume approval ids")
	}
}

func TestApprovalSettingsFailureAndRecovery(t *testing.T) {
	for _, previouslyEnabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("previously-enabled-%t", previouslyEnabled), func(t *testing.T) {
			broken := false
			feed := NotificationFeed{Cursor: "c", Settings: NotificationSettings{"requests": {Desktop: true}}}
			client := AppClient{HTTPClient: appHTTP(t, func(*http.Request) string {
				if broken { return "broken" }
				b, _ := json.Marshal(feed)
				return string(b)
			})}
			var settings BorrowerTracker
			var requests RequestTracker
			info := AppInfo{Port: 1234, Token: "private"}
			poll := func(wantError bool) {
				t.Helper()
				_, err := settings.Poll(context.Background(), client, info)
				if (err != nil) != wantError { t.Fatalf("poll error: %v", err) }
			}
			if previouslyEnabled { poll(false) }
			// Discovery has a new approval, but its settings read fails.
			broken = true
			if previouslyEnabled { feed.Settings["requests"] = NotificationSetting{Desktop: false} }
			poll(true)
			fresh, _ := requests.Observe([]ApprovalCard{card("waiting")}, true, settings.SettingsCurrent())
			if len(fresh) != 0 { t.Fatalf("unknown or stale settings consumed approval: %v", fresh) }
			broken = false
			poll(false)
			fresh, _ = requests.Observe([]ApprovalCard{card("waiting")}, true, settings.SettingsCurrent())
			if len(fresh) != 1 { t.Fatalf("approval was lost before settings recovered: %v", fresh) }
			shown := len(fresh) != 0 && settings.DesktopEnabled("requests")
			if shown == previouslyEnabled { t.Fatalf("recovery used stale settings: shown=%t", shown) }
			fresh, _ = requests.Observe([]ApprovalCard{card("waiting")}, true, settings.SettingsCurrent())
			if len(fresh) != 0 { t.Fatalf("recovery repeated approval: %v", fresh) }
			broken = true
			poll(true)
			_, gone := requests.Observe(nil, true, settings.SettingsCurrent())
			if len(gone) != 1 || gone[0].ID != "waiting" { t.Fatalf("withdrawal cleanup stopped: %v", gone) }
		})
	}
}

// Exercise the same not-shown decision as announceBorrower without a real
// desktop: the first attempt uses a failed D-Bus connection, recovery uses
// the fake notification runner, and an uncertain error is never requeued.
func TestBorrowerConnectionFailureThenDeliveryExactlyOnce(t *testing.T) {
	for _, definite := range []bool{true, false} {
		t.Run(fmt.Sprintf("definite-%t", definite), func(t *testing.T) {
			now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
			event := BorrowerNotification{ID: "ready", Category: "job_ready"}
			feed := NotificationFeed{Cursor: "1", Settings: NotificationSettings{"job_ready": {Desktop: true}}}
			client := AppClient{HTTPClient: appHTTP(t, func(*http.Request) string {
				b, _ := json.Marshal(feed)
				return string(b)
			})}
			tracker := BorrowerTracker{now: func() time.Time { return now }}
			info := AppInfo{Port: 1234, Token: "private"}
			var delivered []call
			attempts := 0
			poll := func() {
				t.Helper()
				events, err := tracker.Poll(context.Background(), client, info)
				if err != nil { t.Fatal(err) }
				for _, e := range events {
					attempts++
					var notifier Notifier = NotifySend{Run: fakeRunner("", nil, &delivered)}
					if attempts == 1 {
						failure := errors.New("notification service unavailable")
						if definite {
							notifier = DBusNotifier{Connect: func() (*dbus.Conn, error) { return nil, failure }}
						} else {
							notifier = NotifySend{Run: fakeRunner("", failure, new([]call))}
						}
					}
					_, err := notifier.Notify(context.Background(), Notification{ID: e.ID})
					if errors.Is(err, ErrNotShown) { tracker.Requeue(e) }
				}
			}
			poll()
			feed.Cursor, feed.Notifications = "2", []BorrowerNotification{event}
			poll()
			poll()
			if attempts != 1 { t.Fatalf("retry did not back off: %d attempts", attempts) }
			now = now.Add(5 * time.Second)
			poll()
			poll()
			now = now.Add(time.Hour)
			poll()
			wantAttempts, wantDelivered := 1, 0
			if definite { wantAttempts, wantDelivered = 2, 1 }
			if attempts != wantAttempts || len(delivered) != wantDelivered {
				t.Fatalf("attempts=%d delivered=%d; want %d/%d", attempts, len(delivered), wantAttempts, wantDelivered)
			}
		})
	}
}
