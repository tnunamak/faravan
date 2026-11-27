package faravantray

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func runningStatus() AppStatus {
	return AppStatus{State: "running", CurrentJob: []byte(`"attempt-1"`), RunningJob: &runningJob{Requester: "Sam"}}
}

// finishing is S1.1b: lending is paused, and Sam's job still runs.
func finishingStatus() AppStatus {
	s := AppStatus{State: "paused", Headline: "Paused · Sam's job is finishing, stops by 3:01 PM"}
	s.Execution.State, s.Execution.Job, s.Execution.Person = "finishing", "attempt-9", "Sam"
	return s
}
func labelsOf(p QuitPrompt) []string { var out []string; for _, b := range p.Buttons { out = append(out, b.Label) }; return out }

func TestQuitPromptSaysWhatHappensToLendingAndTheJob(t *testing.T) {
	p := QuitPromptFor(runningStatus())
	if p.Title != "Quit Faravan?" || p.Body != "Sam’s job is running. Pause after this job prevents new jobs and keeps Faravan running while this job finishes. Stop the job and quit requests a stop, then quits when the job has stopped." { t.Fatalf("%#v", p) }
	if !reflect.DeepEqual(labelsOf(p), []string{"Pause after this job", "Stop the job and quit", "Cancel"}) || !p.Buttons[0].Primary { t.Fatalf("buttons %v", labelsOf(p)) }
	if got := QuitPromptFor(AppStatus{State: "running"}).Body; !strings.HasPrefix(got, "A job is running.") { t.Fatal(got) }
	idle := QuitPromptFor(AppStatus{State: "ready"})
	if !strings.Contains(idle.Body, "lending") || !strings.Contains(idle.Body, "kept for the next start") || !reflect.DeepEqual(labelsOf(idle), []string{"Quit Faravan", "Cancel"}) { t.Fatalf("%#v", idle) }
	if strings.Contains(idle.Body, "stops it") { t.Fatal("no job, no sentence about stopping one") }
	// No prompt offers to stop a job when none runs, and the plain button never does.
	for _, state := range []string{"ready", "paused", "off", "blocked", "update", "outside", "resting", "starting"} {
		for _, b := range QuitPromptFor(AppStatus{State: state}).Buttons { if b.Choice == QuitStopJob { t.Fatalf("%s offers to stop a job", state) } }
	}
}

func TestMacDialogMatchesTheMockupAndReadsTheAnswer(t *testing.T) {
	p := QuitPromptFor(runningStatus())
	args := MacQuitArgs(p)
	want := `display dialog "Sam’s job is running. Pause after this job prevents new jobs and keeps Faravan running while this job finishes. Stop the job and quit requests a stop, then quits when the job has stopped." with title "Quit Faravan?" buttons {"Cancel", "Stop the job and quit", "Pause after this job"} default button "Pause after this job" cancel button "Cancel" with icon note`
	if args[0] != "-e" || args[1] != want { t.Fatalf("%s", args[1]) }
	cases := map[string]QuitChoice{"button returned:Pause after this job\n": QuitPauseAfterJob, "button returned:Stop the job and quit, gave up:false\n": QuitStopJob, "button returned:Cancel\n": QuitCancel}
	for out, want := range cases {
		var calls []call
		got, err := MacQuitDialog{Run: fakeRunner(out, nil, &calls)}.Ask(context.Background(), p)
		if err != nil || got != want || calls[0].name != "osascript" { t.Fatalf("%q: %v %v", out, got, err) }
	}
	exit1 := exec.Command("sh", "-c", "exit 1").Run()
	if got, err := (MacQuitDialog{Run: fakeRunner("", exit1, new([]call))}).Ask(context.Background(), p); err != nil || got != QuitCancel { t.Fatal("Escape is cancel") }
	if _, err := (MacQuitDialog{Run: fakeRunner("garbage", nil, new([]call))}).Ask(context.Background(), p); err == nil { t.Fatal("an unreadable answer never quits") }
	two := MacQuitArgs(QuitPromptFor(AppStatus{State: "ready"}))[1]
	if !strings.Contains(two, `buttons {"Cancel", "Quit Faravan"} default button "Quit Faravan"`) { t.Fatal(two) }
	if got := MacQuitArgs(QuitPrompt{Title: `a"b`, Body: "x\ny", Buttons: p.Buttons})[1]; strings.Contains(got, "\n") || !strings.Contains(got, `with title "a\"b"`) { t.Fatal("quoting") }
}

func TestWindowsDialogNamesWhatTheFixedButtonsDo(t *testing.T) {
	p := QuitPromptFor(runningStatus())
	text, buttons := WindowsQuitText(p)
	if buttons != "YesNoCancel" || !strings.Contains(text, "Yes: Pause after this job") || !strings.Contains(text, "No: Stop the job and quit") || !strings.Contains(text, "Cancel: keep Faravan running") { t.Fatal(text) }
	if _, b := WindowsQuitText(QuitPromptFor(AppStatus{State: "ready"})); b != "YesNo" { t.Fatal(b) }
	if s := WindowsQuitScript(QuitPrompt{Title: "It's", Body: "O'Neil’s job", Buttons: p.Buttons}); !strings.Contains(s, "'It''s'") || !strings.Contains(s, "O''Neil") { t.Fatal("PowerShell quoting: " + s) }
	for out, want := range map[string]QuitChoice{"Yes\r\n": QuitPauseAfterJob, "No\r\n": QuitStopJob, "Cancel\r\n": QuitCancel, "None": QuitCancel} {
		got, err := WindowsQuitDialog{Run: fakeRunner(out, nil, new([]call))}.Ask(context.Background(), p)
		if err != nil || got != want { t.Fatalf("%q: %v %v", out, got, err) }
	}
	idle := QuitPromptFor(AppStatus{State: "ready"})
	if got, _ := (WindowsQuitDialog{Run: fakeRunner("No", nil, new([]call))}).Ask(context.Background(), idle); got != QuitCancel { t.Fatal("No on a two-choice dialog is keep running") }
	if got, _ := (WindowsQuitDialog{Run: fakeRunner("Yes", nil, new([]call))}).Ask(context.Background(), idle); got != QuitNow { t.Fatal("Yes quits") }
}

func TestLinuxDialogs(t *testing.T) {
	p := QuitPromptFor(runningStatus())
	z := ZenityQuitArgs(p)
	for _, want := range []string{"--question", "--ok-label=Pause after this job", "--cancel-label=Cancel", "--extra-button=Stop the job and quit", "--title=Quit Faravan?", "--no-markup"} {
		if !contains(z, want) { t.Fatalf("zenity lacks %s: %v", want, z) }
	}
	exit1 := exec.Command("sh", "-c", "exit 1").Run()
	cases := []struct { out string; err error; want QuitChoice }{
		{"", nil, QuitPauseAfterJob}, {"Stop the job and quit\n", exit1, QuitStopJob}, {"", exit1, QuitCancel},
	}
	for _, c := range cases {
		got, err := ZenityQuitDialog{Run: fakeRunner(c.out, c.err, new([]call))}.Ask(context.Background(), p)
		if err != nil || got != c.want { t.Fatalf("zenity %q %v: %v %v", c.out, c.err, got, err) }
	}
	if contains(ZenityQuitArgs(QuitPromptFor(AppStatus{State: "ready"})), "--extra-button=Stop the job and quit") { t.Fatal("no stop button without a job") }
	k := KDialogQuitArgs(p)
	if !contains(k, "--yesnocancel") || !contains(k, "Pause after this job") || !contains(k, "Stop the job and quit") { t.Fatal(k) }
	code := func(n int) error { return exec.Command("sh", "-c", "exit "+string(rune('0'+n))).Run() }
	for _, c := range []struct { err error; want QuitChoice }{{nil, QuitPauseAfterJob}, {code(1), QuitStopJob}, {code(2), QuitCancel}} {
		got, err := KDialogQuitDialog{Run: fakeRunner("", c.err, new([]call))}.Ask(context.Background(), p)
		if err != nil || got != c.want { t.Fatalf("kdialog: %v %v", got, err) }
	}
	idle := QuitPromptFor(AppStatus{State: "ready"})
	if got, _ := (KDialogQuitDialog{Run: fakeRunner("", code(1), new([]call))}).Ask(context.Background(), idle); got != QuitCancel { t.Fatal("kdialog no on two buttons is cancel") }
}
func contains(list []string, want string) bool { for _, v := range list { if v == want { return true } }; return false }

func TestDialogSelectionPerOS(t *testing.T) {
	run := fakeRunner("", nil, new([]call))
	only := func(names ...string) func(string) bool { return func(n string) bool { return contains(names, n) } }
	cases := []struct { goos string; have func(string) bool; want any }{
		{"darwin", only("osascript"), MacQuitDialog{}}, {"windows", only("powershell.exe"), WindowsQuitDialog{}},
		{"linux", only("zenity", "kdialog"), ZenityQuitDialog{}}, {"linux", only("kdialog"), KDialogQuitDialog{}},
		{"linux", only(), nil}, {"darwin", only(), nil}, {"plan9", only("zenity"), nil},
	}
	for _, c := range cases {
		got, err := NewQuitDialog(c.goos, run, c.have)
		if c.want == nil { if !errors.Is(err, ErrNoDialog) { t.Fatalf("%s: %v", c.goos, err) }; continue }
		if err != nil || reflect.TypeOf(got) != reflect.TypeOf(c.want) { t.Fatalf("%s: %T %v", c.goos, got, err) }
	}
}

func TestInMenuFallbackAsksTheSameQuestion(t *testing.T) {
	entries := QuitConfirmEntries(QuitPromptFor(runningStatus()))
	var labels []string
	for _, e := range entries { if !e.Separator { labels = append(labels, e.Label) } }
	if labels[0] != "Quit Faravan?" || !contains(labels, "Pause after this job") || !contains(labels, "Stop the job and quit") || labels[len(labels)-1] != "Cancel" { t.Fatal(labels) }
	for _, e := range entries { if e.ID == "note" && !e.Disabled { t.Fatal("text lines are not clickable") } }
	if k, c, ok := ParseQuitConfirm("confirm:quit:stop"); !ok || c != QuitStopJob || k != "quit" { t.Fatal("parse") }
	if k, c, ok := ParseQuitConfirm("confirm:stop-job:stop"); !ok || c != QuitStopJob || k != "stop-job" { t.Fatal("parse stop-job") }
	if _, _, ok := ParseQuitConfirm("quit"); ok { t.Fatal("plain quit is not a confirmation") }
}




func TestPausedNeverHidesARunningJob(t *testing.T) {
	s := finishingStatus()
	if m := build("darwin", s); m.Status != "Paused · Sam's job is finishing, stops by 3:01 PM" || m.State != VisualActive {
		t.Fatalf("headline %q glyph %v", m.Status, m.State)
	}
	labels := strings.Join(build("darwin", s).Labels(), "\n")
	for _, want := range []string{"Watch it…", "Stop Sam’s job…", "Resume lending"} { if !strings.Contains(labels, want) { t.Errorf("missing %s in\n%s", want, labels) } }
	// The quit question names the job even though the intent is paused, and carries its attempt.
	p := QuitPromptFor(s)
	if !strings.Contains(p.Body, "Sam’s job is finishing") || len(p.Buttons) != 3 || p.Attempt != "attempt-9" { t.Fatalf("%#v", p) }
}

func TestStopSamsJobAsksFirst(t *testing.T) {
	p := StopJobPrompt(finishingStatus())
	if p.Title != "Stop Sam’s job?" || !strings.Contains(p.Body, "Pause new jobs") || !reflect.DeepEqual(labelsOf(p), []string{"Stop the job", "Cancel"}) { t.Fatalf("%#v", p) }
	if text, _ := WindowsQuitText(p); !strings.Contains(text, "No: leave the job running") { t.Fatal(text) }
	if StopJobPrompt(AppStatus{State: "ready"}).Title != "Stop this job?" { t.Fatal("no name, no invented one") }
	// RunMenuAction has no way to stop a job: only the confirmed path does.
	env := ActionEnv{Client: AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string { t.Errorf("unexpected call %s", r.URL.Path); return `{}` })}, Info: AppInfo{Port: 1, Token: "t"}, OpenURL: func(string) error { return nil }}
	if err := RunMenuAction(context.Background(), env, "stop"); err == nil { t.Fatal("stop is not a plain menu action") }
}

func TestRunningMenuMatchesMacRunning(t *testing.T) {
	s := AppStatus{State: "ready", Headline: "Lending is on · Sam's job is running, stops by 3:04 PM", Today: today()}
	s.Execution.State, s.Execution.Job, s.Execution.Person = "running", "a1", "Sam"
	m := build("darwin", s)
	want := []string{"Lending is on · Sam's job is running, stops by 3:04 PM", "Watch it…", "Stop Sam’s job…", "Today: 2 of 3 jobs · 18 of 60 min", "-",
		"Finish current job, then pause", "Pause lending", "Turn lending off", "-", "Open Faravan", "New job…", "Lending settings…", "Updates…", "You…", "-", "Quitting stops Faravan on this computer.", "Quit Faravan…"}
	if got := lines(m); !reflect.DeepEqual(got, want) { t.Fatalf("%q", got) }
	var menu Entry
	for _, e := range m.Entries { if e.ID == "pause-menu" { menu = e } }
	var kids []string
	for _, c := range menu.Children { kids = append(kids, c.Label+"="+c.ID) }
	if !reflect.DeepEqual(kids, []string{"For 30 minutes=pause-30m", "For 1 hour=pause-1h", "Until tomorrow, 7 AM=pause-tomorrow", "Until I resume=pause-after"}) { t.Fatal(kids) }
	if m.Signature() == build("darwin", AppStatus{State: "ready"}).Signature() || !strings.Contains(m.Signature(), "[") { t.Fatal("submenu is part of the signature") }
	if got := strings.Join(build("windows", AppStatus{State: "ready"}).Labels(), "|"); !strings.Contains(got, "Open Faravan|New job…") { t.Fatal(got) }
	if strings.Contains(strings.Join(build("darwin", AppStatus{State: "off"}).Labels(), "|"), "Ask for help") { t.Fatal("one name for this action: New job (same as the app)") }
	// An older app: running only as the single state.
	old := build("darwin", AppStatus{State: "running", RunningJob: &runningJob{Requester: "Sam"}})
	if !strings.Contains(strings.Join(old.Labels(), "|"), "Stop Sam’s job…") { t.Fatal(old.Labels()) }
	if !strings.Contains(strings.Join(build("darwin", AppStatus{State: "running"}).Labels(), "|"), "Stop this job…") { t.Fatal("unnamed") }
}

func TestTrayLifetimeHelperProcess(t *testing.T) {
	if os.Getenv("FARAVAN_TRAY_LIFETIME_HELPER") != "1" { return }
	if os.Getenv("FARAVAN_TRAY_LIFETIME_SPAWN") == "1" {
		child := trayLifetimeTestCommand(context.Background(), os.Getenv("FARAVAN_TRAY_LIFETIME_CHILD_READY"))
		child.Env = append(child.Env, "FARAVAN_TRAY_LIFETIME_SPAWN=0", "FARAVAN_TRAY_LIFETIME_EXIT=0")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil { os.Exit(3) }
		go func() { _ = child.Wait() }()
	}
	if err := os.WriteFile(os.Getenv("FARAVAN_TRAY_LIFETIME_READY"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil { os.Exit(2) }
	if os.Getenv("FARAVAN_TRAY_LIFETIME_EXIT") == "1" { return }
	for { time.Sleep(time.Hour) }
}

func trayLifetimeTestCommand(ctx context.Context, ready string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTrayLifetimeHelperProcess$")
	cmd.Env = append(os.Environ(), "FARAVAN_TRAY_LIFETIME_HELPER=1", "FARAVAN_TRAY_LIFETIME_READY="+ready)
	return cmd
}

func waitTrayLifetimeReady(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil { return }
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fake helper did not become ready")
}

func TestTrayLifetimeQuitStopsHelperButLeavesDetachedApp(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux tray process isolation") }
	var lifetime TrayLifetime
	helperCtx, stopHelper := context.WithCancel(lifetime.Context())
	defer stopHelper()
	ready := filepath.Join(t.TempDir(), "helper")
	childReady := filepath.Join(t.TempDir(), "child")
	helperDone := make(chan error, 1)
	if !lifetime.Go(func(context.Context) {
		_, err := RunHelperCommand(helperCtx, func(cmd *exec.Cmd) func() {
			cmd.Env = trayLifetimeTestCommand(helperCtx, ready).Env
			cmd.Env = append(cmd.Env, "FARAVAN_TRAY_LIFETIME_SPAWN=1", "FARAVAN_TRAY_LIFETIME_CHILD_READY="+childReady)
			return prepareTrayLifetimeTestGroup(cmd)
		}, os.Args[0], "-test.run=^TestTrayLifetimeHelperProcess$")
		helperDone <- err
	}) { t.Fatal("helper was rejected") }
	waitTrayLifetimeReady(t, ready)
	waitTrayLifetimeReady(t, childReady)

	appReady := filepath.Join(t.TempDir(), "app")
	appCtx, stopApp := context.WithCancel(context.Background())
	defer stopApp()
	app := trayLifetimeTestCommand(appCtx, appReady)
	app.SysProcAttr = &syscall.SysProcAttr{}
	// Keep this test buildable on Windows while exercising the real Linux session boundary.
	reflect.ValueOf(app.SysProcAttr).Elem().FieldByName("Setsid").SetBool(true)
	if err := app.Start(); err != nil { t.Fatal(err) }
	appDone := make(chan error, 1)
	go func() { appDone <- app.Wait() }()
	defer func() { stopApp(); select { case <-appDone: case <-time.After(time.Second): t.Error("fake app cleanup timed out") } }()
	waitTrayLifetimeReady(t, appReady)

	start := time.Now()
	stopped := lifetime.Shutdown(500 * time.Millisecond)
	if elapsed := time.Since(start); elapsed > time.Second { t.Fatalf("shutdown exceeded bound: %s", elapsed) }
	select {
	case err := <-appDone:
		t.Fatalf("detached app was terminated: %v", err)
	default:
	}
	if !stopped { t.Fatal("tray shutdown left its long-running helper alive") }
	assertTrayLifetimeProcessStopped(t, ready)
	assertTrayLifetimeProcessStopped(t, childReady)
	select {
	case <-helperDone:
	default: t.Fatal("shutdown returned before its helper was reaped")
	}
	if lifetime.Go(func(context.Context) { t.Error("work started after shutdown") }) { t.Fatal("shutdown accepted new work") }
	if !lifetime.Shutdown(100 * time.Millisecond) { t.Fatal("repeated shutdown did not finish") }
}

// The production Unix hook uses syscall.Kill(-pid, SIGKILL). os.Process.Signal
// exercises the same group operation without making this test file Unix-only.
func prepareTrayLifetimeTestGroup(cmd *exec.Cmd) func() {
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	reflect.ValueOf(cmd.SysProcAttr).Elem().FieldByName("Setpgid").SetBool(true)
	kill := func() error {
		if cmd.Process == nil { return nil }
		group, err := os.FindProcess(-cmd.Process.Pid)
		if err != nil { return err }
		defer group.Release()
		return group.Signal(syscall.Signal(9))
	}
	cmd.Cancel = kill
	return func() { _ = kill() }
}

func assertTrayLifetimeProcessStopped(t *testing.T, ready string) {
	t.Helper()
	raw, err := os.ReadFile(ready)
	if err != nil { t.Fatal(err) }
	pid, err := strconv.Atoi(string(raw))
	if err != nil { t.Fatal(err) }
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
		if os.IsNotExist(err) { return }
		// An orphaned child may be awaiting init's reap, but must not be running.
		if err == nil {
			if end := strings.LastIndex(string(stat), ") "); end >= 0 && strings.HasPrefix(string(stat[end+2:]), "Z ") { return }
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("tray helper %d is still running", pid)
}

func TestTrayLifetimeShutdownIsBounded(t *testing.T) {
	var lifetime TrayLifetime
	release := make(chan struct{})
	defer close(release)
	lifetime.Go(func(context.Context) { <-release })
	start := time.Now()
	if lifetime.Shutdown(20 * time.Millisecond) { t.Fatal("unfinished work reported stopped") }
	if time.Since(start) > time.Second { t.Fatal("shutdown did not respect its bound") }
	if lifetime.Context().Err() != context.Canceled { t.Fatal("shutdown did not cancel the lifetime") }
}

func TestTrayNotificationShowOutlivesRequestNotTray(t *testing.T) {
	var lifetime TrayLifetime
	request, cancel := context.WithCancel(lifetime.Context())
	show := notificationLifetime(request)
	cancel()
	if show.Err() != nil { t.Fatal("request removal prevented closing its notification") }
	lifetime.Shutdown(time.Second)
	if show.Err() != context.Canceled { t.Fatal("show exchange outlived the tray") }
}

func TestTrayLifetimeProductionWiring(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "cmd", "faravan-tray", "main.go"))
	if err != nil { t.Fatal(err) }
	main := string(source)
	for _, want := range []string{"systray.Run(app.onReady, app.onExit)", "app.lifetime.Shutdown(2 * time.Second)", "faravantray.RunHelperCommand(ctx, prepareHelperProcess, name, args...)"} {
		if !strings.Contains(main, want) { t.Fatalf("tray is missing lifetime wiring: %s", want) }
	}
	if strings.Contains(main, "context.Background()") { t.Fatal("tray work has an independent background context") }
	start := strings.Index(main, "func startApp() error")
	if start < 0 { t.Fatal("detached app launcher missing") }
	end := strings.Index(main[start:], "func faravanBinary()")
	if end < 0 { t.Fatal("detached app launcher boundary missing") }
	app := main[start:start+end]
	if !strings.Contains(app, "exec.Command(bin)") || !strings.Contains(app, "command.SysProcAttr = detachedProcess()") || strings.Contains(app, "RunHelperCommand") || strings.Contains(app, "lifetime") {
		t.Fatal("detached app must remain outside helper ownership")
	}
}

func TestTrayHelperCleansChildrenAfterParentExits(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux tray process isolation") }
	ready := filepath.Join(t.TempDir(), "helper")
	childReady := filepath.Join(t.TempDir(), "child")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	_, err := RunHelperCommand(ctx, func(cmd *exec.Cmd) func() {
		cmd.Env = trayLifetimeTestCommand(ctx, ready).Env
		cmd.Env = append(cmd.Env, "FARAVAN_TRAY_LIFETIME_SPAWN=1", "FARAVAN_TRAY_LIFETIME_CHILD_READY="+childReady, "FARAVAN_TRAY_LIFETIME_EXIT=1")
		return prepareTrayLifetimeTestGroup(cmd)
	}, os.Args[0], "-test.run=^TestTrayLifetimeHelperProcess$")
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) { t.Fatal(err) }
	if time.Since(start) > time.Second { t.Fatal("inherited pipes held helper cleanup open") }
	waitTrayLifetimeReady(t, childReady)
	assertTrayLifetimeProcessStopped(t, childReady)
}

func TestTrayLifetimeCancelsNotificationAndDialog(t *testing.T) {
	for _, kind := range []string{"notification", "dialog"} {
		t.Run(kind, func(t *testing.T) {
			var lifetime TrayLifetime
			started := make(chan struct{})
			done := make(chan error, 1)
			run := func(ctx context.Context, name string, args ...string) (string, error) {
				close(started)
				<-ctx.Done()
				return "", ctx.Err()
			}
			lifetime.Go(func(ctx context.Context) {
				var err error
				if kind == "notification" {
					_, err = (NotifySend{Run: run}).Notify(ctx, Notification{})
				} else {
					_, err = (ZenityQuitDialog{Run: run}).Ask(ctx, QuitPromptFor(AppStatus{State: "ready"}))
				}
				done <- err
			})
			<-started
			if !lifetime.Shutdown(time.Second) { t.Fatal("helper did not stop") }
			if err := <-done; !errors.Is(err, context.Canceled) { t.Fatalf("helper cancellation: %v", err) }
		})
	}
}
