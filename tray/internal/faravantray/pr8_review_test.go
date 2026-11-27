package faravantray

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPauseControlsFollowIntentAcrossExecutionMatrix(t *testing.T) {
	states := []struct {
		name string
		on   bool
	}{
		{"ready", true}, {"outside", true}, {"resting", true}, {"starting", true}, {"running", true},
		{"paused", false}, {"off", false}, {"blocked", false}, {"update", false}, {"future", false},
	}
	for _, state := range states {
		for _, execution := range []string{"idle", "running", "finishing", "stopping"} {
			t.Run(state.name+"/"+execution, func(t *testing.T) {
				s := AppStatus{State: state.name}
				s.Execution.State = execution
				m := build("darwin", s)
				if got := hasEntry(m, "pause-menu"); got != state.on {
					t.Errorf("pause submenu=%v, want %v", got, state.on)
				}
				wantFinish := state.on && (execution == "running" || execution == "finishing")
				if got := hasEntry(m, "pause-after-job"); got != wantFinish {
					t.Errorf("finish-then-pause=%v, want %v", got, wantFinish)
				}
				wantOff := state.on || (state.name == "paused" && execution == "idle")
				if hasEntry(m, "off") != wantOff {
					t.Errorf("Turn lending off availability: %q", lines(m))
				}
				if state.name == "paused" || state.name == "off" {
					want := "resume"
					if state.name == "off" {
						want = "on"
					}
					other := "on"
					if want == "on" {
						other = "resume"
					}
					if !hasEntry(m, want) || hasEntry(m, other) {
						t.Errorf("wrong way back: %q", lines(m))
					}
				} else if hasEntry(m, "resume") || hasEntry(m, "on") {
					t.Errorf("unexpected way back: %q", lines(m))
				}
				if execution != "idle" && !hasMenuLabel(m, "View jobs…", "Watch it…") {
					t.Errorf("missing job navigation: %q", lines(m))
				}
				if execution == "stopping" && hasEntry(m, "stop") {
					t.Errorf("Stop while stopping: %q", lines(m))
				}
				if execution != "idle" && execution != "stopping" && !hasEntry(m, "stop") {
					t.Errorf("missing per-job Stop: %q", lines(m))
				}
			})
		}
	}
	legacyPaused := build("darwin", AppStatus{IconState: "Paused", CurrentJob: json.RawMessage(`{"id":"attempt-A"}`)})
	if hasEntry(legacyPaused, "pause-menu") || !hasEntry(legacyPaused, "resume") {
		t.Fatalf("legacy paused job controls: %q", lines(legacyPaused))
	}
	legacyOn := build("darwin", AppStatus{IconState: "Lending on", CurrentJob: json.RawMessage(`{"id":"attempt-A"}`)})
	if !hasEntry(legacyOn, "pause-menu") || !hasEntry(legacyOn, "off") {
		t.Fatalf("legacy on job controls: %q", lines(legacyOn))
	}

	var calls []string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string { calls = append(calls, r.Method+" "+r.URL.Path); return `{}` })}
	if err := RunMenuAction(context.Background(), ActionEnv{Client: client, Info: AppInfo{Port: 1, Token: "t"}}, "pause-30m"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"POST /api/lending/pause"}) {
		t.Fatalf("pause must only post pause: %v", calls)
	}
}

func hasMenuLabel(m Menu, labels ...string) bool {
	for _, e := range m.Entries {
		for _, label := range labels {
			if e.Label == label {
				return true
			}
		}
	}
	return false
}

func TestPauseDisclosureCountsOnlyWaitingLendingApprovals(t *testing.T) {
	chatgpt := ApprovalCard{ID: "chatgpt:one", Kind: ChatgptKind, Label: "Turn lending on"}
	for _, tc := range []struct {
		name  string
		cards []ApprovalCard
		want  string
	}{
		{"ChatGPT only", []ApprovalCard{chatgpt}, ""},
		{"mixed", []ApprovalCard{chatgpt, sam()}, "Pausing declines the 1 waiting request. No new jobs will start."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := build("darwin", AppStatus{State: "ready"}, tc.cards...)
			for _, e := range m.Entries {
				if strings.Contains(e.Label, "Pausing declines") {
					if e.Label != tc.want {
						t.Fatalf("got %q, want %q", e.Label, tc.want)
					}
					return
				}
			}
			if tc.want != "" {
				t.Fatalf("missing disclosure %q: %q", tc.want, lines(m))
			}
		})
	}
}

func TestPauseTomorrowUsesLocalCalendarTimeAcrossDSTAndNilLocation(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		start   time.Time
		elapsed time.Duration
	}{
		{"spring forward", time.Date(2026, 3, 7, 9, 0, 0, 0, loc), 21 * time.Hour},
		{"fall back", time.Date(2026, 10, 31, 9, 0, 0, 0, loc), 23 * time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := PauseTomorrow(tc.start, loc)
			if got.Hour() != 7 || got.Minute() != 0 || got.Sub(tc.start) != tc.elapsed {
				t.Fatalf("got %v, elapsed %v; want 7 AM after %v", got, got.Sub(tc.start), tc.elapsed)
			}
		})
	}
	if got := PauseTomorrow(time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC), nil); got.Hour() != 7 || got.Location() != time.Local {
		t.Fatalf("nil location result: %v", got)
	}
}

func TestExecutionNeverHidesBlockersAndExpectedRestsStayDotFree(t *testing.T) {
	for _, exec := range []string{"running", "finishing", "stopping"} {
		for _, state := range []string{"blocked", "update", "future-state"} {
			t.Run(state+"/"+exec, func(t *testing.T) {
				s := AppStatus{State: state}
				s.Execution.State = exec
				if got := VisualFor(s, 0); got != VisualError {
					t.Fatalf("got %v, want error", got)
				}
			})
		}
	}
	legacy := AppStatus{IconState: "Needs attention", CurrentJob: json.RawMessage(`{"id":"attempt-A"}`)}
	if got := VisualFor(legacy, 0); got != VisualError {
		t.Fatalf("legacy blocker with current job: %v", got)
	}
	needsYou := AppStatus{State: "blocked", NeedsYou: []NeedsYou{{Kind: "agent_signed_out"}}}
	needsYou.Execution.State = "running"
	if got := VisualFor(needsYou, 0); got != VisualAttention {
		t.Fatalf("real needs-you should show attention: %v", got)
	}
	blockedModel := AppStatus{State: "ready", LendingBlockers: &BlockerModel{CanLend: false, Items: []BlockerItem{{Key: "isolation_check", Status: "blocked"}}}}
	blockedModel.Execution.State = "finishing"
	if got := VisualFor(blockedModel, 0); got != VisualError {
		t.Fatalf("non-lending blocker without needsYou: %v", got)
	}
	// The app's own labels for these rests (lib/v1/lender.mjs LABELS) with the iconState appIconState gives them.
	for _, s := range []AppStatus{
		{State: "resting", Reason: "quota_reserve", IconState: "Paused", Attention: []struct {
			Label string `json:"label"`
		}{{"Your remaining allowance is being kept for you."}}},
		{State: "resting", Reason: "daily_limit", IconState: "Paused", Attention: []struct {
			Label string `json:"label"`
		}{{"Today's lending limit is reached."}}},
		{IconState: "Paused", Attention: []struct {
			Label string `json:"label"`
		}{{"Daily limit reached"}}},
	} {
		if got := VisualFor(s, 0); got == VisualAttention {
			t.Fatalf("expected rest showed needs-you dot: %+v", s)
		}
	}
	oldActionable := AppStatus{Attention: []struct {
		Label string `json:"label"`
	}{{"Check setup"}}}
	if got := VisualFor(oldActionable, 0); got == VisualActive || got == VisualIdle {
		t.Fatalf("old attention without iconState looked fine: %v", got)
	}
	mixedRest := AppStatus{State: "resting", Reason: "daily_limit", IconState: "Needs attention", Attention: []struct {
		Label string `json:"label"`
	}{{"Daily limit reached"}, {"Check setup"}}}
	if got := VisualFor(mixedRest, 0); got != VisualAttention {
		t.Fatalf("independent real need was hidden by expected rest: %v", got)
	}
}
