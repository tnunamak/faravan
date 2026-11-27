package faravantray

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// Every notifier test uses a fake Runner: no test shows a real notification.
type call struct { name string; args []string }

func fakeRunner(out string, err error, calls *[]call) Runner {
	return func(_ context.Context, name string, args ...string) (string, error) {
		*calls = append(*calls, call{name, args})
		return out, err
	}
}

func TestNotificationTextNamesPeopleAndCountsOnly(t *testing.T) {
	card := ApprovalCard{ID: "a1", LocalName: "Sam", RequesterName: "Sam's laptop", Harness: "claude", RuntimeSeconds: 1140}
	card.Job.Circle = "c1"
	got := NotificationForCard(card, map[string]string{"c1": "Weekend projects"})
	if got.Title != "Sam asked for help" || got.Body != "Weekend projects · up to 19 min of Claude Code" { t.Fatalf("%#v", got) }
	card.RuntimeSeconds = 1200
	if b := NotificationForCard(card, map[string]string{"c1": "Weekend projects"}).Body; b != "Weekend projects · up to 20 min of Claude Code" { t.Fatal(b) }
	bare := NotificationForCard(ApprovalCard{ID: "a2"}, nil)
	if bare.Title != "A circle member asked for help" || bare.Body != "Your circle" { t.Fatalf("%#v", bare) }
	fallback := NotificationForCard(ApprovalCard{ID: "a3", RequesterName: "Maya's laptop", Harness: "other", RuntimeSeconds: 60}, nil)
	if fallback.Title != "Maya's laptop asked for help" || fallback.Body != "Your circle · up to 1 min" { t.Fatalf("%#v", fallback) }
}

func TestNotificationNeverShowsUnknownAgentCodes(t *testing.T) {
	for _, agent:=range []string{"sha256:agent", "unknown_adapter_v9", "harness", "codex"} {
		card:=ApprovalCard{ID:"a1",LocalName:"Sam",Harness:agent,RuntimeSeconds:1200}
		card.Job.Circle="c1"
		note:=NotificationForCard(card,map[string]string{"c1":"Weekend projects"})
		if note.Title!="Sam asked for help" || !strings.Contains(note.Body,"Weekend projects · up to 20 min") {t.Fatal(note)}
		if agent=="codex" {if !strings.Contains(note.Body,"Codex") {t.Fatal(note)} } else if strings.Contains(note.Body,agent) {t.Fatal("raw code leaked",note)}
	}
}

func TestNotificationKeepsTheAgentWhenTheTimeLimitIsUnknown(t *testing.T) {
	for _,agent:=range []string{"claude-code-subscription","claude-code-api-key"} {
		note:=NotificationForCard(ApprovalCard{Harness:agent},nil)
		if note.Body!="Your circle · "+agentNames[agent] {t.Fatal(note)}
	}
	if got:=DBusActions(); !reflect.DeepEqual(got,[]string{"review","Review"}) {t.Fatal(got)}
}


func TestLinuxNotifySend(t *testing.T) {
	note := Notification{ID: "a1", Title: "Sam asked for help", Body: "Weekend projects · up to 20 min"}
	want := []string{"--app-name=Faravan", "--icon=faravan", "--hint=string:desktop-entry:faravan",
		"--action=review=Review", "--wait", note.Title, note.Body}
	if got := NotifySendArgs(note, Branding{}); !reflect.DeepEqual(got, want) { t.Fatalf("%v", got) }
	for out, action := range map[string]Action{"review\n": ActionReview, "decline\n": ActionNone, "": ActionNone, "default\n": ActionNone, "rm -rf\n": ActionNone} {
		var calls []call
		got, err := NotifySend{Run: fakeRunner(out, nil, &calls)}.Notify(context.Background(), note)
		if err != nil || got != action || calls[0].name != "notify-send" { t.Fatalf("%q: %v %v", out, got, err) }
	}
	boom := errors.New("no dbus")
	if _, err := (NotifySend{Run: fakeRunner("", boom, new([]call))}).Notify(context.Background(), note); !errors.Is(err, boom) { t.Fatal("error passes through") }
}

func TestMacHelperAndFallback(t *testing.T) {
	note := Notification{ID: "a1", Title: `Sam "the man" asked`, Body: "line\none \\ end"}
	var calls []call
	got, err := MacNotifier{Run: fakeRunner("review\n", nil, &calls), Helper: "/Applications/Faravan.app/Contents/MacOS/faravan-notify"}.Notify(context.Background(), note)
	if err != nil || got != ActionReview { t.Fatalf("%v %v", got, err) }
	if want := []string{"--id", "a1", "--title", note.Title, "--body", note.Body, "--review", "Review"}; !reflect.DeepEqual(calls[0].args, want) { t.Fatalf("%v", calls[0].args) }
	calls = nil
	got, err = MacNotifier{Run: fakeRunner("", nil, &calls)}.Notify(context.Background(), note)
	if err != nil || got != ActionNone || calls[0].name != "osascript" { t.Fatalf("fallback: %v %v %v", got, err, calls) }
	script := calls[0].args[1]
	if want := `display notification "line one \\ end" with title "Sam \"the man\" asked"`; script != want { t.Fatalf("quoting: %s", script) }
}

func TestWindowsToast(t *testing.T) {
	note := Notification{ID: "a1", Title: `Sam <b>&'</b>`, Body: "Weekend projects"}
	xml := ToastXML(note)
	if strings.Contains(xml, "<b>") || !strings.Contains(xml, "Sam &lt;b&gt;&amp;&#39;&lt;/b&gt;") { t.Fatalf("title is not escaped: %s", xml) }
	for _, want := range []string{`content="Review" arguments="review"`} {
		if !strings.Contains(xml, want) { t.Fatalf("missing %s", want) }
	}
	if strings.Contains(xml, `arguments="decline"`) {t.Fatal("notification has an extra action")}
 script := ToastScript(note)
	if !strings.Contains(script, "CreateToastNotifier('"+AUMID+"')") { t.Fatal("toast must use the app identity") }
	if strings.Contains(xml, "'") { t.Fatal("the XML holds no raw single quote, so it cannot end the PowerShell string") }
	args := PowerShellArgs(script)
	raw, err := base64.StdEncoding.DecodeString(args[len(args)-1])
	if err != nil || len(raw)%2 != 0 { t.Fatal("encoded command is UTF-16LE base64") }
	units := make([]uint16, len(raw)/2)
	for i := range units { units[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8 }
	if string(utf16.Decode(units)) != script { t.Fatal("script does not round-trip") }
	var calls []call
	got, err := ToastNotifier{Run: fakeRunner("review\r\n", nil, &calls)}.Notify(context.Background(), note)
	if err != nil || got != ActionReview || calls[0].name != "powershell.exe" { t.Fatalf("%v %v", got, err) }
	reg := ToastRegistration(`C:\Faravan\faravan-tray.exe`)
	if len(reg) != 2 || !strings.Contains(reg[0][1], `HKCU\Software\Classes\AppUserModelId\`+AUMID) { t.Fatalf("%v", reg) }
	if len(ToastRegistration("")) != 1 { t.Fatal("no icon, no IconUri") }
}

func TestNotifierSelectionPerOS(t *testing.T) {
	run := fakeRunner("", nil, new([]call))
	only := func(names ...string) func(string) bool { return func(n string) bool { for _, x := range names { if x == n { return true } }; return false } }
	cases := []struct { goos string; have func(string) bool; helper string; want any }{
		{"linux", only("session-bus", "notify-send"), "", DBusNotifier{}}, {"linux", only("notify-send"), "", NotifySend{}}, {"linux", only(), "", nil},
		{"darwin", only(), "/x/faravan-notify", MacNotifier{}}, {"darwin", only("osascript"), "", MacNotifier{}}, {"darwin", only(), "", nil},
		{"windows", only("powershell.exe"), "", ToastNotifier{}}, {"windows", only(), "", nil}, {"plan9", only("notify-send"), "", nil},
	}
	for _, c := range cases {
		got, err := NewNotifier(c.goos, run, c.have, c.helper, Branding{})
		if c.want == nil { if !errors.Is(err, ErrNoNotifier) { t.Fatalf("%s: %v", c.goos, err) }; continue }
		if err != nil || reflect.TypeOf(got) != reflect.TypeOf(c.want) { t.Fatalf("%s: %T %v", c.goos, got, err) }
	}
	if m := func() Notifier { n, _ := NewNotifier("darwin", run, only("osascript"), "", Branding{}); return n }().(MacNotifier); m.Helper != "" { t.Fatal("no helper means the osascript fallback") }
}

func TestReviewAndNotNowNeverStartAJob(t *testing.T) {
	var paths []string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Header.Get("X-Faravan-Session-Token") != "app token&secret" { t.Error("session token missing") }
		if r.URL.Path == "/api/handoff" { return `{"url":"http://127.0.0.1:4000/auth/handoff?code=once"}` }
		return `{}`
	})}
	info := AppInfo{Port: 4000, Token: "app token&secret"}
	var opened []string
	open := func(u string) error { opened = append(opened, u); return nil }
	if err := HandleAction(context.Background(), client, info, "a 1", ActionReview, open); err != nil { t.Fatal(err) }
	if want := []string{"http://127.0.0.1:4000/auth/handoff?code=once#/request/a%201"}; !reflect.DeepEqual(opened, want) { t.Fatalf("%v", opened) }
	if err := HandleAction(context.Background(), client, info, "a 1", ActionDecline, open); err != nil { t.Fatal(err) }
	if err := HandleAction(context.Background(), client, info, "a 1", ActionNone, open); err != nil { t.Fatal(err) }
	if want := []string{"POST /api/handoff", "POST /api/approvals/a 1/skip"}; !reflect.DeepEqual(paths, want) { t.Fatalf("%v", paths) }
	for _, p := range paths { if strings.Contains(p, "accept") { t.Fatal("a notification action must never accept") } }
	if len(opened) != 1 || strings.Contains(opened[0], "token=") { t.Fatal("the link carries no session token") }
}

func TestLinuxTrayDetection(t *testing.T) {
	owner := func(owned bool, err error) func(string) (bool, error) {
		return func(name string) (bool, error) {
			if name != "org.kde.StatusNotifierWatcher" { t.Fatalf("asked about %s", name) }
			return owned, err
		}
	}
	if !LinuxTrayAvailable(owner(true, nil)) { t.Fatal("a watcher owner means a tray") }
	if LinuxTrayAvailable(owner(false, nil)) { t.Fatal("no owner means no tray") }
	if LinuxTrayAvailable(owner(false, errors.New("no session bus"))) { t.Fatal("no bus means no tray") }
	if LinuxTrayAvailable(owner(true, errors.New("bus error"))) { t.Fatal("an error never claims a tray") }
}

func TestTrayReportIsSentOncePerStateAndAppStart(t *testing.T) {
	var r TrayReporter
	a, b := AppInfo{StartedAt: "t1"}, AppInfo{StartedAt: "t2"}
	if v, due := r.Due(a, false); !due || v { t.Fatal("first report") }
	r.Done(a, false)
	if _, due := r.Due(a, false); due { t.Fatal("same state, same app start: nothing to send") }
	if v, due := r.Due(a, true); !due || !v { t.Fatal("a tray that appeared is reported") }
	r.Done(a, true)
	if _, due := r.Due(b, true); !due { t.Fatal("a restarted app asks again") }
}

func TestReportTrayPostsTheState(t *testing.T) {
	var got []string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		b, _ := io.ReadAll(r.Body)
		got = append(got, r.Method+" "+r.URL.Path+" "+string(b))
		return `{}`
	})}
	if err := client.ReportTray(context.Background(), AppInfo{Port: 1, Token: "t"}, false); err != nil { t.Fatal(err) }
	if want := []string{`POST /api/desktop/tray {"tray":false}`}; !reflect.DeepEqual(got, want) { t.Fatalf("%v", got) }
}

func TestEffectiveStateDrivesTheGlyphAndHeadline(t *testing.T) {
	loc := time.FixedZone("test", -7*3600)
	now := time.Date(2026, 10, 19, 14, 41, 0, 0, loc)
	at := func(h, m int) *float64 { v := float64(time.Date(2026, 10, 19, h, m, 0, 0, loc).UnixMilli()); return &v }
	need := []NeedsYou{{Kind: "approval", ApprovalID: "a1"}}
	tests := []struct { name string; status AppStatus; visual VisualState; headline string }{
		{"off", AppStatus{State: "off"}, VisualIdle, "Lending is off"},
		{"paused with end", AppStatus{State: "paused", Reason: "paused", Until: at(15, 0)}, VisualPaused, "Paused until 3:00 PM"},
		{"paused open ended", AppStatus{State: "paused"}, VisualPaused, "Paused"},
		{"blocked safety", AppStatus{State: "blocked", Reason: "safety_check_failed"}, VisualError, "Status unavailable"},
		{"blocked other", AppStatus{State: "blocked", Reason: "something_new"}, VisualError, "Status unavailable"},
		{"update", AppStatus{State: "update"}, VisualError, "Update Faravan to keep lending"},
		{"running, older app", AppStatus{State: "running"}, VisualActive, "Running a job"},
		{"running, blank name", AppStatus{State: "running", RunningJob: &runningJob{Requester: "  "}}, VisualActive, "Running a job"},
		{"running with name", AppStatus{State: "running", RunningJob: &runningJob{Requester: "Sam"}}, VisualActive, "Running Sam’s job"},
		{"running with name and title", AppStatus{State: "running", RunningJob: &runningJob{Requester: "Sam", Title: "Fix parser"}}, VisualActive, "Running Sam’s job"},
		{"outside hours", AppStatus{State: "outside", Until: at(22, 0)}, VisualActive, "Lending starts at 10:00 PM"},
		{"resting daily limit", AppStatus{State: "resting", Reason: "daily_limit"}, VisualActive, "Resting"},
		{"resting with end", AppStatus{State: "resting", Reason: "quota_reserve", Until: at(18, 0)}, VisualActive, "Resting until 6:00 PM"},
		// The app lists the quota reserve as an attention item but keeps iconState "Paused": an expected rest, not a dot.
		{"resting on pace with its attention item", AppStatus{State: "resting", Reason: "quota_reserve", Until: at(18, 0), IconState: "Paused", Attention: []struct{ Label string `json:"label"` }{{"Keeping your reserve"}}}, VisualActive, "Resting until 6:00 PM"},
		{"ready", AppStatus{State: "ready"}, VisualActive, "Lending is on"},
		{"starting", AppStatus{State: "starting"}, VisualActive, "Checking this computer…"},
		{"ready but a request waits", AppStatus{State: "ready", NeedsYou: need}, VisualAttention, "Lending is on"},
		{"off with a request", AppStatus{State: "off", NeedsYou: need}, VisualAttention, "Lending is off"},
		{"unknown state", AppStatus{State: "from-the-future"}, VisualError, "Status unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := VisualForEffective(test.status.State, len(test.status.NeedsYou)); got != test.visual { t.Fatalf("glyph %v", got) }
			if got := Headline(test.status, now, loc); got != test.headline { t.Fatalf("headline %q", got) }
			if got := BuildMenu(MenuInput{Status: test.status, Now: now, Loc: loc, GOOS: "darwin"}).State; got != test.visual { t.Fatalf("menu glyph %v", got) }
		})
	}
}

func TestStatusJSONCarriesTheEffectiveState(t *testing.T) {
	var s AppStatus
	payload := `{"state":"paused","reason":"paused","until":1792433400000,"needs_you":[{"kind":"approval","approvalId":"a1"},{"kind":"agent_signed_out","agent":"claude"}],"iconState":"Paused"}`
	if err := json.Unmarshal([]byte(payload), &s); err != nil { t.Fatal(err) }
	if s.State != "paused" || s.Until == nil || len(s.NeedsYou) != 2 || s.NeedsYou[0].ApprovalID != "a1" || s.NeedsYou[1].Agent != "claude" { t.Fatalf("%#v", s) }
	m := BuildMenu(MenuInput{Status: s})
	if m.State != VisualAttention { t.Fatal("a pending request shows the needs-you glyph even while paused") }
	old := BuildMenu(MenuInput{Status: AppStatus{IconState: "Lending on"}, GOOS: "darwin"})
	if old.State != VisualActive || old.Status != "Lending is on" { t.Fatalf("an older app still works: %#v", old) }
}

type runningJob = struct {
	Requester string `json:"requester"`
	Title string `json:"title"`
}

func TestRunningJobFieldIsOptionalOnTheWire(t *testing.T) {
	var with, without AppStatus
	if err := json.Unmarshal([]byte(`{"state":"running","runningJob":{"requester":"Sam"}}`), &with); err != nil { t.Fatal(err) }
	if err := json.Unmarshal([]byte(`{"state":"running","runningJob":null}`), &without); err != nil { t.Fatal(err) }
	if Headline(with, time.Now(), time.UTC) != "Running Sam’s job" || Headline(without, time.Now(), time.UTC) != "Running a job" { t.Fatal("wire") }
}
