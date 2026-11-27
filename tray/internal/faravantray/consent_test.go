package faravantray

import (
	"context"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeApp is a stateful stand-in for the local app: it records calls and answers each route from a table.
type fakeApp struct {
	t *testing.T
	calls []string
	status string
	answers map[string]answer // key: "POST /api/shutdown"
	alive bool
}

type answer struct { code int; body string }
func reply(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
func (f *fakeApp) client() AppClient {
	return AppClient{HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		f.calls = append(f.calls, r.Method+" "+r.URL.Path+" "+strings.TrimSpace(string(body)))
		if r.URL.Path == "/api/home" { return reply(200, f.status), nil }
		if a, ok := f.answers[r.Method+" "+r.URL.Path]; ok { return reply(a.code, a.body), nil }
		return reply(200, `{}`), nil
	})}}
}
func (f *fakeApp) env(exitsAfter int) QuitEnv {
	polls := 0
	return QuitEnv{Client: f.client(), Info: AppInfo{Port: 1, Token: "t", PID: 4242}, Sleep: func(time.Duration) {}, ExitTimeout: time.Second,
		Alive: func(int) bool { polls++; return polls <= exitsAfter }}
}
func (f *fakeApp) statusFn() func(context.Context) (AppStatus, error) {
	return func(ctx context.Context) (AppStatus, error) { return f.client().Status(ctx, AppInfo{Port: 1, Token: "t"}) }
}

const idle = `{"state":"ready","execution":{"state":"idle"}}`
const runningA = `{"state":"ready","execution":{"state":"running","job":"attempt-A","person":"Sam"}}`

func TestPauseAfterThisJobKeepsTheAppAndJobRunning(t *testing.T) {
	f := &fakeApp{t:t, status:runningA, alive:true}
	env := f.env(1<<30)
	env.Alive = func(int) bool { t.Fatal("pausing must never wait for the app to exit"); return true }
	quit, err := RunQuit(context.Background(), env, QuitPauseAfterJob, "attempt-A")
	if err != nil || quit { t.Fatalf("pause closed the app: quit=%v err=%v", quit, err) }
	if !reflect.DeepEqual(f.calls, []string{"POST /api/lending/pause {}"}) {t.Fatal(f.calls)}
	var status AppStatus
	status, err = f.client().Status(context.Background(), env.Info)
	if err != nil || status.Execution.State != "running" || status.Execution.Job != "attempt-A" {t.Fatalf("job interrupted: %#v %v",status,err)}
}

func TestQuitCopyUsesIntentAndExecutionFacts(t *testing.T) {
	for _, state:=range []string{"blocked","update"} {
		if strings.Contains(QuitPromptFor(AppStatus{State:state}).Body,"already off") {t.Fatal("blocker was presented as an off intent")}
	}
	for _,phase:=range []string{"finishing","stopping"} {
		s:=AppStatus{State:"off"};s.Execution.State=phase
		p:=QuitPromptFor(s)
		if strings.Contains(p.Body,"is running.") || !strings.Contains(p.Body,"keeps Faravan running") {t.Fatal(p.Body)}
	}
}

// P0: Stop and quit used to send stop/off and then kill the process without waiting for the job to stop.
func TestQuitAsksTheAppToShutDownAndNeverKills(t *testing.T) {
	f := &fakeApp{t: t, status: idle}
	quit, err := RunQuit(context.Background(), f.env(3), QuitNow, "")
	if err != nil || !quit { t.Fatalf("%v %v", quit, err) }
	if !reflect.DeepEqual(f.calls, []string{"POST /api/shutdown {}"}) { t.Fatalf("%q", f.calls) }
	// The app is slow to stop its sandbox: the tray waits, times out, reports it, and leaves the app alone.
	f = &fakeApp{t: t, status: runningA}
	quit, err = RunQuit(context.Background(), f.env(1<<30), QuitStopJob, "attempt-A")
	if !errors.Is(err, ErrStillStopping) || quit { t.Fatalf("a still-running app must not count as quit: %v %v", quit, err) }
	want := []string{`POST /api/shutdown {"attemptId":"attempt-A","confirmed":true}`}
	if !reflect.DeepEqual(f.calls, want) { t.Fatalf("only the shutdown request, nothing forced: %q", f.calls) }
}

// P1: the idle read, then a job starts, then "off" let it finish and the app was stopped under it.
func TestPlainQuitLeavesTheFenceAndInspectionToTheApp(t *testing.T) {
	f := &fakeApp{t: t, status: idle, answers: map[string]answer{"POST /api/shutdown": {409, `{"code":"job_running"}`}}}
	quit, err := RunQuit(context.Background(), f.env(0), QuitNow, "")
	if !errors.Is(err, ErrJobStarted) || quit { t.Fatalf("%v %v", quit, err) }
	for _, c := range f.calls { if strings.Contains(c, "/off") || strings.Contains(c, "/stop") { t.Fatalf("the tray acted on its own read: %s", c) } }
	if len(f.calls) != 1 { t.Fatalf("one request, decided by the app: %q", f.calls) }
}

// P1: the dialog showed attempt A; the stop must be for A, and refuse if B runs now.
func TestStopIsBoundToTheAttemptShown(t *testing.T) {
	f := &fakeApp{t: t, status: `{"state":"ready","execution":{"state":"running","job":"attempt-B","person":"Maya"}}`,
		answers: map[string]answer{"POST /api/lending/stop": {409, `{"code":"no_current_job"}`}}}
	err := StopJob(context.Background(), f.client(), AppInfo{Port: 1, Token: "t"}, "attempt-A")
	if !errors.Is(err, ErrJobChanged) { t.Fatalf("%v", err) }
	if !reflect.DeepEqual(f.calls, []string{`POST /api/lending/stop {"attemptId":"attempt-A","confirmed":true}`}) { t.Fatalf("it must send A, not re-read and send B: %q", f.calls) }
	if err := StopJob(context.Background(), f.client(), AppInfo{}, ""); !errors.Is(err, ErrNoJobToStop) { t.Fatal("nothing shown, nothing to stop") }
	g := &fakeApp{t: t, status: runningA, answers: map[string]answer{"POST /api/shutdown": {409, `{"code":"job_changed"}`}}}
	if _, err := RunQuit(context.Background(), g.env(0), QuitStopJob, "attempt-Z"); !errors.Is(err, ErrJobChanged) { t.Fatalf("%v", err) }
	if _, err := RunQuit(context.Background(), (&fakeApp{status: idle}).env(0), QuitStopJob, ""); !errors.Is(err, ErrJobChanged) { t.Fatal("a stop with nothing shown refuses without a call") }
}

func TestQuitPromptAndStopPromptCarryTheirAttempt(t *testing.T) {
	var s AppStatus
	s.Execution.State, s.Execution.Job = "running", "attempt-A"
	if QuitPromptFor(s).Attempt != "attempt-A" || StopJobPrompt(s).Attempt != "attempt-A" { t.Fatal("the shown attempt is kept") }
}

// P1: an off intent with a finishing job skipped the dialog, then looped on ErrJobStarted.
func TestOffIntentWithAFinishingJobStillAsks(t *testing.T) {
	finishing := AppStatus{State: "off"}
	finishing.Execution.State = "finishing"
	if !QuitNeedsQuestion(finishing) { t.Fatal("a job still finishes: ask") }
	if QuitNeedsQuestion(AppStatus{State: "off"}) { t.Fatal("off and idle: nothing to ask") }
	if !QuitNeedsQuestion(AppStatus{State: "ready"}) { t.Fatal("lending on: ask") }
}

func TestQuitFlowAsksAgainButStopsLooping(t *testing.T) {
	// The job keeps changing under the dialog: three questions, then it gives up and does nothing.
	f := &fakeApp{status: runningA, answers: map[string]answer{"POST /api/shutdown": {409, `{"code":"job_changed"}`}}}
	asked := 0
	flow := QuitFlow{Env: f.env(0), Status: f.statusFn(), Ask: func(p QuitPrompt) (QuitChoice, error) { asked++; return QuitStopJob, nil }}
	quit, err := flow.Run(context.Background())
	if !errors.Is(err, ErrTooManyChanges) || quit || asked != 3 { t.Fatalf("%v %v asked %d", quit, err, asked) }
	// A job that began after an idle read: asks about the new job, once, then quits when told to stop it.
	g := &fakeApp{status: runningA}
	answers := []QuitChoice{QuitStopJob}
	flow = QuitFlow{Env: g.env(2), Status: g.statusFn(), Ask: func(p QuitPrompt) (QuitChoice, error) {
		if p.Attempt != "attempt-A" || !strings.Contains(p.Body, "Sam") { t.Errorf("prompt %#v", p) }
		c := answers[0]; return c, nil }}
	if quit, err := flow.Run(context.Background()); err != nil || !quit { t.Fatalf("%v %v", quit, err) }
	// Cancel does nothing at all.
	h := &fakeApp{status: runningA}
	flow = QuitFlow{Env: h.env(0), Status: h.statusFn(), Ask: func(QuitPrompt) (QuitChoice, error) { return QuitCancel, nil }}
	if quit, err := flow.Run(context.Background()); err != nil || quit || len(h.calls) != 1 { t.Fatalf("%v %v %q", quit, err, h.calls) }
	// Off with a finishing job is asked, not shortcut.
	fin := &fakeApp{status: `{"state":"off","execution":{"state":"finishing","job":"attempt-F","person":"Sam"}}`}
	asked = 0
	flow = QuitFlow{Env: fin.env(0), Status: fin.statusFn(), Ask: func(QuitPrompt) (QuitChoice, error) { asked++; return QuitCancel, nil }}
	_, _ = flow.Run(context.Background())
	if asked != 1 { t.Fatal("the dialog must show for an off intent with a finishing job") }
}

func TestStopFlowAsksAgainAboutANewJobAndIsBounded(t *testing.T) {
	f := &fakeApp{status: runningA, answers: map[string]answer{"POST /api/lending/stop": {409, `{"code":"no_current_job"}`}}}
	asked := 0
	flow := StopFlow{Client: f.client(), Info: AppInfo{Port: 1, Token: "t"}, Status: f.statusFn(), Ask: func(p QuitPrompt) (QuitChoice, error) { asked++; return QuitStopJob, nil }}
	if err := flow.Run(context.Background()); !errors.Is(err, ErrTooManyChanges) || asked != 3 { t.Fatalf("%v asked %d", err, asked) }
	idleApp := &fakeApp{status: idle}
	flow = StopFlow{Client: idleApp.client(), Status: idleApp.statusFn(), Ask: func(QuitPrompt) (QuitChoice, error) { t.Fatal("no job, no question"); return QuitCancel, nil }}
	if err := flow.Run(context.Background()); err != nil { t.Fatal(err) }
}

func TestShutdownWithAnOldAppIsRefusedNotForced(t *testing.T) {
	f := &fakeApp{status: idle, answers: map[string]answer{"POST /api/shutdown": {404, `{"code":"not_found"}`}}}
	if _, err := RunQuit(context.Background(), f.env(0), QuitNow, ""); !errors.Is(err, ErrShutdownUnsupported) { t.Fatalf("%v", err) }
}

// P1: a failed approvals read used to look like an empty list and announce every request again.
func TestAFailedReadIsNotAnEmptyList(t *testing.T) {
	var tr RequestTracker
	a, b := ApprovalCard{ID: "a"}, ApprovalCard{ID: "b"}
	if fresh, _ := tr.Update([]ApprovalCard{a, b}, true); len(fresh) != 2 { t.Fatal("first read announces both") }
	if fresh, gone := tr.Update(nil, false); len(fresh) != 0 || len(gone) != 0 { t.Fatal("a failed read changes nothing") }
	if fresh, gone := tr.Update([]ApprovalCard{a, b}, true); len(fresh) != 0 || len(gone) != 0 { t.Fatalf("no duplicate announcements after a failed read: %v %v", fresh, gone) }
	fresh, gone := tr.Update([]ApprovalCard{b, {ID: "c"}}, true)
	if len(fresh) != 1 || fresh[0].ID != "c" || len(gone) != 1 || gone[0].ID != "a" { t.Fatalf("a new one and a gone one: %v %v", fresh, gone) }
	if _, gone := tr.Update([]ApprovalCard{}, true); len(gone) != 2 { t.Fatal("an empty good read really does mean nobody waits") }
}

func TestDiscoveryTellsAFailedApprovalsReadFromAnEmptyOne(t *testing.T) {
	dir := t.TempDir()
	c := LocalClient{AppPath: dir + "/v1/app.json", Alive: func(int) bool { return true }}
	writeRecord(t, c.AppPath, appRecord(1234))
	c.AppClient.HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/approvals" { return reply(500, `{}`), nil }
		return reply(200, `{"state":"ready"}`), nil
	})}
	if conn := c.Discover(context.Background()); conn.CardsKnown { t.Fatal("a 500 is unknown") }
	c.AppClient.HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/approvals" { return reply(200, `[]`), nil }
		return reply(200, `{"state":"ready"}`), nil
	})}
	if conn := c.Discover(context.Background()); !conn.CardsKnown || len(conn.Cards) != 0 { t.Fatal("an empty list is known") }
}

// P1: Review and the menu used routes the web app does not have. Not now on a request already gone said nothing.
func TestReviewGoesToARouteTheAppHas(t *testing.T) {
	if ReviewRoute != "#/request/" { t.Fatal(ReviewRoute) }
	for name, route := range routes {
		if strings.HasPrefix(route, "#/requests") || route == "#/lending" || route == "#/you/account" { t.Errorf("%s uses a route the app rejects: %s", name, route) }
	}
	var opened []string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string { return `{"url":"http://127.0.0.1:1/auth/handoff?code=x"}` })}
	if err := HandleAction(context.Background(), client, AppInfo{Port: 1, Token: "t"}, "a1", ActionReview, func(u string) error { opened = append(opened, u); return nil }); err != nil { t.Fatal(err) }
	if len(opened) != 1 || !strings.HasSuffix(opened[0], "#/request/a1") { t.Fatalf("%v", opened) }
}

func TestNotNowOnAGoneRequestIsReportedNotSwallowed(t *testing.T) {
	client := AppClient{HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) { return reply(404, `{"code":"not_found"}`), nil })}}
	err := HandleAction(context.Background(), client, AppInfo{Port: 1, Token: "t"}, "gone", ActionDecline, func(string) error { return nil })
	if !errors.Is(err, ErrRequestGone) { t.Fatalf("%v", err) }
}

// Review 3 P1: when the app cannot prove the sandbox is gone it refuses to close; the tray must report "still stopping", not a failure
// or a quit, and must never force the app.
func TestQuitWhenTheAppCannotProveTheSandboxStoppedIsStillStopping(t *testing.T) {
	f := &fakeApp{t: t, status: runningA, answers: map[string]answer{"POST /api/shutdown": {409, `{"code":"cessation_unverified"}`}}}
	quit, err := RunQuit(context.Background(), f.env(1<<30), QuitStopJob, "attempt-A")
	if !errors.Is(err, ErrStillStopping) || quit { t.Fatalf("%v %v", quit, err) }
	if len(f.calls) != 1 { t.Fatalf("the app decides; nothing is forced: %q", f.calls) }
}
