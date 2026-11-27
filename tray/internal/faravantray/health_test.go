package faravantray

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"strings"
	"testing"
)

func TestHealthNoticeDeduplicatesAndRetainsAcrossUnknownReads(t *testing.T) {
	var tracker HealthNoticeTracker
	status := AppStatus{LendingStopped: &LendingStopped{ID: "incident-1", Reason: "Docker Sandboxes stopped. Faravan is checking it again."}}
	note := tracker.Update(status)
	if note == nil || note.Title != "Lending stopped" || note.Body != status.LendingStopped.Reason {
		t.Fatalf("wrong notice: %#v", note)
	}
	if tracker.Update(status) != nil {
		t.Fatal("duplicate notice")
	}
	tracker.Update(AppStatus{})
	if tracker.Update(status) != nil {
		t.Fatal("unknown read replayed notice")
	}
	status.LendingStopped.ID = "incident-2"
	if tracker.Update(status) == nil {
		t.Fatal("new outage should notify")
	}
}

func TestBlockedLendingNoticeUsesAllowlistedReasonAndIgnoresVoluntaryPauses(t *testing.T) {
	var tracker HealthNoticeTracker
	status := AppStatus{State: stateBlocked, Reason: "docker_signed_out"}
	// A missing intent is unknown, not proof that lending was stopped.
	if tracker.Update(status) != nil {
		t.Fatal("unknown intent")
	}
	status.Intent = &struct {
		On    bool     `json:"on"`
		State string   `json:"state"`
		Until *float64 `json:"until"`
	}{On: true}
	if tracker.Update(status) == nil {
		t.Fatal("signed out lender should notify")
	}
	if tracker.Update(status) != nil {
		t.Fatal("duplicate")
	}
	status.State = statePaused
	tracker.Update(status)
	status.State = stateBlocked
	if tracker.Update(status) == nil {
		t.Fatal("new interruption")
	}
	status.Reason = "raw secret-shaped diagnostic"
	if tracker.Update(status) != nil {
		t.Fatal("unknown reason leaked")
	}
}

func TestHealthNoticeRetriesFailedDisplay(t *testing.T) {
	var tracker HealthNoticeTracker
	status := AppStatus{LendingStopped: &LendingStopped{ID: "incident", Reason: "Docker Sandboxes stopped."}}
	note := tracker.Update(status)
	tracker.Retry(note.ID)
	if tracker.Update(status) == nil {
		t.Fatal("failed display consumed incident")
	}
	tracker.Retry("old-incident")
	if tracker.Update(status) != nil {
		t.Fatal("old failure reset a newer observation")
	}
}

func TestHealthReviewResolvesDiscoveryAfterNotificationWasShown(t *testing.T) {
	client, shown := lifecycleClient(t)
	client.AppClient.HTTPClient = &http.Client{Transport: lifecycleTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "127.0.0.1:5000" || r.Header.Get("X-Faravan-Session-Token") != "current-token" {
			t.Error("health Review used the identity captured when the notification was shown")
		}
		return lifecycleResponse(`{"url":"http://127.0.0.1:5000/auth/handoff?code=once"}`), nil
	})}
	var opened string
	env := ActionEnv{Client: client.AppClient, Info: shown, OpenURL: func(link string) error { opened = link; return nil }}
	writeLifecycleAppInfo(t, client.AppPath, AppInfo{Port: 5000, Token: "current-token", PID: 2, StartedAt: "2026-10-21T00:01:00Z"})
	if err := client.RunMenuAction(context.Background(), env, "fix"); err != nil { t.Fatal(err) }
	if !strings.HasPrefix(opened, "http://127.0.0.1:5000/auth/handoff?") { t.Fatal("Review did not open the current app") }
}

// The command package owns the OS boundary. Keep its wiring tied to the tested
// helpers without requiring a real desktop or adding a test file outside scope.
func TestTrayLifecycleUsesTestedBoundaries(t *testing.T) {
	source, err := parser.ParseFile(token.NewFileSet(), "../../cmd/faravan-tray/main.go", nil, 0)
	if err != nil { t.Fatal(err) }
	want := map[string]string{"action": "RunMenuAction", "announceHealth": "RunMenuAction", "refresh": "Refresh", "sessionBusHasOwner": "CallWithContext"}
	for _, decl := range source.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok { continue }
		method, needed := want[fn.Name.Name]
		if !needed { continue }
		found := false
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok { return true }
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != method { return true }
			if method == "RunMenuAction" || method == "Refresh" {
				client, ok := sel.X.(*ast.SelectorExpr)
				if !ok || client.Sel.Name != "client" { return true }
			}
			if len(call.Args) > 0 {
				ctx, ok := call.Args[0].(*ast.Ident)
				found = found || (ok && ctx.Name == "ctx")
			}
			return true
		})
		if !found { t.Errorf("%s must use %s with its context", fn.Name.Name, method) }
		delete(want, fn.Name.Name)
	}
	if len(want) != 0 { t.Fatal("missing production lifecycle boundaries", want) }
}
