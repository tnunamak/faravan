package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/godbus/dbus/v5"
	"github.com/pkg/browser"

	"github.com/tnunamak/faravan/tray/internal/faravantray"
	"github.com/tnunamak/faravan/tray/internal/telemetry"
)

// Overridden by Windows initialization; other platforms keep their existing icons.
var windowsTrayAppearance = func() (light bool, size int) { return false, 16 }

// Unix initialization gives only short-lived tray helpers their own process groups.
var prepareHelperProcess = func(*exec.Cmd) func() { return nil }

// Native presentation boundaries; tests exercise rendering without registering a tray.
var setTrayIcon = systray.SetIcon
var setTrayTemplateIcon = systray.SetTemplateIcon
var setTrayTooltip = systray.SetTooltip
var renderNow = time.Now

var startInputIdle = func(*faravantray.TrayLifetime) func(context.Context) (float64, error) {
	return inputIdleSeconds
}

type trayApp struct {
	lifetime faravantray.TrayLifetime
	idleSeconds func(context.Context) (float64, error)
	client faravantray.LocalClient
	mu sync.Mutex
	connection faravantray.Connection
	drawn string // signature of the menu on screen
 presentation presentationState
	stopClicks chan struct{}
	dialog faravantray.QuitDialog // nil when there is no native dialog tool
	confirm *faravantray.QuitPrompt // set while the quit question is drawn inside the menu (no dialog tool)
	notice string // the last failed action or expired request, shown at the top for a while
	noticeUntil time.Time
	notifier faravantray.Notifier // nil when this computer has no notification tool
	borrowerMu sync.Mutex // protects the feed tracker without holding the menu lock during I/O
	borrowerTracker faravantray.BorrowerTracker
	tracker faravantray.RequestTracker
 health faravantray.HealthNoticeTracker
	cancels map[string]context.CancelFunc // open request notifications, by approval id
	trayReporter faravantray.TrayReporter
	edge telemetry.Writer
	unreachable telemetry.Unreachable
}

func main() {
	defer faravantray.RethrowAfter(func() { _ = trayWriter().Panic(time.Since(trayStarted)) })
	if err := faravantray.RunTrayInstance(runTray); err != nil {
		fmt.Fprintln(os.Stderr, "faravan-tray:", err)
		os.Exit(1)
	}
}

func runTray() {
	appPath, err := faravantray.AppInfoPath()
	if err != nil { fmt.Fprintln(os.Stderr, "faravan-tray:", err); os.Exit(1) }
	app := &trayApp{client:faravantray.LocalClient{AppPath:appPath}, edge: trayWriter()}
	app.lifetime.OnPanic = func() { _ = app.edge.Panic(time.Since(trayStarted)) }
	app.notifier, _ = faravantray.NewNotifier(runtime.GOOS, runCommand, haveCommand, faravantray.NotifyHelperPath(runtime.GOOS, executable(), os.Getenv("FARAVAN_NOTIFY_HELPER")), faravantray.InstalledBranding())
	app.dialog, _ = faravantray.NewQuitDialog(runtime.GOOS, runCommand, haveCommand)
	if runtime.GOOS == "windows" { registerToastIdentity() }
	systray.Run(app.onReady, app.onExit)
}
// Keep the native exit callback outside registered workers: it waits for them.
func (app *trayApp) requestExit() { go systray.Quit() }

func (app *trayApp) onExit() {
	if !app.lifetime.Shutdown(2 * time.Second) {
		fmt.Fprintln(os.Stderr, "faravan-tray: timed out waiting for tray helpers")
	}
}
func (app *trayApp) onReady() {
	app.idleSeconds = startInputIdle(&app.lifetime)
	app.mu.Lock()
	app.render(faravantray.Connection{Menu:faravantray.Menu{State:faravantray.VisualAttention, Status:"Checking status", Entries:[]faravantray.Entry{
		{ID:"status", Label:"Checking status", Disabled:true}, {Separator:true}, {ID:"quit", Label:"Quit"}}}})
	app.mu.Unlock()
	// Started by Faravan.app's launcher: quit with it, however it ended (Force Quit included). Only the icon goes;
	// the launcher stops the app it owns.
	if faravantray.OwnedByLauncher(os.Getenv) {
		gone := faravantray.OwnerGone(os.Stdin)
		app.lifetime.Go(func(ctx context.Context) {
			select {
			case <-gone: app.requestExit()
			case <-ctx.Done():
			}
		})
	}
	app.lifetime.Go(func(ctx context.Context) {
		ticker := time.NewTicker(faravantray.PollInterval())
		defer ticker.Stop()
		for {
			if ctx.Err() != nil { return }
			app.refresh()
			select {
			case <-ticker.C:
			case <-ctx.Done(): return
			}
		}
	})
}

// render draws the menu. The library cannot hide a separator, so a changed menu is
// rebuilt from scratch. Unchanged native icon and tooltip values are not published. Callers hold mu.
func (app *trayApp) render(connection faravantray.Connection) {
	if app.lifetime.Context().Err() != nil { return }
	connection = app.presentation.stable(connection, renderNow())
	app.connection = connection
	menu := connection.Menu
	if app.confirm != nil { menu.Entries = faravantray.QuitConfirmEntries(*app.confirm) }
	if app.notice != "" && renderNow().After(app.noticeUntil) { app.notice = "" }
	if app.notice != "" { menu.Entries = append([]faravantray.Entry{{ID:"notice", Label:app.notice, Disabled:true}, {Separator:true}}, menu.Entries...) }
	var icon []byte
	if runtime.GOOS == "darwin" {
		icon = faravantray.IconPNGFor(menu.State, "darwin", 44)
	} else if runtime.GOOS == "windows" {
		light, size := windowsTrayAppearance()
		icon = faravantray.IconPNGFor(menu.State, "windows", size, light)
	} else {
		icon = faravantray.IconPNGFor(menu.State, runtime.GOOS, 32)
	}
	app.presentation.publish(icon, menu.Status, runtime.GOOS == "darwin")

	if sig := menu.Signature(); sig != app.drawn {
		app.drawn = sig
		if app.stopClicks != nil { close(app.stopClicks) }
		systray.ResetMenu()
		stop := make(chan struct{})
		app.stopClicks = stop
		var draw func(entries []faravantray.Entry, parent *systray.MenuItem)
		draw = func(entries []faravantray.Entry, parent *systray.MenuItem) {
			for _, entry := range entries {
				if entry.Separator {
					if parent == nil { systray.AddSeparator() } else { parent.AddSeparator() }
					continue
				}
				var item *systray.MenuItem
				if parent == nil { item = systray.AddMenuItem(entry.Label, "") } else { item = parent.AddSubMenuItem(entry.Label, "") }
				if entry.Disabled { item.Disable(); continue }
				if len(entry.Children) > 0 { draw(entry.Children, item); continue }
				id := entry.ID
				app.lifetime.Go(func(ctx context.Context) {
					for {
						select {
						case <-item.ClickedCh:
							app.action(id)
						case <-ctx.Done():
							return
						case <-stop:
							return
						}
					}
				})
			}
		}
		draw(menu.Entries, nil)
	}
}
func (app *trayApp) refresh() {
	ctx, cancel := context.WithTimeout(app.lifetime.Context(), 2*time.Second)
	defer cancel()
	app.client.Refresh(ctx, &app.mu, app.render, func(ctx context.Context, connection faravantray.Connection) {
		app.announceBorrower(ctx, connection)
		app.mu.Lock()
		app.announce(ctx, connection)
		app.announceHealth(connection)
		app.mu.Unlock()
		app.reportTray(ctx, connection)
		app.reportReachability(connection)
		if connection.App != nil {
			var idle *float64
			if seconds, err := app.idleSeconds(ctx); err == nil { idle = &seconds }
			_ = app.client.AppClient.ReportPresence(ctx, *connection.App, idle)
		}
	})
}

func (app *trayApp) announceHealth(connection faravantray.Connection) {
 if app.notifier==nil || connection.Status==nil || connection.App==nil {return}
 note:=app.health.Update(*connection.Status)
 if note==nil {return}
 info:=*connection.App
 app.lifetime.Go(func(ctx context.Context){
  ctx,cancel:=context.WithTimeout(app.lifetime.Context(),10*time.Minute);defer cancel()
  action,err:=app.notifier.Notify(ctx,*note)
  if err!=nil {app.mu.Lock();app.health.Retry(note.ID);app.mu.Unlock();fmt.Fprintln(os.Stderr,"faravan-tray: lending notification unavailable");return}
  if action==faravantray.ActionReview {
   if app.client.RunMenuAction(ctx,faravantray.ActionEnv{Client:app.client.AppClient,Info:info,OpenURL:browser.OpenURL},"fix")!=nil {fmt.Fprintln(os.Stderr,"faravan-tray: could not open lending repair")}
  }
 })
}

// reportTray tells the app, on Linux only, whether this desktop can show the
// icon. Mac and Windows always can. The app then shows the no-tray note
// (tray.linux-notray); the notifications and the launcher still work.
func (app *trayApp) reportTray(ctx context.Context, connection faravantray.Connection) {
	if runtime.GOOS != "linux" || connection.App == nil { return }
	available := faravantray.LinuxTrayAvailable(func(name string) (bool, error) {
		return sessionBusHasOwner(ctx, name)
	})
	if value, due := app.trayReporter.Due(*connection.App, available); due {
		if err := app.client.AppClient.ReportTray(ctx, *connection.App, value); err == nil { app.trayReporter.Done(*connection.App, value) }
	}
}

// announce shows one notification per new request and takes it down when the request leaves the list (answered
// elsewhere or expired). Each waits for its own answer in a goroutine, so a pending notification never stalls the poll.
func (app *trayApp) announce(ctx context.Context, connection faravantray.Connection) {
	if connection.App == nil { return }
	// Unknown or stale settings must not decide whether a new request is announced or silently consumed.
	app.borrowerMu.Lock()
	settingsCurrent := app.borrowerTracker.SettingsCurrent()
	desktopEnabled := app.borrowerTracker.DesktopEnabled("requests")
	app.borrowerMu.Unlock()
	fresh, gone := app.tracker.Observe(connection.Cards, connection.CardsKnown, settingsCurrent)
	if app.cancels == nil { app.cancels = map[string]context.CancelFunc{} }
	for _, card := range gone {
		if cancel := app.cancels[card.ID]; cancel != nil { cancel(); delete(app.cancels, card.ID) } // closes the notification by its id
		name := firstName(card)
		app.setNotice(name + "’s request is no longer waiting.")
	}
	if app.notifier == nil || !desktopEnabled { return }
	info := *connection.App
	for _, card := range fresh {
		note := faravantray.NotificationForCard(card, connection.Circles)
		// The notification lives as long as the request does, not a fixed time.
		lifetime := 11 * time.Minute
		if card.ExpiresAt > 0 { if d := time.Until(time.UnixMilli(int64(card.ExpiresAt))); d > 0 && d < lifetime { lifetime = d } }
		waitCtx, cancel := context.WithTimeout(app.lifetime.Context(), lifetime)
		app.cancels[card.ID] = cancel
		app.lifetime.Go(func(ctx context.Context) {
			defer cancel()
			action, err := app.notifier.Notify(waitCtx, note)
			if errors.Is(err, faravantray.ErrNotShown) {
				// Nothing reached the screen: announce the request again on a later poll while it still waits.
				app.mu.Lock(); app.tracker.Forget(card.ID); app.mu.Unlock()
				fmt.Fprintln(os.Stderr, "faravan-tray:", err)
				return
			}
			if waitCtx.Err() != nil { return } // taken down because the request left the list
			if err == nil { err = faravantray.HandleAction(waitCtx, app.client.AppClient, app.client.CurrentApp(info), note.ID, action, browser.OpenURL) }
			if errors.Is(err, faravantray.ErrRequestGone) {
				app.mu.Lock(); app.setNotice(firstName(card) + "’s request is no longer waiting."); app.mu.Unlock()
				return
			}
			if err != nil { fmt.Fprintln(os.Stderr, "faravan-tray:", err) }
		})
	}
}
// announceBorrower polls even when the notifier is unavailable so the cursor
// advances and category settings also govern the approval notifications.
func (app *trayApp) announceBorrower(ctx context.Context, connection faravantray.Connection) {
	if connection.App == nil {
		return
	}
	info := *connection.App
	app.borrowerMu.Lock()
	fresh, err := app.borrowerTracker.Poll(ctx, app.client.AppClient, info)
	app.borrowerMu.Unlock()
	if err != nil || app.notifier == nil {
		return
	}
	for _, event := range fresh {
		app.lifetime.Go(func(ctx context.Context) {
			waitCtx, cancel := context.WithTimeout(app.lifetime.Context(), 11*time.Minute)
			defer cancel()
			note := faravantray.Notification{ID: event.ID, Title: event.Title, Body: event.Body, OpenOnClick: true}
			action, err := app.notifier.Notify(waitCtx, note)
			if errors.Is(err, faravantray.ErrNotShown) {
				// Nothing reached the screen and the feed has moved on: offer it again later.
				app.borrowerMu.Lock(); app.borrowerTracker.Requeue(event); app.borrowerMu.Unlock()
				fmt.Fprintln(os.Stderr, "faravan-tray:", err)
				return
			}
			if err == nil && waitCtx.Err() == nil {
				err = faravantray.HandleBorrowerAction(waitCtx, app.client.AppClient, app.client.CurrentApp(info), event, action, browser.OpenURL)
			}
			if err != nil && waitCtx.Err() == nil {
				fmt.Fprintln(os.Stderr, "faravan-tray:", err)
			}
		})
	}
}

// setNotice shows a line at the top of the menu for 30 seconds.
func (app *trayApp) setNotice(text string) { app.notice, app.noticeUntil = text, time.Now().Add(30*time.Second) }
func firstName(card faravantray.ApprovalCard) string {
	if card.Kind == faravantray.ChatgptKind { return "ChatGPT" }
	for _, v := range []string{card.LocalName, card.RequesterName} { if strings.TrimSpace(v) != "" { return v } }
	return "A"
}
func (app *trayApp) action(id string) {
	if app.lifetime.Context().Err() != nil { return }
	if id == "quit" { app.quit(); return }
	if id == "stop" { app.stopJob(); return }
	if kind, choice, ok := faravantray.ParseQuitConfirm(id); ok {
		app.mu.Lock()
		shown := ""
		if app.confirm != nil { shown = app.confirm.Attempt }
		app.confirm = nil
		app.mu.Unlock()
		if kind == "stop-job" { app.finishStop(choice, shown) } else { app.finishQuit(choice, shown) }
		return
	}
	app.mu.Lock()
	connection := app.connection
	app.mu.Unlock()
	ctx, cancel := context.WithTimeout(app.lifetime.Context(), 10*time.Second)
	defer cancel()
	var err error
	if id == "start" {
		_, err = app.client.StartAndWait(ctx, startApp)
	} else if connection.App == nil {
		err = fmt.Errorf("Faravan is unavailable")
	} else {
		err = app.client.RunMenuAction(ctx, faravantray.ActionEnv{Client:app.client.AppClient, Info:*connection.App, Now:time.Now(), Loc:time.Local, OpenURL:browser.OpenURL}, id)
	}
	updated := app.client.Discover(ctx)
	app.mu.Lock()
	defer app.mu.Unlock()
	app.notice = ""
	if err != nil {
		// Errors never include the session token or an untrusted response body.
		app.setNotice("Faravan couldn't complete that action. Try again.")
		fmt.Fprintln(os.Stderr, "faravan-tray:", err)
	}
	app.render(updated)
}

func (app *trayApp) statusReader() func(context.Context) (faravantray.AppStatus, error) {
	return func(ctx context.Context) (faravantray.AppStatus, error) {
		app.mu.Lock()
		connection := app.connection
		app.mu.Unlock()
		if connection.App == nil { return faravantray.AppStatus{}, errors.New("Faravan is unavailable") }
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return app.client.AppClient.Status(callCtx, *connection.App)
	}
}

// ask shows the prompt in the OS dialog, or draws it in the menu when there is no dialog tool (then the answer
// arrives later through a menu click, with the attempt the prompt named).
func (app *trayApp) ask(prompt faravantray.QuitPrompt) (faravantray.QuitChoice, error) {
	if app.dialog == nil { app.showConfirm(prompt); return faravantray.QuitCancel, faravantray.ErrAskLater }
	dialogCtx, stop := context.WithTimeout(app.lifetime.Context(), 30*time.Minute)
	defer stop()
	choice, err := app.dialog.Ask(dialogCtx, prompt)
	if errors.Is(err, faravantray.ErrNoDialog) { app.showConfirm(prompt); return faravantray.QuitCancel, faravantray.ErrAskLater }
	return choice, err
}

// quit runs Quit…: the dialog runs without the lock, so the icon keeps updating while it is open.
func (app *trayApp) quit() {
	app.mu.Lock()
	connection := app.connection
	app.mu.Unlock()
	ctx, cancel := context.WithTimeout(app.lifetime.Context(), 5*time.Minute)
	defer cancel()
	flow := faravantray.QuitFlow{Env: faravantray.QuitEnv{Client: app.client.AppClient}, Status: app.statusReader(), Ask: app.ask}
	quit, err := faravantray.RunConnectionQuit(ctx, connection, flow)
	if errors.Is(err, faravantray.ErrAskLater) { return }
	if err != nil { app.fail(err); return }
	if quit { app.requestExit() }
}

// stopJob runs "Stop Sam’s job…": ask, then stop the attempt the question named.
func (app *trayApp) stopJob() {
	app.mu.Lock()
	connection := app.connection
	app.mu.Unlock()
	if connection.App == nil { return }
	ctx, cancel := context.WithTimeout(app.lifetime.Context(), 5*time.Minute)
	defer cancel()
	flow := faravantray.StopFlow{Client: app.client.AppClient, Info: *connection.App, Status: app.statusReader(), Ask: app.ask}
	if err := flow.Run(ctx); err != nil && !errors.Is(err, faravantray.ErrAskLater) { app.fail(err) }
}

// finishStop and finishQuit take an answer that came from the in-menu question, for the attempt that question named.
func (app *trayApp) finishStop(choice faravantray.QuitChoice, shown string) {
	if choice != faravantray.QuitStopJob { return }
	app.mu.Lock()
	connection := app.connection
	app.mu.Unlock()
	if connection.App == nil { return }
	ctx, cancel := context.WithTimeout(app.lifetime.Context(), 60*time.Second)
	defer cancel()
	err := faravantray.StopJob(ctx, app.client.AppClient, *connection.App, shown)
	if errors.Is(err, faravantray.ErrJobChanged) { app.stopJob(); return } // ask again about the new job
	if err != nil { app.fail(err) }
}
func (app *trayApp) finishQuit(choice faravantray.QuitChoice, shown string) {
	app.mu.Lock()
	connection := app.connection
	app.mu.Unlock()
	if connection.App == nil { app.requestExit(); return }
	ctx, cancel := context.WithTimeout(app.lifetime.Context(), 3*time.Minute)
	defer cancel()
	quit, err := faravantray.RunQuit(ctx, faravantray.QuitEnv{Client: app.client.AppClient, Info: *connection.App}, choice, shown)
	if errors.Is(err, faravantray.ErrJobStarted) || errors.Is(err, faravantray.ErrJobChanged) { app.quit(); return }
	if err != nil { app.fail(err); return }
	if quit { app.requestExit() }
}
func (app *trayApp) showConfirm(prompt faravantray.QuitPrompt) {
	app.mu.Lock()
	defer app.mu.Unlock()
	app.confirm = &prompt
	app.render(app.connection)
}
func (app *trayApp) fail(err error) {
	app.mu.Lock()
	defer app.mu.Unlock()
	app.setNotice("Faravan couldn't complete that action. Try again.")
	switch {
	case errors.Is(err, faravantray.ErrStillStopping): app.setNotice("Faravan is still stopping the job. It was not forced to quit.")
	case errors.Is(err, faravantray.ErrShutdownUnsupported): app.setNotice("This version of Faravan can't be quit from here. Quit it from its window.")
	case errors.Is(err, faravantray.ErrJobChanged), errors.Is(err, faravantray.ErrJobStarted): app.setNotice("A job is running, so nothing was stopped.")
	}
	fmt.Fprintln(os.Stderr, "faravan-tray:", err)
	app.render(app.connection)
}

func sessionBusHasOwner(ctx context.Context, name string) (bool, error) {
	conn, err := dbus.SessionBus()
	if err != nil { return false, err }
	var owned bool
	err = conn.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.NameHasOwner", 0, name).Store(&owned)
	return owned, err
}

// Production boundaries for notifications; unit tests inject fakes instead.
func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	return faravantray.RunHelperCommand(ctx, prepareHelperProcess, name, args...)
}
func haveCommand(name string) bool {
	if name == "session-bus" { return faravantray.SessionBusAvailable() }
	_, err := exec.LookPath(name)
	return err == nil
}
func registerToastIdentity() {
	// IconUri takes an image file; the tray's .exe is not one. The layout ships the PNG beside the app files.
	exe, _ := os.Executable()
	icon := faravantray.ShippedIcon("windows", exe)
	if _, err := os.Stat(icon); err != nil { icon = "" }
	for _, call := range faravantray.ToastRegistration(icon) { _ = exec.Command("reg", call...).Run() }
}

// This production boundary is never invoked by unit tests.
func startApp() error {
	bin, err := faravanBinary()
	if err != nil { return err }
	command := exec.Command(bin) // The normal launcher installs a resident owner.
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "FARAVAN_NO_BROWSER=") { command.Env = append(command.Env, entry) }
	}
	command.Env = append(command.Env, "FARAVAN_NO_BROWSER=1")
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil { return err }
	defer null.Close()
	command.Stdout, command.Stderr = null, null
	command.SysProcAttr = detachedProcess()
	if err := command.Start(); err != nil { return err }
	go func() { _ = command.Wait() }()
	return nil
}
func faravanBinary() (string, error) {
	home, _ := os.UserHomeDir()
	return faravantray.FaravanCLI(runtime.GOOS, executable(), home, exec.LookPath)
}
// trayStarted anchors the uptime in the tray's crash record.
var trayStarted = time.Now()

// trayWriter writes to the app home's telemetry inbox. With no home it writes nothing.
func trayWriter() telemetry.Writer {
	home, err := faravantray.HomePath()
	if err != nil {
		return telemetry.Writer{}
	}
	return telemetry.Writer{Dir: filepath.Join(home, "v1", "telemetry")}
}

// reportReachability writes the app-unreachable record: once an hour, after the app has been silent for ten minutes.
func (app *trayApp) reportReachability(connection faravantray.Connection) {
	now := time.Now()
	if app.unreachable.Observe(now, connection.Status != nil) {
		_ = app.edge.AppUnreachable(now)
	}
}

func executable() string {
	exe, err := os.Executable()
	if err != nil { return "" }
	if resolved, err := filepath.EvalSymlinks(exe); err == nil { return resolved }
	return exe
}
