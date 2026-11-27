package faravantray

import (
    "context"
    "errors"
    "net/http"
    "testing"
)

func TestQuitConnectionDuringStartupBackoff(t *testing.T) {
    for _, mode := range []string{"missing", "stale", "malformed", "unreachable"} {
        t.Run(mode, func(t *testing.T) {
            c := failureClient(t)
            if mode != "missing" { writeRecord(t, c.AppPath, appRecord(1234)) }
            if mode == "stale" { c.Alive = func(int) bool { return false } }
            if mode == "malformed" { writeRecord(t, c.AppPath, "{") }
            c.AppClient.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("PRIVATE_RAW_ERROR") })}
            connection := c.Discover(context.Background())
            called := 0
            unavailable := errors.New("status unavailable")
            quit, err := RunConnectionQuit(context.Background(), connection, QuitFlow{Status: func(context.Context) (AppStatus, error) { called++; return AppStatus{}, unavailable }})
            if mode == "unreachable" {
                if quit || !errors.Is(err, unavailable) || called != 1 || connection.App == nil { t.Fatal("live unreachable app bypassed shutdown protection") }
            } else if !quit || err != nil || called != 0 { t.Fatalf("offline Quit must immediately close the tray: %v %v %d", quit, err, called) }
        })
    }
}

func TestQuitConnectionRetainsLiveConfirmationAndShutdown(t *testing.T) {
	c := failureClient(t)
	writeRecord(t, c.AppPath, appRecord(1234))
	status := AppStatus{IconState: "Paused"}
	info, err := ReadAppInfo(c.AppPath, c.Alive)
	if err != nil { t.Fatal(err) }
	connection := Connection{App: &info}
	asked, calls := 0, 0
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		calls++
		if r.URL.Path != "/api/shutdown" || r.Method != "POST" || r.Header.Get("X-Faravan-Session-Token") != info.Token { t.Fatal("wrong shutdown route") }
		return `{}`
	})}
	flow := QuitFlow{Env: QuitEnv{Client: client, Alive: func(int) bool { return false }}, Status: func(context.Context) (AppStatus, error) { return status, nil }, Ask: func(QuitPrompt) (QuitChoice, error) { asked++; return QuitCancel, nil }}
	quit, err := RunConnectionQuit(context.Background(), connection, flow)
	if quit || err != nil || asked != 1 || calls != 0 { t.Fatal("Cancel must retain the live app") }
	flow.Ask = func(QuitPrompt) (QuitChoice, error) { asked++; return QuitNow, nil }
	quit, err = RunConnectionQuit(context.Background(), connection, flow)
	if !quit || err != nil || asked != 2 || calls != 1 { t.Fatal("confirmed live Quit must use authenticated shutdown") }
}
