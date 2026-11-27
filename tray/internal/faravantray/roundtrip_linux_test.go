package faravantray

// A real Linux notification round trip, on a private session bus and a private X
// display, so it never touches the user's desktop or notifications:
//
//	outer test -> dbus-run-session -> xvfb-run -a -> this test binary again (inner)
//
// The inner run starts a notification daemon on the private bus (a small server of the
// freedesktop Notifications spec: this machine has no dunst or other daemon, and nothing
// is installed system-wide), runs the real NotifySend notifier (real notify-send), and
// invokes the notification's action from the daemon side. It then checks that the app
// (a fake HTTP server) receives exactly the Review or Not now call.
//
// It skips when dbus-run-session, xvfb-run or a notify-send with --action are missing.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"net/http"
	"net/http/httptest"

	"github.com/godbus/dbus/v5"
)

const innerEnv = "FARAVAN_ROUNDTRIP_INNER"

func TestRealNotificationRoundTrip(t *testing.T) {
	if os.Getenv(innerEnv) == "1" {
		roundTripInner(t)
		return
	}
	for _, tool := range []string{"dbus-run-session", "xvfb-run", "Xvfb", "notify-send"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("needs %s", tool)
		}
	}
	if out, _ := exec.Command("notify-send", "--help").CombinedOutput(); !strings.Contains(string(out), "--action") {
		t.Skip("notify-send has no --action (needs libnotify 0.8 or newer)")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// Nothing of the user's session survives into the private one.
	env := []string{}
	for _, kv := range os.Environ() {
		key := strings.SplitN(kv, "=", 2)[0]
		switch key {
		case "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE":
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "GDK_BACKEND=x11", "GTK_USE_PORTAL=0", "GOTRACEBACK=all", innerEnv+"=1", "FARAVAN_OUTER_BUS="+os.Getenv("DBUS_SESSION_BUS_ADDRESS"), "FARAVAN_OUTER_DISPLAY="+os.Getenv("DISPLAY"))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "dbus-run-session", "--", "xvfb-run", "-a", exe, "-test.run", "^TestRealNotificationRoundTrip$", "-test.v", "-test.timeout=45s")
	cmd.Env = env
	var out bytes.Buffer
	stream := io.MultiWriter(&out, os.Stdout)
	cmd.Stdout, cmd.Stderr = stream, stream
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Run()
	t.Logf("%s", out.String())
	if err != nil {
		t.Fatalf("private session run failed: %v", err)
	}
	if !strings.Contains(out.String(), "PASS: round trip review dbus") || !strings.Contains(out.String(), "PASS: round trip decline dbus") || !strings.Contains(out.String(), "PASS: round trip dismiss dbus") || !strings.Contains(out.String(), "PASS: round trip takedown dbus") || !strings.Contains(out.String(), "PASS: round trip branding dbus") || !strings.Contains(out.String(), "PASS: borrower review through private dbus") {
		t.Fatal("inner run did not finish the round trips")
	}
}

// daemon is the notification server. It records what it was asked to show.
type daemon struct {
	mu     sync.Mutex
	next   uint32
	shown  chan shownNote
	closed chan uint32 // ids the notifier asked the daemon to take down
	conn   *dbus.Conn
}
type shownNote struct {
	ID                 uint32
	App, Icon, Summary, Body string
	Actions            []string
	Hints              map[string]dbus.Variant
}

func (d *daemon) Notify(app string, replaces uint32, icon, summary, body string, actions []string, hints map[string]dbus.Variant, timeout int32) (uint32, *dbus.Error) {
	d.mu.Lock()
	d.next++
	id := d.next
	d.mu.Unlock()
	d.shown <- shownNote{id, app, icon, summary, body, actions, hints}
	return id, nil
}
func (d *daemon) GetCapabilities() ([]string, *dbus.Error) { return []string{"actions", "body"}, nil }
func (d *daemon) GetServerInformation() (string, string, string, string, *dbus.Error) {
	return "faravan-test-daemon", "faravan", "1", "1.2", nil
}
func (d *daemon) CloseNotification(id uint32) *dbus.Error { d.closed <- id; return nil }

// invoke is the daemon side of a click: ActionInvoked, then NotificationClosed (reason 2: dismissed by the user).
func (d *daemon) invoke(id uint32, action string) error {
	if err := d.conn.Emit("/org/freedesktop/Notifications", "org.freedesktop.Notifications.ActionInvoked", id, action); err != nil {
		return err
	}
	return d.conn.Emit("/org/freedesktop/Notifications", "org.freedesktop.Notifications.NotificationClosed", id, uint32(2))
}
func (d *daemon) dismiss(id uint32) error {
	return d.conn.Emit("/org/freedesktop/Notifications", "org.freedesktop.Notifications.NotificationClosed", id, uint32(2))
}

func execRunner(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err
}

func roundTripInner(t *testing.T) {
	bus := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
	if bus == "" || bus == os.Getenv("FARAVAN_OUTER_BUS") {
		t.Fatal("not on a private session bus")
	}
	if d := os.Getenv("DISPLAY"); d == "" || d == os.Getenv("FARAVAN_OUTER_DISPLAY") {
		t.Fatal("not on a private display")
	}

	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	d := &daemon{shown: make(chan shownNote, 4), closed: make(chan uint32, 4), conn: conn}
	if err := conn.Export(d, "/org/freedesktop/Notifications", "org.freedesktop.Notifications"); err != nil {
		t.Fatal(err)
	}
	reply, err := conn.RequestName("org.freedesktop.Notifications", dbus.NameFlagDoNotQueue)
	if err != nil || reply != dbus.RequestNameReplyPrimaryOwner {
		t.Fatalf("could not own the notification name: %v %v", reply, err)
	}

	// The app: records every call it gets.
	var mu sync.Mutex
	var calls []string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, r.Method+" "+r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/api/handoff" {
			w.Write([]byte(`{"url":"http://127.0.0.1:4000/auth/handoff?code=once"}`))
			return
		}
		w.Write([]byte(`{}`))
	}))
	defer app.Close()
	var port int
	if _, err := fmtSscan(app.URL, &port); err != nil {
		t.Fatal(err)
	}
	info := AppInfo{Port: port, Token: "t"}
	snapshot := func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), calls...) }

	card := ApprovalCard{ID: "a1", LocalName: "Sam", Harness: "claude", RuntimeSeconds: 1200}
	card.Job.Circle = "c1"
	note := NotificationForCard(card, map[string]string{"c1": "Weekend projects"})
	for _, variant := range []struct {
		name     string
		notifier Notifier
	}{
		{"dbus", DBusNotifier{}},
		{"notify-send", NotifySend{Run: execRunner}},
	} {
		roundTrips(t, d, variant.name, variant.notifier, info, note, &mu, &calls, snapshot)
	}
	takedown(t, d, note)
	brandingRoundTrip(t, d, note)
	borrowerRoundTrip(t, d)
}

// brandingRoundTrip: a preview install's notification reaches the daemon with its own launcher id and an
// existing absolute icon path, not the .deb's themed name.
func brandingRoundTrip(t *testing.T, d *daemon, note Notification) {
	t.Helper()
	exe, icon := installTree(t)
	brand := ResolveBranding(exe, "preview-20261026", "faravan-preview-20261026", usableIcon)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	waitCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { _, err := DBusNotifier{Brand: brand}.Notify(waitCtx, note); done <- err }()
	var n shownNote
	select {
	case n = <-d.shown:
	case <-time.After(20 * time.Second):
		t.Fatal("branding: the notification never reached the daemon")
	}
	stop()
	<-done
	if n.Icon != icon || !usableIcon(n.Icon) { t.Fatalf("branding: app_icon %q, want the existing path %q", n.Icon, icon) }
	if v, ok := n.Hints["desktop-entry"]; !ok || v.Value() != "faravan-preview-20261026" { t.Fatalf("branding: desktop-entry %v", n.Hints) }
	if v, ok := n.Hints["image-path"]; !ok || v.Value() != icon { t.Fatalf("branding: image-path %v", n.Hints) }
	t.Log("PASS: round trip branding dbus")
}

// takedown: a request that left the list (answered elsewhere, expired) cancels its notifier's context, and the
// notification is then taken down by its id instead of staying on screen with buttons that do nothing.
func takedown(t *testing.T, d *daemon, note Notification) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	waitCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { _, err := DBusNotifier{}.Notify(waitCtx, note); done <- err }()
	var n shownNote
	select {
	case n = <-d.shown:
	case <-time.After(20 * time.Second):
		t.Fatal("takedown: the notification never reached the daemon")
	}
	stop()
	select {
	case id := <-d.closed:
		if id != n.ID {
			t.Fatalf("takedown: closed notification %d, showed %d", id, n.ID)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("takedown: the notification was left on screen after the request left the list")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("takedown: Notify returned no error after its context ended")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("takedown: Notify never returned")
	}
	t.Log("PASS: round trip takedown dbus")
}

func roundTrips(t *testing.T, d *daemon, label string, notifier Notifier, info AppInfo, note Notification, mu *sync.Mutex, calls *[]string, snapshot func() []string) {
	t.Helper()
	skipped := false
	run := func(name string, act func(shownNote)) (Action, []string, []string) {
		var opened []string
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		type result struct {
			action Action
			err    error
		}
		done := make(chan result, 1)
		go func() {
			action, err := notifier.Notify(ctx, note)
			if err == nil {
				err = HandleAction(ctx, AppClient{}, info, note.ID, action, func(u string) error { opened = append(opened, u); return nil })
			}
			done <- result{action, err}
		}()
		var n shownNote
		select {
		case n = <-d.shown:
		case <-time.After(20 * time.Second):
			t.Fatalf("%s: notify-send never reached the daemon", name)
		}
		if n.App != "Faravan" || n.Summary != "Sam asked for help" || n.Body != "Weekend projects · up to 20 min of Claude Code" {
			t.Fatalf("%s: wrong notification %#v", name, n)
		}
		if len(n.Actions) == 0 && label == "notify-send" {
			// Found on this host: notify-send's AppArmor profile denies GetCapabilities, so libnotify drops the buttons.
			t.Logf("SKIP: notify-send showed no action buttons (AppArmor blocks GetCapabilities for it); the D-Bus notifier does not depend on it")
			// Under that profile notify-send cannot receive the close signal either, so stop it ourselves.
			_ = d.dismiss(n.ID)
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				cancel()
				select {
				case <-done:
				case <-time.After(2 * time.Second):
					if !strings.Contains(os.Getenv("TEST_SANDBOX_RUN_ENFORCEMENT"), "cgroup") {
						t.Fatal("notify-send did not exit after cancellation; an owned cgroup is required for invocation cleanup")
					}
					t.Log("notify-send did not exit after cancellation; the owned cgroup handles invocation cleanup")
				}
			}
			skipped = true
			return "", nil, nil
		}
		if strings.Join(n.Actions, ",") != "review,Review" {
			t.Fatalf("%s: wrong actions %v", name, n.Actions)
		}
		if v, ok := n.Hints["desktop-entry"]; !ok || v.Value() != "faravan" {
			t.Fatalf("%s: missing app identity hint: %v", name, n.Hints)
		}
		act(n)
		select {
		case r := <-done:
			if r.err != nil {
				t.Fatalf("%s: %v", name, r.err)
			}
			return r.action, snapshot(), opened
		case <-time.After(20 * time.Second):
			t.Fatalf("%s: the notifier never returned", name)
		}
		return "", nil, nil
	}

	// Review: the app gets a one-time link request, and the browser is sent to the request page.
	action, got, opened := run("review", func(n shownNote) {
		if err := d.invoke(n.ID, "review"); err != nil {
			t.Fatal(err)
		}
	})
	if skipped {
		return
	}
	if action != ActionReview || strings.Join(got, ";") != "POST /api/handoff" {
		t.Fatalf("review: action %q calls %v", action, got)
	}
	if len(opened) != 1 || opened[0] != "http://127.0.0.1:4000/auth/handoff?code=once#/request/a1" {
		t.Fatalf("review: opened %v", opened)
	}
	t.Log("PASS: round trip review " + label)

	// A stale decline action is ignored; it cannot decide a request.
	mu.Lock()
	*calls = nil
	mu.Unlock()
	action, got, opened = run("decline", func(n shownNote) {
		if err := d.invoke(n.ID, "decline"); err != nil {
			t.Fatal(err)
		}
	})
	if skipped {
		return
	}
	if action != ActionNone || len(got) != 0 || len(opened) != 0 {
		t.Fatalf("decline: action %q calls %v opened %v", action, got, opened)
	}
	t.Log("PASS: round trip decline " + label)

	// Dismissed without a button: the app hears nothing.
	mu.Lock()
	*calls = nil
	mu.Unlock()
	action, got, opened = run("dismiss", func(n shownNote) {
		if err := d.dismiss(n.ID); err != nil {
			t.Fatal(err)
		}
	})
	if skipped {
		return
	}
	if action != ActionNone || len(got) != 0 || len(opened) != 0 {
		t.Fatalf("dismiss: action %q calls %v opened %v", action, got, opened)
	}
	t.Log("PASS: round trip dismiss " + label)
	for _, c := range snapshot() {
		if strings.Contains(c, "accept") {
			t.Fatal("a notification must never accept")
		}
	}
}

// fmtSscan reads the port from "http://127.0.0.1:PORT".
func fmtSscan(url string, port *int) (int, error) {
	i := strings.LastIndex(url, ":")
	n := 0
	for _, c := range url[i+1:] {
		n = n*10 + int(c-'0')
	}
	*port = n
	return 1, nil
}

// borrowerRoundTrip uses the private daemon and the injected D-Bus connection;
// neither a desktop daemon nor the user's browser is involved.
func borrowerRoundTrip(t *testing.T, d *daemon) {
	t.Helper()
	route := "#/job/sha256%3A" + strings.Repeat("a", 64) + "/circle"
	payloads := make(chan string, 1)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Route string `json:"route"`
		}
		if r.Method != "POST" || r.URL.Path != "/api/handoff" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		payloads <- payload.Route
		w.Write([]byte(`{"url":"http://127.0.0.1:4000/auth/handoff?code=job-once"}`))
	}))
	defer app.Close()
	var port int
	if _, err := fmtSscan(app.URL, &port); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	opened := make(chan string, 1)
	event := BorrowerNotification{ID: "epoch:2", Category: "job_ready", Title: "Your job is ready to review", Body: "Open Faravan to review the result.", Route: route}
	go func() {
		notifier := DBusNotifier{Connect: func() (*dbus.Conn, error) { return dbus.ConnectSessionBus() }}
		action, err := notifier.Notify(ctx, Notification{ID: event.ID, Title: event.Title, Body: event.Body, OpenOnClick: true})
		if err == nil {
			err = HandleBorrowerAction(ctx, AppClient{}, AppInfo{Port: port, Token: "session-secret"}, event, action, func(link string) error { opened <- link; return nil })
		}
		done <- err
	}()
	select {
	case note := <-d.shown:
		if note.Summary != event.Title || note.Body != event.Body {
			t.Fatalf("wrong job notification: %#v", note)
		}
		if err := d.invoke(note.ID, "default"); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("job notification never reached private daemon")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("job action timed out")
	}
	if got := <-payloads; got != route {
		t.Fatal("wrong job route", got)
	}
	if got := <-opened; got != "http://127.0.0.1:4000/auth/handoff?code=job-once" {
		t.Fatal("wrong one-time link", got)
	}
	t.Log("PASS: borrower review through private dbus")
}
