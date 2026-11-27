package faravantray

import (
	"encoding/json"
	"bytes"
	"image"
 "image/color"
 "github.com/tnunamak/faravan/tray/internal/brandmark"
	"math"
	"image/png"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

var (
	menuLoc = time.FixedZone("test", -7*3600)
	menuNow = time.Date(2026, 10, 19, 14, 41, 0, 0, menuLoc)
)

func sam() ApprovalCard {
	c := ApprovalCard{ID: "a1", LocalName: "Sam"}
	c.Job.Circle = "c1"
	return c
}
func today() *struct{ Jobs int `json:"jobs"`; JobLimit int `json:"jobLimit"`; Minutes int `json:"minutes"`; MinuteLimit int `json:"minuteLimit"` } {
	return &struct{ Jobs int `json:"jobs"`; JobLimit int `json:"jobLimit"`; Minutes int `json:"minutes"`; MinuteLimit int `json:"minuteLimit"` }{2, 3, 18, 60}
}
func build(goos string, status AppStatus, cards ...ApprovalCard) Menu {
	return BuildMenu(MenuInput{Status: status, Cards: cards, Circles: map[string]string{"c1": "Weekend projects"}, Now: menuNow, Loc: menuLoc, GOOS: goos})
}
func lines(m Menu) []string {
	var out []string
	for _, e := range m.Entries {
		if e.Separator { out = append(out, "-") } else { out = append(out, e.Label) }
	}
	return out
}

// Each case is a menu in docs/design/experience/mockups/shots/tray.*.png.
func TestMacMenusMatchTheMockups(t *testing.T) {
	ready := AppStatus{State: "ready", ActiveCircle: "c1", Today: today()}
	if got, want := lines(build("darwin", ready, sam())), []string{
		"Sam asked for help", "Review Sam’s request…", "-", "Lending is on", "Today: 2 of 3 jobs · 18 of 60 min", "-",
		"Pausing declines the 1 waiting request. No new jobs will start.", "Pause lending", "Turn lending off", "-", "Open Faravan", "New job…", "Jobs…", "Lending settings…", "Updates…", "You…", "-", "Quitting stops Faravan on this computer.", "Quit Faravan…"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("mac-request:\n%q", got)
	}
	if m := build("darwin", ready, sam()); m.State != VisualAttention { t.Fatal("a waiting request shows the dot") }
	if m := build("darwin", ready); m.State != VisualActive { t.Fatal("ready is the solid mark") }

	running := AppStatus{State: "running", Today: today()}
	if got, want := lines(build("darwin", running)), []string{
		"Running a job", "View jobs…", "Stop this job…", "Today: 2 of 3 jobs · 18 of 60 min", "-", "Finish current job, then pause", "Pause lending", "Turn lending off", "-",
		"Open Faravan", "New job…", "Lending settings…", "Updates…", "You…", "-", "Quitting stops Faravan on this computer.", "Quit Faravan…"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("mac-running:\n%q", got)
	}

	if got, want := lines(build("darwin", AppStatus{State: "off"})), []string{
		"Lending is off", "-", "Turn lending on", "-", "Open Faravan", "New job…", "Jobs…", "Lending settings…", "Updates…", "You…", "-", "Quitting stops Faravan on this computer.", "Quit Faravan"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("mac-off:\n%q", got)
	}
	if m := build("darwin", AppStatus{State: "off"}); m.State != VisualIdle { t.Fatal("off is the outline") }
}

func TestWindowsAndLinuxMenusMatchTheirMockups(t *testing.T) {
	ready := AppStatus{State: "ready", ActiveCircle: "c1", Today: today()}
	if got, want := lines(build("windows", ready)), []string{
		"Lending is on", "Open Faravan", "New job…", "Jobs…", "-", "Pause lending", "Turn lending off", "-",
		"Today: 2 of 3 jobs", "Lending settings…", "Updates…", "-", "Quitting stops Faravan on this computer.", "Quit Faravan…"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("win-flyout:\n%q", got)
	}
	if got, want := lines(build("linux", ready, sam())), []string{
		"Sam asked for help", "Review Sam’s request…", "-", "Lending is on", "Today: 2 of 3 jobs · 18 of 60 min", "-",
		"Pausing declines the 1 waiting request. No new jobs will start.", "Pause lending", "Turn lending off", "-", "Open Faravan", "New job…", "Jobs…", "Lending settings…", "Updates…", "You…", "-", "Quitting stops Faravan on this computer.", "Quit Faravan…"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("linux:\n%q", got)
	}
}

func TestMenusForTheOtherStates(t *testing.T) {
	loc := menuLoc
	until := float64(time.Date(2026, 10, 19, 15, 0, 0, 0, loc).UnixMilli())
	cases := []struct { name string; status AppStatus; cards []ApprovalCard; has, hasNot []string; visual VisualState }{
		{"paused", AppStatus{State: "paused", Until: &until}, nil, []string{"Paused until 3:00 PM", "Resume lending", "Turn lending off"}, []string{"Pause lending"}, VisualPaused},
		{"blocked", AppStatus{State: "blocked", Reason: "safety_check_failed"}, nil, []string{"Status unavailable", "Open Faravan"}, []string{"Pause lending", "Turn lending on"}, VisualError},
		{"update", AppStatus{State: "update"}, nil, []string{"Update Faravan to keep lending", "Open Faravan"}, []string{"Pause lending"}, VisualError},
		{"resting", AppStatus{State: "resting", Reason: "daily_limit"}, nil, []string{"Resting", "Pause lending"}, nil, VisualActive},
		{"partial block", AppStatus{State: "ready", NeedsYou: []NeedsYou{{Kind: "agent_signed_out", Agent: "claude"}}}, nil, []string{"Claude Code is signed out", "Pause lending"}, nil, VisualAttention},
		{"two requests", AppStatus{State: "ready"}, []ApprovalCard{sam(), {ID: "a2", RequesterName: "Maya's laptop"}}, []string{"2 requests need you", "Review Sam’s request…", "Review Maya's laptop’s request…"}, nil, VisualAttention},
		{"old app", AppStatus{IconState: "Needs attention", Attention: []struct{ Label string `json:"label"` }{{"Check setup"}}}, nil, []string{"Status unavailable", "Open Faravan"}, nil, VisualAttention},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := build("darwin", c.status, c.cards...)
			labels := strings.Join(m.Labels(), "\n")
			for _, want := range c.has { if !strings.Contains(labels, want) { t.Errorf("missing %q in\n%s", want, labels) } }
			for _, bad := range c.hasNot { if strings.Contains(labels, bad) { t.Errorf("unexpected %q", bad) } }
			if m.State != c.visual { t.Errorf("glyph %v", m.State) }
		})
	}
}

func TestEveryMenuIsWellFormed(t *testing.T) {
	for _, goos := range []string{"darwin", "windows", "linux"} {
		for _, state := range []string{"off", "paused", "blocked", "update", "running", "outside", "resting", "ready", "starting", "from-the-future"} {
			m := build(goos, AppStatus{State: state, Today: today()}, sam())
			if len(m.Entries) == 0 || m.Entries[0].Separator || m.Entries[len(m.Entries)-1].ID != "quit" { t.Fatalf("%s/%s: %q", goos, state, lines(m)) }
			ids := map[string]bool{}
			for i, e := range m.Entries {
				if e.Separator && (i == 0 || m.Entries[i-1].Separator || i == len(m.Entries)-1) { t.Fatalf("%s/%s: stray separator in %q", goos, state, lines(m)) }
				if !e.Separator && !e.Disabled {
					if ids[e.ID] { t.Fatalf("%s/%s: duplicate id %s", goos, state, e.ID) }
					ids[e.ID] = true
				}
				if strings.ContainsAny(e.Label, "\n") { t.Fatal("multi-line label") }
			}
		}
	}
	a, b := build("darwin", AppStatus{State: "ready"}), build("darwin", AppStatus{State: "ready"})
	if a.Signature() != b.Signature() || a.Signature() == build("darwin", AppStatus{State: "off"}).Signature() { t.Fatal("signature identifies the drawn menu") }
}

func TestPauseUntilTomorrowIsSevenAM(t *testing.T) {
	got := PauseTomorrow(time.Date(2026, 10, 19, 23, 30, 0, 0, menuLoc), menuLoc)
	if !got.Equal(time.Date(2026, 10, 20, 7, 0, 0, 0, menuLoc)) { t.Fatal(got) }
	if got := PauseTomorrow(time.Date(2026, 10, 31, 9, 0, 0, 0, menuLoc), menuLoc); got.Month() != time.November || got.Day() != 1 { t.Fatal(got) }
}

func TestPauseChoicesAndQuitNoteAcrossStates(t *testing.T) {
	// Pause controls exist only while lending can start jobs; off, paused, blocked and update offer their own way back.
	lendingOn := map[string]bool{"running":true,"outside":true,"resting":true,"ready":true,"starting":true}
	for _, state := range []string{"off","paused","blocked","update","running","outside","resting","ready","starting"} {
		m:=build("darwin",AppStatus{State:state}); var got []string
		for _,e:=range m.Entries { if e.ID=="pause-menu" { got=append(got,e.Label); for _,child:=range e.Children { got=append(got,child.Label) } } }
		var want []string
		if lendingOn[state] { want = []string{"Pause lending","For 30 minutes","For 1 hour","Until tomorrow, 7 AM","Until I resume"} }
		if !reflect.DeepEqual(got,want) { t.Fatalf("%s: %v",state,got) }
		if m.Entries[len(m.Entries)-2].Label!="Quitting stops Faravan on this computer." { t.Fatalf("%s: %v",state,lines(m)) }
	}
	if !hasEntry(build("darwin",AppStatus{State:"running"}),"pause-after-job") || hasEntry(build("darwin",AppStatus{State:"ready"}),"pause-after-job") { t.Fatal("finish-then-pause is only for a running job") }
}

func TestAllIconStatesHaveDifferentSilhouettes(t *testing.T) {
	states:=[]VisualState{VisualActive,VisualIdle,VisualAttention,VisualPaused,VisualError}
	for _,size:=range []int{16,32,64} { for i,a:=range states { for _,b:=range states[i+1:] {
		different:=false; ma,mb:=GlyphMask(a,size),GlyphMask(b,size)
		for y:=range ma { for x:=range ma[y] { if (ma[y][x]>.5)!=(mb[y][x]>.5) { different=true } } }
		if !different { t.Errorf("%d px: %s and %s silhouettes match",size,a,b) }
	} } }
}

func TestPauseDisclosureNamesDeclinedApprovalsAndRunningJob(t *testing.T) {
	for _,tc:=range []struct{state,want string}{{"ready","Pausing declines the 1 waiting request. No new jobs will start."},{"running","Pausing declines the 1 waiting request. The running job continues."}} {
		m:=build("darwin",AppStatus{State:tc.state},sam()); note,pause:=-1,-1
		for i,e:=range m.Entries { if e.Label==tc.want { note=i }; if e.ID=="pause-menu" { pause=i } }
		if note<0 || pause<=note { t.Fatalf("%s disclosure missing or out of order: %v",tc.state,lines(m)) }
	}
	plural:=build("darwin",AppStatus{State:"ready"},sam(),ApprovalCard{ID:"a2",RequesterName:"Maya"})
	for _,e:=range plural.Entries { if e.Label=="Pausing declines the 2 waiting requests. No new jobs will start." { return } }
	t.Fatal(lines(plural))
}

func TestMenuActionsCallTheApp(t *testing.T) {
	var calls []string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		body, _ := io.ReadAll(r.Body)
		calls = append(calls, r.Method+" "+r.URL.Path+" "+string(body))
		if r.URL.Path == "/api/handoff" { return `{"url":"http://127.0.0.1:4000/auth/handoff?code=once"}` }
		return `{}`
	})}
	var opened []string
	env := ActionEnv{Client: client, Info: AppInfo{Port: 4000, Token: "t"}, Now: menuNow, Loc: menuLoc, OpenURL: func(u string) error { opened = append(opened, u); return nil }}
	for _, id := range []string{"pause-30m", "pause-1h", "pause-tomorrow", "pause-after", "pause-after-job", "off", "on", "resume", "open", "new", "settings", "account", "watch", "review:a1"} {
		if err := RunMenuAction(context.Background(), env, id); err != nil { t.Fatalf("%s: %v", id, err) }
	}
	wantPause := func(at time.Time) string { return `POST /api/lending/pause {"until":` + itoa(at.UnixMilli()) + `}` }
	want := []string{wantPause(menuNow.Add(30*time.Minute)), wantPause(menuNow.Add(time.Hour)), wantPause(time.Date(2026, 10, 20, 7, 0, 0, 0, menuLoc)),
		"POST /api/lending/pause {}", "POST /api/lending/pause {}", "POST /api/lending/off {}", "POST /api/lending/on {}", "POST /api/lending/resume {}"}
	if !reflect.DeepEqual(calls[:8], want) { t.Fatalf("%q", calls[:8]) }
	wantOpen := []string{"...#/home", "...#/new", "...#/lend", "...#/you", "...#/jobs", "...#/request/a1"}
	for i, w := range wantOpen {
		w = strings.Replace(w, "...", "http://127.0.0.1:4000/auth/handoff?code=once", 1)
		if opened[i] != w { t.Errorf("open %d: %s want %s", i, opened[i], w) }
	}
	for _, c := range calls { if strings.Contains(c, "accept") || strings.Contains(c, "/stop") { t.Fatalf("a menu click must not accept or stop: %s", c) } }
	if err := RunMenuAction(context.Background(), env, "nonsense"); err == nil { t.Fatal("unknown action") }
}
func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestFirstLendingFixActsWithoutOpeningTheBrowser(t *testing.T) {
	for _,tc:=range []struct{state,action,label string}{{"off","on","Turn lending on…"},{"paused","resume","Resume now…"}} {
		t.Run(tc.state,func(t *testing.T){
			s:=AppStatus{State:tc.state,LendingBlockers:&BlockerModel{First:&BlockerItem{Key:"lending",Action:strings.TrimSuffix(tc.label,"…")}}}
			var id string
			for _,entry:=range build("linux",s).Entries {if entry.Label==tc.label {id=entry.ID}}
			var calls []string
			client:=AppClient{HTTPClient:appHTTP(t,func(r *http.Request)string{calls=append(calls,r.Method+" "+r.URL.Path);return `{"url":"http://127.0.0.1:1/auth/handoff?code=once"}`})}
			env:=ActionEnv{Client:client,Info:AppInfo{Port:1,Token:"t"},OpenURL:func(string)error{t.Error("a lending fix opened the browser");return nil}}
			if err:=RunMenuAction(context.Background(),env,id);err!=nil {t.Fatal(err)}
			if !reflect.DeepEqual(calls,[]string{"POST /api/lending/"+tc.action}) {t.Fatal(calls)}
		})
	}
}

func TestWatchKeepsTheShownAttemptWhenAnotherJobStarts(t *testing.T) {
	var calls, opened []string
	client:=AppClient{HTTPClient:appHTTP(t,func(r *http.Request) string {
		calls=append(calls,r.Method+" "+r.URL.Path)
		if r.URL.Path=="/api/jobs" {return `[{"job_digest":"sha256:new","circle":{"id":"c2"},"current_attempt":{"attempt_id":"attempt-B"}},{"job_digest":"sha256:shown","circle":{"id":"c1"},"current_attempt":{"attempt_id":"attempt-A"}}]`}
		return `{"url":"http://127.0.0.1:4000/auth/handoff?code=once"}`
	})}
	s:=AppStatus{State:"ready"};s.Execution.State="running";s.Execution.Job="attempt-A"
	m:=build("linux",s)
	if !hasEntry(m,"watch:attempt-A") {t.Fatal("Watch did not capture the shown attempt")}
	env:=ActionEnv{Client:client,Info:AppInfo{Port:4000,Token:"t"},OpenURL:func(link string)error{opened=append(opened,link);return nil}}
	if err:=RunMenuAction(context.Background(),env,"watch:attempt-A");err!=nil {t.Fatal(err)}
	if len(opened)!=1 || !strings.HasSuffix(opened[0],"#/job/sha256:shown/c1") {t.Fatal(opened)}
	if !reflect.DeepEqual(calls,[]string{"GET /api/jobs","POST /api/handoff"}) {t.Fatal(calls)}
	opened=nil;calls=nil
	if err:=RunMenuAction(context.Background(),env,"watch:gone");err==nil || len(opened)!=0 || len(calls)!=1 {t.Fatal("missing job opened another target",err,opened,calls)}
}


// Test the delivered PNG after compositing, not just its colourless mask.
func TestLinuxGlyphUsesBrandAmberAndDistinctModifiers(t *testing.T) {
	linear := func(v float64) float64 {
		v /= 255
		if v <= 0.04045 { return v / 12.92 }
		return math.Pow((v + 0.055) / 1.055, 2.4)
	}
	for _, state := range allVisualStates {
		for _, size := range []int{16, 22, 32} {
			img := mustDecode(t, IconPNGFor(state, "linux", size))
			arch, horizon, badge := 0, 0, 0
			for y, row := range GlyphMask(state, size) {
				for x, cover := range row {
					r, g, b, a := img.At(x, y).RGBA()
					if cover == 0 {
						if a != 0 { t.Fatalf("%v/%d: ink outside silhouette at %d,%d", state, size, x, y) }
						continue
					}
					if cover >= .5 {
						switch {
						case x >= size*3/4 && y < size/4: badge++
						case y >= size*5/8: horizon++
						default: arch++
						}
					}
					if cover < .99 { continue }
                    assertBrandPixel(t, state, size, x, y, r, g, b, a)
					for _, panel := range []float64{0, 32} {
						alpha := float64(a) / 65535
						channel := func(v uint32) float64 { return float64(v)/257 + panel*(1-alpha) }
						lum := .2126*linear(channel(r)) + .7152*linear(channel(g)) + .0722*linear(channel(b))
						bg := linear(panel)
						if contrast := (math.Max(lum, bg) + .05) / (math.Min(lum, bg) + .05); contrast < 3 {
							t.Errorf("%v/%d panel %.0f core %d,%d contrast %.2f < 3", state, size, panel, x, y, contrast)
						}
					}
				}
			}
			hasBadge := state == VisualAttention || state == VisualPaused || state == VisualError
			if arch == 0 || horizon == 0 || (badge > 0) != hasBadge {
				t.Fatalf("%v/%d: arch %d, horizon %d, badge %d pixels", state, size, arch, horizon, badge)
			}
		}
	}
}
func TestGlyphsDifferInSilhouetteNotColour(t *testing.T) {
	masks := map[VisualState][][]float64{}
	for _, s := range []VisualState{VisualActive, VisualIdle, VisualAttention} {
		masks[s] = GlyphMask(s, 32)
	}
	differ := func(a, b [][]float64) int {
		n := 0
		for y := range a {
			for x := range a[y] {
				if (a[y][x] > 0.5) != (b[y][x] > 0.5) {
					n++
				}
			}
		}
		return n
	}
	// Check native sizes and the 44 px macOS runtime size: every state must stay distinct.
	for _, size := range []int{16, 22, 32, 44, 64} {
		on, off, need := GlyphMask(VisualActive, size), GlyphMask(VisualIdle, size), GlyphMask(VisualAttention, size)
		floor := size * size / 40
		if differ(on, off) < floor {
			t.Errorf("%dpx: on and off look alike (%d pixels)", size, differ(on, off))
		}
		if differ(on, need) < size/8 {
			t.Errorf("%dpx: on and needs-you look alike (%d pixels)", size, differ(on, need))
		}
		if differ(off, need) < floor {
			t.Errorf("%dpx: off and needs-you look alike", size)
		}
	}
	// Off is lighter than on: an outline arch and a broken horizon, not a fainter copy.
	count := func(m [][]float64) (n int) {
		for _, r := range m {
			for _, v := range r {
				if v > 0.5 {
					n++
				}
			}
		}
		return
	}
	if count(masks[VisualIdle]) >= count(masks[VisualActive]) {
		t.Error("the off glyph is lighter than the on glyph")
	}
	if count(masks[VisualAttention]) <= count(masks[VisualActive]) {
		t.Error("needs-you adds a dot to the mark")
	}
	// The horizon breaks at its middle only when off.
	if masks[VisualActive][24][16] < 1 || masks[VisualIdle][24][16] != 0 {
		t.Error("the off horizon is broken at its middle; the on horizon is whole")
	}
	// The corner dot is only in needs-you.
	if masks[VisualActive][3][27] > 0.5 || masks[VisualAttention][3][27] < 0.5 {
		t.Error("the badge dot is at the top right of needs-you only")
	}
	for _, goos := range []string{"darwin", "windows", "linux"} {
		for _, size := range []int{16, 32, 44} {
			img, err := png.Decode(bytes.NewReader(IconPNGFor(VisualActive, goos, size)))
			if err != nil || img.Bounds().Dx() != size || img.Bounds().Dy() != size {
				t.Fatalf("%s %dpx: %v", goos, size, err)
			}
			_, _, _, a := img.At(size/2, size/4).RGBA()
			if a == 0 {
				t.Errorf("%s %dpx: the arch is drawn", goos, size)
			}
		}
	}
	r, g, b, _ := mustDecode(t, IconPNGFor(VisualActive, "darwin", 32)).At(16, 8).RGBA()
	if r|g|b != 0 {
		t.Error("the macOS template glyph is black")
	}
}

func mustDecode(t *testing.T, data []byte) image.Image {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestMenuOffersToFinishSetupAfterARestart(t *testing.T) {
	var back, waiting AppStatus
	if err := json.Unmarshal([]byte(`{"state":"off","setup":{"resume":{"step":"hypervisor","state":"returned"}}}`), &back); err != nil { t.Fatal(err) }
	if err := json.Unmarshal([]byte(`{"state":"off","setup":{"resume":{"step":"hypervisor","state":"waiting"}}}`), &waiting); err != nil { t.Fatal(err) }
	m := build("windows", back)
	if got := strings.Join(m.Labels(), "|"); !strings.Contains(got, "Setup is ready to continue|Finish setting up Faravan…") { t.Fatal(got) }
	if m.State != VisualAttention { t.Fatal("it shows the dot") }
	if strings.Contains(strings.Join(build("windows", waiting).Labels(), "|"), "Finish setting up") { t.Fatal("not while the restart is still pending") }
	if build("windows", AppStatus{State: "off"}).State != VisualIdle { t.Fatal("no setup, no dot") }
}

func TestWatchNeverOpensAJobWithoutADigest(t *testing.T) {
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		if r.URL.Path != "/api/jobs" { t.Fatal("missing digest requested a handoff", r.URL.Path) }
		return `[{"current_attempt":{"attempt_id":"attempt-A"},"circle":{"id":"c1"}}]`
	})}
	env := ActionEnv{Client: client, Info: AppInfo{Port: 4000, Token: "t"}, OpenURL: func(link string) error {
		t.Fatal("missing digest opened a link", link)
		return nil
	}}
	if err := RunMenuAction(context.Background(), env, "watch:attempt-A"); err == nil { t.Fatal("missing digest must be rejected") }
}

func TestUpdatesIsReachableFromEveryPlatformMenu(t *testing.T) {
 for _, platform := range []string{"linux","darwin","windows"} {
  menu := build(platform, AppStatus{State:"off"})
  found := false
  for _, entry := range menu.Entries { if entry.ID == "updates" && entry.Label == "Updates…" { found = true } }
  if !found { t.Fatalf("%s has no Updates menu entry",platform) }
 }
 if routes["updates"] != "#/you/updates" { t.Fatal("Updates must open the single Settings home") }
}

func TestWindowsLightAndDarkGlyphsPreserveTheNativeMasks(t *testing.T) {
	for _, light := range []bool{false, true} {
		for _, state := range []VisualState{VisualActive, VisualIdle, VisualAttention} {
			for _, size := range []int{16, 32, 44, 64} {
				img := mustDecode(t, IconPNGFor(state, "windows", size, light))
				for y, row := range GlyphMask(state, size) {
					for x, cover := range row {
						r, g, b, a := img.At(x, y).RGBA()
						wantAlpha := uint32(cover*255+0.5) * 257
						if a != wantAlpha { t.Fatalf("light=%v %v %dpx (%d,%d): alpha=%d want %d", light, state, size, x, y, a, wantAlpha) }
						assertBrandPixel(t, state, size, x, y, r, g, b, a)
					}
				}
			}
		}
	}
}

func TestWindowsGlyphUsesBrandInkAndPreservesCoverage(t *testing.T) {
	for _, state := range []VisualState{VisualActive, VisualIdle, VisualAttention} {
		for _, size := range []int{16, 32, 64} {
			img := mustDecode(t, IconPNGFor(state, "windows", size))
			for y, row := range GlyphMask(state, size) {
				for x, cover := range row {
					r, g, b, a := img.At(x, y).RGBA()
					if cover == 0 {
						if a != 0 { t.Fatalf("%v %dpx: background is opaque", state, size) }
						continue
					}
					assertBrandPixel(t, state, size, x, y, r, g, b, a)
					if cover == 1 && a != 65535 {
						t.Fatalf("%v %dpx: solid grid/outline pixel lost opacity", state, size)
					}
				}
			}
		}
	}
}

type lifecycleTransport func(*http.Request) (*http.Response, error)

func (f lifecycleTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func writeLifecycleAppInfo(t *testing.T, path string, info AppInfo) {
	t.Helper()
	data, err := json.Marshal(info)
	if err != nil { t.Fatal(err) }
	if err := os.WriteFile(path, data, 0600); err != nil { t.Fatal(err) }
}

func lifecycleClient(t *testing.T) (LocalClient, AppInfo) {
	t.Helper()
	info := AppInfo{Port: 4000, Token: "shown-token", PID: 1, StartedAt: "2026-10-21T00:00:00Z"}
	client := LocalClient{AppPath: filepath.Join(t.TempDir(), "app.json"), Alive: func(int) bool { return true }}
	writeLifecycleAppInfo(t, client.AppPath, info)
	return client, info
}

func lifecycleResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestMenuClickResolvesDiscoveryAfterRestart(t *testing.T) {
	for _, id := range []string{"open", "pause-1h", "watch:attempt-A"} {
		t.Run(id, func(t *testing.T) {
			client, shown := lifecycleClient(t)
			var calls, opened []string
			client.AppClient.HTTPClient = &http.Client{Transport: lifecycleTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "127.0.0.1:5000" || r.Header.Get("X-Faravan-Session-Token") != "current-token" {
					t.Error("click used the app identity from the previous poll")
				}
				calls = append(calls, r.URL.Path)
				if r.URL.Path == "/api/jobs" {
					return lifecycleResponse(`[{"job_digest":"sha256:new","circle":{"id":"c2"},"current_attempt":{"attempt_id":"attempt-B"}},{"job_digest":"sha256:shown","circle":{"id":"c1"},"current_attempt":{"attempt_id":"attempt-A"}}]`), nil
				}
				return lifecycleResponse(`{"url":"http://127.0.0.1:5000/auth/handoff?code=once"}`), nil
			})}
			env := ActionEnv{Client: client.AppClient, Info: shown, Now: menuNow, Loc: menuLoc, OpenURL: func(link string) error { opened = append(opened, link); return nil }}
			current := AppInfo{Port: 5000, Token: "current-token", PID: 2, StartedAt: "2026-10-21T00:01:00Z"}
			writeLifecycleAppInfo(t, client.AppPath, current)
			if err := client.RunMenuAction(context.Background(), env, id); err != nil { t.Fatal(err) }
			if len(calls) == 0 { t.Fatal("click made no request") }
			if id == "watch:attempt-A" && (len(opened) != 1 || !strings.HasSuffix(opened[0], "#/job/sha256:shown/c1")) {
				t.Fatal("restart changed the attempt selected by the menu", opened)
			}
		})
	}
}

func TestMenuActionDoesNotReplayAfterAnUncertainFailure(t *testing.T) {
	client, shown := lifecycleClient(t)
	calls := 0
	client.AppClient.HTTPClient = &http.Client{Transport: lifecycleTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		writeLifecycleAppInfo(t, client.AppPath, AppInfo{Port: 5000, Token: "restarted-token", PID: 2, StartedAt: "2026-10-21T00:01:00Z"})
		return &http.Response{StatusCode: http.StatusInternalServerError, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	if err := client.RunMenuAction(context.Background(), ActionEnv{Client: client.AppClient, Info: shown}, "pause-1h"); err == nil { t.Fatal("expected action failure") }
	if calls != 1 { t.Fatalf("uncertain action was replayed %d times", calls) }
}

func TestHangingDesktopProbeDoesNotBlockQuitOrNextRefresh(t *testing.T) {
	client, _ := lifecycleClient(t)
	client.AppClient.HTTPClient = &http.Client{Transport: lifecycleTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/approvals" { return lifecycleResponse("[]"), nil }
		return lifecycleResponse(`{"state":"off"}`), nil
	})}
	var menuMu sync.Mutex
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	probing, refreshed, quit := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		client.Refresh(ctx, &menuMu, func(Connection) {}, func(probeCtx context.Context, _ Connection) {
			close(probing)
			<-probeCtx.Done() // a session bus accepts the request but never replies
		})
		close(refreshed)
	}()
	select { case <-probing: case <-time.After(2*time.Second): t.Fatal("probe did not start") }
	go func() {
		menuMu.Lock() // Quit must be able to snapshot the current connection.
		menuMu.Unlock()
		close(quit)
	}()
	select {
	case <-quit:
		if ctx.Err() != nil { t.Error("Quit waited for the hanging desktop probe") }
	case <-ctx.Done():
		t.Error("Quit was blocked by the desktop probe")
	}
	select { case <-refreshed: case <-time.After(2*time.Second): t.Fatal("refresh ignored its deadline") }
	next := make(chan struct{})
	go func() {
		nextCtx, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		client.Refresh(nextCtx, &menuMu, func(Connection) {}, func(context.Context, Connection) {})
		close(next)
	}()
	select { case <-next: case <-time.After(2*time.Second): t.Fatal("next refresh was blocked") }
	select { case <-quit: case <-time.After(2*time.Second): t.Fatal("Quit did not recover") }
}

func TestUpdateAvailabilityLabelUsesHomeProjectionOnEveryPlatform(t *testing.T) {
	cases := []struct{ raw, label string }{
		{`{"state":"available","candidate":"2.0.0","currentVersion":"1.0.0"}`, "Update available…"},
		{`{"state":"staged","candidate":"2.0.0","currentVersion":"1.0.0"}`, "Update waiting to install…"},
		{`{"state":"current","candidate":"2.0.0","currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"checking","candidate":"2.0.0","currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"failed","candidate":"2.0.0","currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"unknown","candidate":"2.0.0","currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"available","candidate":"1.0.0","currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"available","candidate":42,"currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"available","candidate":"2.0.0"}`, "Updates…"},
		{`{"state":"staged","candidate":" ","currentVersion":"1.0.0"}`, "Updates…"},
		{`{"state":"staged","candidate":"2.0.0\n","currentVersion":"1.0.0"}`, "Updates…"},
		{`null`, "Updates…"}, {`[]`, "Updates…"}, {`{}`, "Updates…"},
	}
	for _, platform := range []string{"linux","darwin","windows"} {
		for _, tc := range cases {
			var status AppStatus
			if err := json.Unmarshal([]byte(`{"state":"off","updateStatus":`+tc.raw+`}`), &status); err != nil { t.Fatal(err) }
			count := 0
			for _, entry := range build(platform,status).Entries {
				if entry.ID == "updates" {
					count++
					if entry.Label != tc.label || entry.Disabled { t.Fatalf("%s %s: %#v",platform,tc.raw,entry) }
				}
			}
			if count != 1 { t.Fatalf("%s: update action count %d",platform,count) }
		}
	}
	if routes["updates"] != "#/you/updates" { t.Fatal("update navigation changed") }
}

func TestHomeUpdateStateClearsOnNextTrayRead(t *testing.T) {
	body := `{"state":"off","updateStatus":{"state":"available","candidate":"2.0.0","currentVersion":"1.0.0"}}`
	calls := 0
	client := AppClient{HTTPClient:appHTTP(t,func(r *http.Request) string {
		calls++
		if r.Method != "GET" || r.URL.Path != "/api/home" { t.Fatal("unexpected update request",r.Method,r.URL.Path) }
		return body
	})}
	info := AppInfo{Port:1,Token:"fixture"}
	first,err := client.Status(context.Background(),info);if err != nil { t.Fatal(err) }
	if updateMenuLabel(first.UpdateStatus) != "Update available…" { t.Fatal(first) }
	for _, next := range []string{`{"state":"off","updateStatus":null}`,`{"state":"off"}`,`{"state":"off","updateStatus":{"state":"current","candidate":"2.0.0","currentVersion":"2.0.0"}}`} {
		body = next
		status,err := client.Status(context.Background(),info);if err != nil { t.Fatal(err) }
		if updateMenuLabel(status.UpdateStatus) != "Updates…" { t.Fatal("stale update survived",status) }
		if build("linux",first).Signature() == build("linux",status).Signature() { t.Fatal("menu did not invalidate") }
	}
	if calls != 4 { t.Fatalf("unexpected extra requests: %d",calls) }
}

// The amber tray rule replaces the former monochrome ink pins. Shape and
// coverage checks stay unchanged; the modifier is neutral gray on both panels.
func assertBrandPixel(t *testing.T, state VisualState, size,x,y int, r,g,b,a uint32) {
 t.Helper()
 ink,err:=brandmark.HexColor(brandmark.Default().Color);if err!=nil{t.Fatal(err)}
 if (state==VisualAttention||state==VisualPaused||state==VisualError)&&x>=size*3/4&&y<size/4{ink=color.NRGBA{R:117,G:117,B:117,A:255}}
 ink.A=uint8(a/257);wr,wg,wb,_:=ink.RGBA()
 if r!=wr||g!=wg||b!=wb{t.Fatalf("%v %dpx %d,%d: ink=%d/%d/%d want=%d/%d/%d",state,size,x,y,r,g,b,wr,wg,wb)}
}
