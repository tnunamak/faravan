package faravantray

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestCleanupRowAndRetry(t *testing.T) {
	var status AppStatus
	if err := json.Unmarshal([]byte(`{"state":"ready","cleanup":{"items":[{"name":"wf-0000000000000001","message":"Sandbox wf-0000000000000001 still has access rules left. Choose Clean up now to retry."}]}}`), &status); err != nil {
		t.Fatal(err)
	}
	for _, platform := range []string{"linux", "darwin", "windows"} {
		menu := build(platform, status)
		count := 0
		for _, entry := range menu.Entries {
			if strings.Contains(entry.Label, "wf-0000000000000001") {
				count++
				if len(entry.Children) != 1 || entry.Children[0].ID != "cleanup-retry" || entry.Children[0].Label != "Clean up now" {
					t.Fatal(entry)
				}
			}
		}
		if count != 1 {
			t.Fatalf("%s: cleanup row missing or repeated: %v", platform, menu.Entries)
		}
	}
	var calls []string
	client := AppClient{HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls = append(calls, req.Method+" "+req.URL.Path)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"items":[{"message":"Sandbox wf-0000000000000001 still has access rules left."}]}`)), Header: http.Header{}}, nil
	})}}
	err := RunMenuAction(context.Background(), ActionEnv{Client: client, Info: AppInfo{Port: 1234, Token: "fixture"}}, "cleanup-retry")
	if err == nil || !strings.Contains(err.Error(), "access rules left") {
		t.Fatalf("remaining debt must be explained: %v", err)
	}
	if len(calls) != 1 || calls[0] != "POST /api/cleanup/retry" {
		t.Fatal(calls)
	}
}
