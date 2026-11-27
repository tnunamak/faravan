package faravantray

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// These fixtures are emitted by the app's effectiveState and the UI's trayLines,
// including the legacy blockers array alongside the ordered lending_blockers model.
func TestHomeOrderedBlockers(t *testing.T) {
	data, err := os.ReadFile("testdata/home-states.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name   string
		Status AppStatus
		Lines  [][2]string
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	redundant := map[string][]string{
		"off": {"Lending · Turned off"},
		"paused": {"Lending · Paused until 3:00 PM"},
		"finishing": {"Lending · Paused until 3:00 PM"},
		"docker_stopped": {"Docker Sandboxes · Not running"},
		"docker_signed_out": {"Docker sign-in · Not signed in"},
		"codex_signed_out": {"Codex · Signed out"},
		"isolation_failed": {"Lending paused: sandbox isolation check failed"},
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			m := build("linux", f.Status)
			labels := m.Labels()
			last := -1
			// Keep the app's row order, omitting repeated facts in the native menu.
			seen := map[string]bool{}
			for _, label := range redundant[f.Name] { seen[label] = true }
			for _, row := range f.Lines[1:] {
				if seen[row[0]] { continue }
				seen[row[0]] = true
				at := -1
				for i, label := range labels {
					if i > last && label == row[0] {
						at = i
						break
					}
				}
				if at <= last {
					t.Errorf("missing or out-of-order %q in %v", row[0], labels)
				}
				last = at
			}
			if f.Name == "ready" && m.Status != "Lending is on · Ready for requests" {
				t.Errorf("ready headline %q", m.Status)
			}
			if f.Name == "off" && m.State != VisualIdle || f.Name == "paused" && m.State != VisualPaused {
				t.Errorf("intent alone showed needs-you: %s", m.State)
			}
			for _, bad := range redundant[f.Name] {
				for _, label := range labels {
					if label == bad { t.Errorf("repeated fact %q", bad) }
				}
			}
			for _, goos := range []string{"darwin", "windows", "linux"} {
				menu := build(goos, f.Status)
				statusLines := map[string]bool{}
				var navigation []string
				for _, entry := range menu.Entries {
					if entry.Disabled {
						if statusLines[entry.Label] { t.Errorf("%s: duplicate status line %q", goos, entry.Label) }
						statusLines[entry.Label] = true
					}
					switch entry.ID {
					case "open", "new", "settings", "account", "quit": navigation = append(navigation, entry.ID)
					}
				}
				want := []string{"open", "new", "settings", "account", "quit"}
				if goos == "windows" { want = []string{"open", "new", "settings", "quit"} }
				if !reflect.DeepEqual(navigation, want) { t.Errorf("%s: navigation %v, want %v", goos, navigation, want) }
			}
			if f.Name == "codex_signed_out" && !strings.Contains(strings.Join(labels, "\n"), "Codex is signed out") {
				t.Error("missing named sign-out")
			}
			for _, bad := range []string{"a safety check failed", "Check setup", "Member 1", "verdict", "fingerprint", "sandbox_not_ready", "agent_signed_out"} {
				if strings.Contains(strings.Join(labels, "\n"), bad) {
					t.Errorf("banned copy %q", bad)
				}
			}
			t.Logf("fixture %s [%s]\n%s", f.Name, m.State, strings.Join(labels, "\n"))
		})
	}
}

func TestHomeEpochTimesUseTheComputerZone(t *testing.T) {
	var status AppStatus
	payload := `{"state":"paused","until":1792447200000,"intent":{"on":true,"state":"paused","until":1792447200000},"headline":"Paused · Sam's job is finishing, stops by 3:01 PM","execution":{"state":"finishing","person":"Sam","job":"attempt-1","stops_by":1792447260000},"lending_blockers":{"headline":"Paused until 3:00 PM","first":{"key":"lending","action":"Resume now"},"items":[{"key":"lending","label":"Lending","status":"blocked","detail":"Paused until 3:00 PM."}]}}`
	if err := json.Unmarshal([]byte(payload), &status); err != nil {
		t.Fatal(err)
	}
	m := BuildMenu(MenuInput{Status: status, Now: menuNow, Loc: time.UTC, GOOS: "linux"})
	if !strings.Contains(m.Status, "Paused until 10:00 PM") || !strings.Contains(m.Status, "stops by 10:01 PM") {
		t.Fatal(m.Status)
	}
	if strings.Contains(strings.Join(m.Labels(), "\n"), "Lending · Paused until") {
		t.Fatal("pause deadline repeats the headline", m.Labels())
	}
}

func TestLegacyAttentionNeverRendersCodesOrBannedCopy(t *testing.T) {
	for _, reason := range []string{"safety_check_failed", "sandbox_not_ready", "agent_not_ready", "agent_signed_out", "lending_not_started", "unknown_future"} {
		m := build("linux", AppStatus{State: "blocked", Reason: reason, NeedsYou: []NeedsYou{{Kind: "agent_signed_out", Agent: "sha256:unknown_agent"}, {Kind: "safety_check_failed"}, {Kind: "attention", Agent: "Check setup"}}})
		text := strings.Join(m.Labels(), "\n")
		for _, bad := range []string{"safety check failed", "sha256:", "unknown_agent", "Check setup", reason} {
			if strings.Contains(text, bad) {
				t.Errorf("%s leaked %q: %s", reason, bad, text)
			}
		}
	}
	if h := Headline(AppStatus{State: "blocked", Reason: "safety_check_failed", Headline: "Lending stopped: a safety check failed"}, menuNow, menuLoc); h != "Status unavailable" {
		t.Fatal(h)
	}
}

func TestHomeSupportsAnOrderedBlockersObjectAndCanonicalRestIcon(t *testing.T) {
	var status AppStatus
	if err := json.Unmarshal([]byte(`{"state":"resting","headline":"Resting","iconState":"Paused","blockers":{"headline":"Resting","items":[{"key":"agent","label":"Codex","status":"ok","detail":"Ready."}]}}`), &status); err != nil {
		t.Fatal(err)
	}
	m := build("linux", status)
	if m.State != VisualActive || !strings.Contains(strings.Join(m.Labels(), "\n"), "Codex · Ready") {
		t.Fatal(m)
	}
}

func TestFinishingJobKeepsTheActiveSilhouetteWithCanonicalPausedIcon(t *testing.T) {
	s := AppStatus{State: "paused", IconState: "Paused"}
	s.Execution.State = "finishing"
	if got := build("linux", s).State; got != VisualActive {
		t.Fatal(got)
	}
}

func TestNonModelHoldsNeverBorrowTheReadyModelHeadline(t *testing.T) {
	for _, tc := range []struct{ state, reason, headline, want string }{
		{"update", "update_required", "Update needed", "Update needed"},
		{"update", "update_required", "", "Update Faravan to keep lending"},
		{"blocked", "lending_not_started", "Lending stopped", "Status unavailable"},
		{"starting", "", "", "Checking this computer…"},
	} {
		s := AppStatus{State: tc.state, Reason: tc.reason, Headline: tc.headline, LendingBlockers: &BlockerModel{Headline: "Lending is on", CanLend: true}}
		if got := Headline(s, menuNow, menuLoc); got != tc.want {
			t.Errorf("%s: %q", tc.state, got)
		}
	}
}

func TestHomeAgentLabelsMatchTheWebProductNamesWithoutMutatingInput(t *testing.T) {
	for _, tc := range []struct{ id, old, name string }{{"codex", "ChatGPT (Codex)", "Codex"}, {"claude-code-subscription", "Claude", "Claude Code"}, {"claude-code-api-key", "Claude (API key)", "Claude Code (API key)"}} {
		model := &BlockerModel{Headline: "Lending stopped: " + tc.old + " is signed out", First: &BlockerItem{Key: "agent", Agent: tc.id, Label: tc.old, Action: "Sign in to " + tc.old}, Items: []BlockerItem{{Key: "agent", Agent: tc.id, Label: tc.old, Status: "blocked", Detail: "Signed out."}}}
		m := build("linux", AppStatus{State: "blocked", LendingBlockers: model})
		if !strings.Contains(m.Status, tc.name+" is signed out") || !hasEntry(m, "fix") {
			t.Fatal(m)
		}
		if model.Items[0].Label != tc.old || model.First.Label != tc.old {
			t.Fatal("changed the caller's model")
		}
	}
}

func TestOutsideStoppingHeadlineKeepsOnlyTheLocalStartTime(t *testing.T) {
	until := float64(1792447200000)
	s := AppStatus{State: "outside", Until: &until, Headline: "Outside lending hours · starts at 3:00 PM · Stopping a job; not confirmed yet"}
	s.Execution.State = "stopping"
	if got := Headline(s, menuNow, time.UTC); got != "Lending starts at 10:00 PM · Stopping a job; not confirmed yet" {
		t.Fatal(got)
	}
}

func TestBlockerEvidenceTimesAreLocalOrOmittedWhenTheirZoneIsUnknown(t *testing.T) {
	var status AppStatus
	if err := json.Unmarshal([]byte(`{"host":{"lastReachedAt":"2026-10-19T22:00:00Z"}}`), &status); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ key, detail, want string }{
		{"docker_signin", "Expired at 3:00 PM.", "Expired."},
		{"circle", "Can’t reach Sam. Last reached 3:00 PM.", "Can’t reach Sam. Last reached 10:00 PM."},
	} {
		if got := localBlockerDetail(status, BlockerItem{Key: tc.key, Detail: tc.detail}, menuNow, time.UTC); got != tc.want {
			t.Errorf("%s: %q", tc.key, got)
		}
	}
	status.Host = nil
	if got := localBlockerDetail(status, BlockerItem{Key: "circle", Detail: "Can’t reach Sam. Last reached 3:00 PM."}, menuNow, time.UTC); got != "Can’t reach Sam." {
		t.Fatal(got)
	}
}

func TestStoppedAgentChecksUseBlockerHeadline(t *testing.T) {
 var status AppStatus
 if err := json.Unmarshal([]byte(`{"state":"blocked","reason":"agent_not_ready","lending_blockers":{"headline":"Lending stopped: agent checks failed","first":{"key":"agent","action":"Check agents"},"items":[{"key":"agent","status":"blocked","detail":"Automatic checks stopped after 3 failures.","action":"Check agents"}]}}`), &status); err != nil {t.Fatal(err)}
 if got := Headline(status, time.Now(), time.Local); got != "Lending stopped: agent checks failed" {t.Fatal(got)}
}
