package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tnunamak/faravan/tray/internal/faravantray"
)

func capturePresentation(t *testing.T) (*trayApp, *[][]byte, *[]string, *time.Time) {
	t.Helper()
	oldIcon, oldTemplate, oldTooltip, oldNow := setTrayIcon, setTrayTemplateIcon, setTrayTooltip, renderNow
	t.Cleanup(func() {
		setTrayIcon, setTrayTemplateIcon, setTrayTooltip, renderNow = oldIcon, oldTemplate, oldTooltip, oldNow
	})
	icons, tips := [][]byte{}, []string{}
	setTrayIcon = func(icon []byte) { icons = append(icons, append([]byte(nil), icon...)) }
	setTrayTemplateIcon = func(icon, _ []byte) { setTrayIcon(icon) }
	setTrayTooltip = func(tip string) { tips = append(tips, tip) }
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	renderNow = func() time.Time { return now }
	return &trayApp{}, &icons, &tips, &now
}
func goodConnection() faravantray.Connection {
	status := &faravantray.AppStatus{State: "ready"}
	return faravantray.Connection{App: &faravantray.AppInfo{PID: 1234, StartedAt: "fixture", Port: 1234}, Status: status, Menu: faravantray.Menu{State: faravantray.VisualActive, Status: "Lending is on"}}
}
func failedRead(good faravantray.Connection) faravantray.Connection {
	return faravantray.Connection{App: good.App, Menu: faravantray.Menu{State: faravantray.VisualAttention, Status: "Status unavailable"}}
}
func TestUnchangedNativePresentationIsNotPublished(t *testing.T) {
	app, icons, tips, _ := capturePresentation(t)
	connection := goodConnection()
	app.render(connection)
	app.render(connection)
	if len(*icons) != 1 || len(*tips) != 1 {
		t.Fatalf("unchanged poll republished: icons=%d tooltips=%d", len(*icons), len(*tips))
	}
	connection.Menu.Status = "Running a job"
	app.render(connection)
	if len(*icons) != 1 || len(*tips) != 2 {
		t.Fatal("a tooltip change must not republish the icon")
	}
}
func TestOneFailedReadKeepsVisualAndRealStateChangesAreImmediate(t *testing.T) {
	app, icons, tips, now := capturePresentation(t)
	good := goodConnection()
	app.render(good)
	*now = now.Add(2 * time.Second)
	app.render(failedRead(good))
	if len(*icons) != 1 || len(*tips) != 1 || app.connection.Menu.State != faravantray.VisualActive {
		t.Fatal("one failed read changed the last good presentation")
	}
	if app.connection.Status != nil || app.connection.CardsKnown {
		t.Fatal("cached visuals must not manufacture current status or approval evidence")
	}
	paused := good
	paused.Status = &faravantray.AppStatus{State: "paused"}
	paused.Menu = faravantray.Menu{State: faravantray.VisualPaused, Status: "Paused"}
	app.render(paused)
	if len(*icons) != 2 || len(*tips) != 2 || bytes.Equal((*icons)[0], (*icons)[1]) {
		t.Fatal("a real state change was hidden")
	}
}
func TestSustainedFailureExpiresAndRecoveryResetsGrace(t *testing.T) {
	app, icons, tips, now := capturePresentation(t)
	good := goodConnection()
	app.render(good)
	for _, seconds := range []time.Duration{2, 4, 6} {
		*now = time.Date(2026, 1, 1, 0, 0, int(seconds), 0, time.UTC)
		app.render(failedRead(good))
	}
	if len(*icons) != 1 || len(*tips) != 1 {
		t.Fatal("a short sequence of failed reads flapped")
	}
	*now = now.Add(2 * time.Second)
	app.render(failedRead(good))
	if len(*icons) != 2 || len(*tips) != 2 || app.connection.Menu.State != faravantray.VisualAttention {
		t.Fatal("sustained failure did not show unavailable")
	}
	app.render(good)
	*now = now.Add(time.Second)
	app.render(failedRead(good))
	if app.connection.Menu.State != faravantray.VisualActive {
		t.Fatal("a successful read did not reset failure grace")
	}
}
func TestProvenAppExitDoesNotKeepTheLastGoodVisual(t *testing.T) {
	app, icons, _, _ := capturePresentation(t)
	app.render(goodConnection())
	record := filepath.Join(t.TempDir(), "app.json")
	if err := os.WriteFile(record, []byte(`{"pid":1234,"port":1234,"token":"fixture","started_at":"2026-01-01T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	gone := (faravantray.LocalClient{AppPath: record, Alive: func(int) bool { return false }}).Discover(context.Background())
	gone.Menu.Entries = nil
	app.render(gone)
	if len(*icons) != 2 || app.connection.Menu.State == faravantray.VisualActive {
		t.Fatal("known process exit retained a live visual")
	}
}
