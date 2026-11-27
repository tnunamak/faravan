package faravantray

import (
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	notifyService = "org.freedesktop.Notifications"
	notifyPath = "/org/freedesktop/Notifications"
)

// DBusNotifier shows a Linux notification by talking to the desktop's notification
// service directly (the freedesktop Notifications spec), so Review work
// without notify-send. notify-send runs under an AppArmor profile on recent Ubuntu that
// denies GetCapabilities; libnotify then drops every action button. The tray itself is
// not confined that way. Each call uses its own connection, so signals never cross.
type DBusNotifier struct {
	Brand Branding
	// Connect opens the session bus; nil means the user's session bus. Tests pass a private one.
	Connect func() (*dbus.Conn, error)
}

// DBusActions is the spec's flat [key, label, key, label...] action list.
func DBusActions() []string { return []string{string(ActionReview), "Review"} }

// DBusHints ties the notification to this install's launcher for its name and icon.
func DBusHints(b Branding) map[string]dbus.Variant {
	hints := map[string]dbus.Variant{"desktop-entry": dbus.MakeVariant(b.entry()), "category": dbus.MakeVariant("im.received")}
	if b.ImagePath != "" { hints["image-path"] = dbus.MakeVariant(b.ImagePath) }
	return hints
}

func (n DBusNotifier) Notify(ctx context.Context, note Notification) (Action, error) {
	connect := n.Connect
	if connect == nil { connect = func() (*dbus.Conn, error) { return dbus.ConnectSessionBus() } }
	conn, err := connect()
	if err != nil { return ActionNone, notShownError{err} }
	defer conn.Close()
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	defer conn.RemoveSignal(signals)
	// Listen before showing, so a fast click cannot be missed.
	for _, member := range []string{"ActionInvoked", "NotificationClosed"} {
		if err := conn.AddMatchSignalContext(ctx, dbus.WithMatchObjectPath(notifyPath), dbus.WithMatchInterface(notifyService), dbus.WithMatchMember(member)); err != nil { return ActionNone, notShownError{err} }
	}
	var id uint32
	// The show call survives request removal so its id can still be closed, but
	// tray shutdown cancels it along with all other tray work.
	showCtx, showDone := context.WithTimeout(notificationLifetime(ctx), 10*time.Second)
	defer showDone()
	actions := DBusActions()
	if note.OpenOnClick { actions = append([]string{"default", "Open job"}, actions...) }
	call := conn.Object(notifyService, notifyPath).CallWithContext(showCtx, notifyService+".Notify", 0,
		n.Brand.name(), uint32(0), n.Brand.icon(), note.Title, note.Body, actions, DBusHints(n.Brand), int32(-1))
	if err := call.Store(&id); err != nil { return ActionNone, err }
	chosen := ActionNone
	for {
		if ctx.Err() != nil {
			closeNotification(ctx, conn, id)
			return ActionNone, ctx.Err()
		}
		select {
		case <-ctx.Done():
			// The request is no longer being waited for: take the notification down so a late click cannot do nothing silently.
			closeNotification(ctx, conn, id)
			return ActionNone, ctx.Err()
		case s, ok := <-signals:
			if !ok { return chosen, errors.New("lost the session bus") }
			if len(s.Body) < 2 { continue }
			got, ok := s.Body[0].(uint32)
			if !ok || got != id { continue }
			switch s.Name {
			case notifyService + ".ActionInvoked":
				if key, ok := s.Body[1].(string); ok { chosen = ParseNotificationAction(key, note) }
				// Servers send NotificationClosed after an action; do not wait for it if it never comes.
				if chosen != ActionNone { return chosen, nil }
			case notifyService + ".NotificationClosed":
				return chosen, nil
			}
		}
	}
}

// SessionBusAvailable is true when a session bus address or the usual per-user socket exists.
func SessionBusAvailable() bool {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") != "" { return true }
	_, err := os.Stat("/run/user/" + strconv.Itoa(os.Getuid()) + "/bus")
	return err == nil
}

// Cleanup may run after request cancellation; a missing daemon must not hold
// tray shutdown open indefinitely.
func closeNotification(ctx context.Context, conn *dbus.Conn, id uint32) {
	closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 250*time.Millisecond)
	defer cancel()
	conn.Object(notifyService, notifyPath).CallWithContext(closeCtx, notifyService+".CloseNotification", 0, id)
}
