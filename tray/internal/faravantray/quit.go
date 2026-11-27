package faravantray

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
	"os/exec"
	"strings"
	"sync"
)

// QuitChoice is what the lender picked in the quit dialog (tray.mac-quit).
type QuitChoice string

const (
	QuitCancel QuitChoice = "cancel"
	QuitPauseAfterJob QuitChoice = "pause" // keep the app; finish the running job, then stop lending
	QuitStopJob QuitChoice = "stop" // stop the running job, then quit
	QuitNow QuitChoice = "quit" // no job is running: stop lending and quit
)

type QuitButton struct {
	Choice QuitChoice
	Label string
	Primary bool
}

// QuitPrompt is the dialog's text and buttons, the same on every OS.
type QuitPrompt struct {
	Kind string // "quit" or "stop-job"
	Attempt string // the job the text names: a stop answers for this attempt only, never a newer one
	KeepText string // what the "no" / cancel answer means, for dialogs that cannot rename their buttons
	Title, Body string
	Buttons []QuitButton // in the order the mockup shows them; the last is always Cancel
}

// HasRunningJob reads the effective state.
func HasRunningJob(status AppStatus) bool { return ExecutionState(status) != "idle" }

// QuitPromptFor says what quitting does to lending and to a running job, before it happens.
// Quit never stops a running job on its own: that takes the explicit "Stop the job and quit" button.
func QuitPromptFor(status AppStatus) QuitPrompt {
	status = normalize(status)
	cancel := QuitButton{QuitCancel, "Cancel", false}
	// A running or finishing job counts under any intent: a paused lender still has a job to protect.
	switch exec := ExecutionState(status); {
	case exec != "idle":
		who := "A job is"
		if p := JobPerson(status); p != "" { who = p + "’s job is" }
		phase := exec
		if exec == "stopping" { phase = "waiting for its stop to be confirmed" }
		deadline := ""
		if status.Execution.StopsBy != nil { deadline = ", stops by " + clockText(*status.Execution.StopsBy, time.Now(), time.Local) }
		return QuitPrompt{Kind: "quit", Attempt: attemptID(status), Title: "Quit Faravan?",
			Body: who + " " + phase + deadline + ". Pause after this job prevents new jobs and keeps Faravan running while this job finishes. Stop the job and quit requests a stop, then quits when the job has stopped.",
			Buttons: []QuitButton{{QuitPauseAfterJob, "Pause after this job", true}, {QuitStopJob, "Stop the job and quit", false}, cancel}}
	case status.State == stateOff:
		return QuitPrompt{Kind: "quit", Title: "Quit Faravan?", Body: "Faravan stops running on this computer. Lending is already off.",
			Buttons: []QuitButton{{QuitNow, "Quit Faravan", true}, cancel}}
	}
	return QuitPrompt{Kind: "quit", Title: "Quit Faravan?", Body: "No job is running. Quitting stops Faravan on this computer. Your lending settings are kept for the next start.",
		Buttons: []QuitButton{{QuitNow, "Quit Faravan", true}, cancel}}
}

// StopJobPrompt is the confirmation behind "Stop Sam’s job…". Stopping is its own action, never a side effect of pausing.
func StopJobPrompt(status AppStatus) QuitPrompt {
	who := "this job"
	if p := JobPerson(status); p != "" { who = p + "’s job" }
	return QuitPrompt{Kind: "stop-job", Attempt: attemptID(status), KeepText: "leave the job running", Title: "Stop " + who + "?",
		Body: "Faravan requests a stop and turns lending off. The job may still be stopping until its sandbox closes. To let it finish instead, choose Pause new jobs.",
		Buttons: []QuitButton{{QuitStopJob, "Stop the job", true}, {QuitCancel, "Cancel", false}}}
}

// QuitDialog shows the prompt in the OS's own dialog and waits for the answer.
type QuitDialog interface {
	Ask(ctx context.Context, prompt QuitPrompt) (QuitChoice, error)
}

// ErrNoDialog means this computer has no tool for a native dialog; the tray then asks inside its own menu.
var ErrNoDialog = errors.New("no dialog tool is available on this computer")

// ExitCode is the process exit status inside err, or -1 when err is nil or not an exit error.
func ExitCode(err error) int {
	var exit *exec.ExitError
	if errors.As(err, &exit) { return exit.ExitCode() }
	return -1
}

func choiceFor(prompt QuitPrompt, label string) (QuitChoice, bool) {
	for _, b := range prompt.Buttons { if strings.TrimSpace(label) == b.Label { return b.Choice, true } }
	return QuitCancel, false
}

func NewQuitDialog(goos string, run Runner, have func(string) bool) (QuitDialog, error) {
	switch goos {
	case "darwin":
		if have("osascript") { return MacQuitDialog{Run: run}, nil }
	case "windows":
		if have("powershell.exe") { return WindowsQuitDialog{Run: run}, nil }
	case "linux":
		if have("zenity") { return ZenityQuitDialog{Run: run}, nil }
		if have("kdialog") { return KDialogQuitDialog{Run: run}, nil }
	}
	return nil, ErrNoDialog
}

// --- macOS: osascript "display dialog" holds up to three buttons, exactly the mockup's.

type MacQuitDialog struct{ Run Runner }

func appleList(labels []string) string {
	quoted := make([]string, len(labels))
	for i, l := range labels { quoted[i] = AppleScriptString(l) }
	return "{" + strings.Join(quoted, ", ") + "}"
}

// MacQuitArgs puts Cancel first and the primary button last: macOS makes the last button the
// default and maps Escape to the button named Cancel.
func MacQuitArgs(prompt QuitPrompt) []string {
	primary := ""
	var ordered, others []string
	for _, b := range prompt.Buttons {
		switch {
		case b.Choice == QuitCancel: ordered = append(ordered, b.Label)
		case b.Primary: primary = b.Label
		default: others = append(others, b.Label)
		}
	}
	ordered = append(append(ordered, others...), primary)
	return []string{"-e", "display dialog " + AppleScriptString(prompt.Body) + " with title " + AppleScriptString(prompt.Title) +
		" buttons " + appleList(ordered) + " default button " + AppleScriptString(primary) + " cancel button " + AppleScriptString("Cancel") + " with icon note"}
}

func (d MacQuitDialog) Ask(ctx context.Context, prompt QuitPrompt) (QuitChoice, error) {
	out, err := d.Run(ctx, "osascript", MacQuitArgs(prompt)...)
	// Escape or Cancel: osascript exits 1 ("User canceled").
	if err != nil { if ExitCode(err) == 1 { return QuitCancel, nil }; return QuitCancel, err }
	const marker = "button returned:"
	i := strings.Index(out, marker)
	if i < 0 { return QuitCancel, errors.New("unreadable dialog answer") }
	label := out[i+len(marker):]
	if j := strings.Index(label, ", gave up"); j >= 0 { label = label[:j] }
	choice, _ := choiceFor(prompt, label)
	return choice, nil
}

// --- Windows: a MessageBox has fixed Yes / No / Cancel buttons, so the text names what each does.

type WindowsQuitDialog struct{ Run Runner }

// WindowsQuitText maps the fixed button names to their meaning, because a script cannot rename them.
func WindowsQuitText(prompt QuitPrompt) (text, buttons string) {
	keep := prompt.KeepText
	if keep == "" { keep = "keep Faravan running" }
	if len(prompt.Buttons) == 3 {
		return prompt.Body + "\n\nYes: " + prompt.Buttons[0].Label + "\nNo: " + prompt.Buttons[1].Label + "\nCancel: " + keep, "YesNoCancel"
	}
	return prompt.Body + "\n\nYes: " + prompt.Buttons[0].Label + "\nNo: " + keep, "YesNo"
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func WindowsQuitScript(prompt QuitPrompt) string {
	text, buttons := WindowsQuitText(prompt)
	return "Add-Type -AssemblyName PresentationFramework\n[System.Windows.MessageBox]::Show(" + psQuote(text) + ", " + psQuote(prompt.Title) + ", '" + buttons + "', 'Question')"
}

func (d WindowsQuitDialog) Ask(ctx context.Context, prompt QuitPrompt) (QuitChoice, error) {
	out, err := d.Run(ctx, "powershell.exe", PowerShellArgs(WindowsQuitScript(prompt))...)
	if err != nil { return QuitCancel, err }
	switch strings.TrimSpace(out) {
	case "Yes": return prompt.Buttons[0].Choice, nil
	case "No":
		if len(prompt.Buttons) == 3 { return prompt.Buttons[1].Choice, nil }
	}
	return QuitCancel, nil
}

// --- Linux: zenity (GNOME and most others) or kdialog (KDE).

type ZenityQuitDialog struct{ Run Runner }

func ZenityQuitArgs(prompt QuitPrompt) []string {
	args := []string{"--question", "--title=" + prompt.Title, "--text=" + prompt.Body, "--icon-name=faravan", "--no-markup",
		"--ok-label=" + prompt.Buttons[0].Label, "--cancel-label=Cancel"}
	if len(prompt.Buttons) == 3 { args = append(args, "--extra-button="+prompt.Buttons[1].Label) }
	return args
}

func (d ZenityQuitDialog) Ask(ctx context.Context, prompt QuitPrompt) (QuitChoice, error) {
	out, err := d.Run(ctx, "zenity", ZenityQuitArgs(prompt)...)
	// An extra button prints its label and exits 1; OK exits 0 with no output; Cancel exits 1 with none.
	if choice, ok := choiceFor(prompt, out); ok && strings.TrimSpace(out) != "" { return choice, nil }
	if err == nil { return prompt.Buttons[0].Choice, nil }
	if ExitCode(err) == 1 || ExitCode(err) == 5 { return QuitCancel, nil }
	return QuitCancel, err
}

type KDialogQuitDialog struct{ Run Runner }

func KDialogQuitArgs(prompt QuitPrompt) []string {
	args := []string{"--title", prompt.Title, "--icon", "faravan"}
	if len(prompt.Buttons) == 3 {
		return append(args, "--yes-label", prompt.Buttons[0].Label, "--no-label", prompt.Buttons[1].Label, "--cancel-label", "Cancel", "--yesnocancel", prompt.Body)
	}
	return append(args, "--yes-label", prompt.Buttons[0].Label, "--no-label", "Cancel", "--yesno", prompt.Body)
}

func (d KDialogQuitDialog) Ask(ctx context.Context, prompt QuitPrompt) (QuitChoice, error) {
	_, err := d.Run(ctx, "kdialog", KDialogQuitArgs(prompt)...)
	switch {
	case err == nil: return prompt.Buttons[0].Choice, nil // yes
	case ExitCode(err) == 1 && len(prompt.Buttons) == 3: return prompt.Buttons[1].Choice, nil // no
	case ExitCode(err) == 1 || ExitCode(err) == 2: return QuitCancel, nil
	}
	return QuitCancel, err
}

// ErrJobStarted: a job runs (it began after the dialog was shown). The app refused to quit; lending is already off.
var ErrJobStarted = errors.New("a job started while the dialog was open")

// ErrJobChanged: the job the dialog named is no longer the one running, so nothing was stopped.
var ErrJobChanged = errors.New("the job changed while the dialog was open")

// ErrShutdownUnsupported: this app has no graceful shutdown, and the tray never ends it by force.
var ErrShutdownUnsupported = errors.New("this version of Faravan cannot be quit from the tray; quit it from its own window")

// ErrStillStopping: the app was asked to stop and has not exited yet. It is left running; nothing is killed.
var ErrStillStopping = errors.New("Faravan is still stopping; it was not forced to quit")

// QuitEnv is everything quitting touches, injected for tests.
type QuitEnv struct {
	Client AppClient
	Info AppInfo
	Alive func(pid int) bool // nil means ProcessAlive
	Sleep func(time.Duration) // nil means time.Sleep
	ExitTimeout time.Duration // zero means 90 s: a sandbox may take that long to stop
}

// Shutdown asks the app to stop itself (POST /api/shutdown). The app fences lending, refuses while a job it was
// not told about runs, stops the confirmed attempt, and then closes through its own cleanup. attempt is empty for a plain quit.
func (c AppClient) Shutdown(ctx context.Context, info AppInfo, attempt string) error {
	body := "{}"
	if attempt != "" {
		encoded, _ := json.Marshal(map[string]any{"attemptId": attempt, "confirmed": true})
		body = string(encoded)
	}
	response, err := c.requestBody(ctx, info, http.MethodPost, "/api/shutdown", body)
	if err == nil { response.Body.Close(); return nil }
	var problem *HTTPError
	if errors.As(err, &problem) {
		switch {
		case problem.Status == http.StatusNotFound && problem.Code == "not_found": return ErrShutdownUnsupported
		case problem.Code == "job_running": return ErrJobStarted
		case problem.Code == "job_changed": return ErrJobChanged
		case problem.Code == "cessation_unverified": return ErrStillStopping // the app stays open until the sandbox is proven gone
		}
	}
	return err
}

// WaitForExit waits for the process to end. It never signals or kills it: if the sandbox is still stopping, so is the app.
func WaitForExit(pid int, alive func(int) bool, sleep func(time.Duration), timeout time.Duration) bool {
	if alive == nil { alive = ProcessAlive }
	if sleep == nil { sleep = time.Sleep }
	if timeout <= 0 { timeout = 90 * time.Second }
	for waited := time.Duration(0); waited < timeout; waited += 250 * time.Millisecond {
		if !alive(pid) { return true }
		sleep(250 * time.Millisecond)
	}
	return !alive(pid)
}

// RunQuit carries out the answer. shown is the attempt the dialog named. A quit never touches a running job
// by itself: the app fences lending and inspects what runs in one step, and only the stop button, with the shown
// attempt, lets it stop that job. The app is never killed; it ends through its own cleanup.
func RunQuit(ctx context.Context, env QuitEnv, choice QuitChoice, shown string) (quit bool, err error) {
	switch choice {
	case QuitCancel:
		return false, nil
	case QuitPauseAfterJob:
		return false, env.Client.Lending(ctx, env.Info, "pause", "{}")
	}
	attempt := ""
	if choice == QuitStopJob {
		if shown == "" { return false, ErrJobChanged } // nothing was shown, so there is nothing to confirm
		attempt = shown
	}
	if err := env.Client.Shutdown(ctx, env.Info, attempt); err != nil { return false, err }
	if !WaitForExit(env.Info.PID, env.Alive, env.Sleep, env.ExitTimeout) { return false, ErrStillStopping }
	return true, nil
}

// QuitConfirmEntries is the fallback when no native dialog tool exists: the same prompt, drawn
// inside the tray menu itself (a disabled line with the text, then one line per button).
func QuitConfirmEntries(prompt QuitPrompt) []Entry {
	entries := []Entry{{ID: "note", Label: prompt.Title, Disabled: true}}
	// Menus do not wrap text, so split the body at sentence ends.
	for _, sentence := range strings.SplitAfter(prompt.Body, ". ") {
		if t := strings.TrimSpace(sentence); t != "" { entries = append(entries, Entry{ID: "note", Label: t, Disabled: true}) }
	}
	entries = append(entries, Entry{Separator: true})
	for _, b := range prompt.Buttons { entries = append(entries, Entry{ID: "confirm:" + prompt.Kind + ":" + string(b.Choice), Label: b.Label}) }
	return entries
}

// ParseQuitConfirm turns a menu entry ID from QuitConfirmEntries back into the prompt kind and choice.
func ParseQuitConfirm(id string) (kind string, choice QuitChoice, ok bool) {
	parts := strings.Split(id, ":")
	if len(parts) != 3 || parts[0] != "confirm" { return "", QuitCancel, false }
	return parts[1], QuitChoice(parts[2]), true
}

// StopJob stops the job the dialog named, by that attempt id, and no other. If the running job is a different one
// the app refuses (ErrJobChanged) and the caller asks again with the new job.
var ErrNoJobToStop = errors.New("no job is running")

func StopJob(ctx context.Context, client AppClient, info AppInfo, shown string) error {
	if shown == "" { return ErrNoJobToStop }
	body, _ := json.Marshal(map[string]any{"attemptId": shown, "confirmed": true})
	err := client.Lending(ctx, info, "stop", string(body))
	var problem *HTTPError
	if errors.As(err, &problem) && problem.Code == "no_current_job" { return ErrJobChanged }
	return err
}

func attemptID(status AppStatus) string {
	if status.Execution.Job != "" { return status.Execution.Job }
	var attempt string
	if json.Unmarshal(status.CurrentJob, &attempt) == nil { return attempt }
	return ""
}

// ErrAskLater: there is no dialog tool, so the question was drawn in the menu and the answer comes later.
var ErrAskLater = errors.New("the question is in the menu")

// ErrTooManyChanges: the job kept changing, so the flow stopped asking and did nothing.
var ErrTooManyChanges = errors.New("a job keeps changing; nothing was stopped")

// QuitNeedsQuestion: with lending off and nothing running there is nothing to ask. An off intent with a job still
// finishing is not that case, and neither is any state with a running job.
func QuitNeedsQuestion(status AppStatus) bool { return !(normalize(status).State == stateOff && !HasRunningJob(status)) }

// QuitFlow is the whole of Quit…: read, ask, act, and ask again (bounded) when the job it named changed or began.
type QuitFlow struct {
	Env QuitEnv
	Status func(ctx context.Context) (AppStatus, error)
	Ask func(prompt QuitPrompt) (QuitChoice, error)
	MaxRounds int // zero means 3
}

// RunConnectionQuit keeps the existing tray mapping: without an app, closing
// the icon is immediate. Its managed launcher observes that clean exit and
// stops the startup backoff. A live but unreachable app still uses the guarded
// status/confirmation/shutdown flow; a saved failure never bypasses it.
func RunConnectionQuit(ctx context.Context, connection Connection, flow QuitFlow) (bool, error) {
	if err := ctx.Err(); err != nil { return false, err }
	if connection.App == nil { return true, nil }
	flow.Env.Info = *connection.App
	return flow.Run(ctx)
}

func (f QuitFlow) Run(ctx context.Context) (bool, error) {
	rounds := f.MaxRounds
	if rounds == 0 { rounds = 3 }
	for round := 0; round < rounds; round++ {
		status, err := f.Status(ctx)
		if err != nil { return false, err }
		choice, shown := QuitNow, ""
		if QuitNeedsQuestion(status) {
			prompt := QuitPromptFor(status)
			if choice, err = f.Ask(prompt); err != nil { return false, err }
			shown = prompt.Attempt
		}
		quit, err := RunQuit(ctx, f.Env, choice, shown)
		if errors.Is(err, ErrJobStarted) || errors.Is(err, ErrJobChanged) { continue }
		return quit, err
	}
	return false, ErrTooManyChanges
}

// StopFlow is "Stop Sam’s job…": ask about the job running now, stop exactly that attempt, ask again (bounded) if it changed.
type StopFlow struct {
	Client AppClient
	Info AppInfo
	Status func(ctx context.Context) (AppStatus, error)
	Ask func(prompt QuitPrompt) (QuitChoice, error)
	MaxRounds int
}

func (f StopFlow) Run(ctx context.Context) error {
	rounds := f.MaxRounds
	if rounds == 0 { rounds = 3 }
	for round := 0; round < rounds; round++ {
		status, err := f.Status(ctx)
		if err != nil { return err }
		if !HasRunningJob(status) { return nil } // it finished while the menu was open
		prompt := StopJobPrompt(status)
		choice, err := f.Ask(prompt)
		if err != nil || choice != QuitStopJob { return err }
		err = StopJob(ctx, f.Client, f.Info, prompt.Attempt)
		if errors.Is(err, ErrJobChanged) { continue }
		return err
	}
	return ErrTooManyChanges
}

// TrayLifetime owns tray work, never the deliberately detached application.
// Its zero value is ready to use.
type TrayLifetime struct {
	once sync.Once
	ctx context.Context
	cancel context.CancelFunc
	mu sync.Mutex
	stopping bool
	workers sync.WaitGroup
	stopOnce sync.Once
	done chan struct{}
	// OnPanic records a tray worker failure before the same panic continues.
	OnPanic func()
}

// RethrowAfter records a panic with record, then lets the same panic continue, so the crash is unchanged. Defer it
// directly: recover only works in the deferred call itself.
func RethrowAfter(record func()) {
	if r := recover(); r != nil {
		recordSafely(record)
		panic(r)
	}
}

// recordSafely runs record. A panic inside it is dropped, so it cannot replace the panic that is being re-raised.
func recordSafely(record func()) {
	if record == nil {
		return
	}
	defer func() { _ = recover() }()
	record()
}

func (l *TrayLifetime) Context() context.Context {
	l.once.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		l.ctx, l.cancel = context.WithValue(ctx, trayLifetimeKey{}, ctx), cancel
		l.done = make(chan struct{})
	})
	return l.ctx
}

// Go registers work before launching it; no work is admitted after shutdown.
func (l *TrayLifetime) Go(work func(context.Context)) bool {
	ctx := l.Context()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.stopping { return false }
	l.workers.Add(1)
	go func() { defer l.workers.Done(); defer RethrowAfter(l.OnPanic); work(ctx) }()
	return true
}

// Shutdown waits at most timeout for tray-owned work.
func (l *TrayLifetime) Shutdown(timeout time.Duration) bool {
	l.Context()
	l.stopOnce.Do(func() {
		l.mu.Lock()
		l.stopping = true
		l.mu.Unlock()
		l.cancel()
		go func() { l.workers.Wait(); close(l.done) }()
	})
	if timeout <= 0 { timeout = 2 * time.Second }
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-l.done: return true
	case <-timer.C: return false
	}
}

// A request can disappear before the notification daemon returns its id. Keep
// that exchange alive long enough to close the notification, but never beyond
// the lifetime of the tray itself.
type trayLifetimeKey struct{}

func notificationLifetime(ctx context.Context) context.Context {
	if lifetime, ok := ctx.Value(trayLifetimeKey{}).(context.Context); ok { return lifetime }
	return context.WithoutCancel(ctx)
}

// RunHelperCommand is only for tray-owned helpers, never the detached app.
// prepare installs platform process-group cancellation and returns its cleanup.
// WaitDelay also bounds inherited output pipes when a helper starts children.
func RunHelperCommand(ctx context.Context, prepare func(*exec.Cmd) func(), name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 250 * time.Millisecond
	if prepare != nil {
		if cleanup := prepare(cmd); cleanup != nil { defer cleanup() }
	}
	out, err := cmd.Output()
	return string(out), err
}
