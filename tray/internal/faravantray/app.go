package faravantray

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// AppInfo is the private v1 discovery record; the token never enters menu text.
type AppInfo struct {
	Port int `json:"port"`
	Token string `json:"token"`
	PID int `json:"pid"`
	StartedAt string `json:"started_at"`
}

func AppInfoPath() (string, error) {
	home, err := HomePath()
	if err != nil { return "", err }
	return filepath.Join(home, "v1", "app.json"), nil
}

var ErrStaleApp = errors.New("Faravan app process is no longer running")

// Platform hooks keep Windows behavior unchanged; Linux installs kernel-backed
// locks and discovery validation before main can initialize the tray.
var trayInstanceLock = func() (func(), bool, error) { return func() {}, true, nil }
var appLaunchLock = func(context.Context) (func(), error) { return func() {}, nil }
var appProcessAlive = func(info AppInfo) (bool, error) { return ProcessAlive(info.PID), nil }

// RunTrayInstance owns the complete tray initialization and run lifetime.
// A second instance returns successfully without registering an icon or poller.
func RunTrayInstance(run func()) error {
	unlock, acquired, err := trayInstanceLock()
	if err != nil { return err }
	if !acquired { return nil }
	defer unlock()
	run()
	return nil
}

func ReadAppInfo(path string, alive func(int) bool) (AppInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil { return AppInfo{}, err }
	var info AppInfo
	if err := json.Unmarshal(data, &info); err != nil { return AppInfo{}, errors.New("invalid Faravan app discovery record") }
	if info.Port < 1 || info.Port > 65535 || strings.TrimSpace(info.Token) == "" || info.PID <= 0 {
		return AppInfo{}, errors.New("invalid Faravan app discovery record")
	}
	if _, err := time.Parse(time.RFC3339Nano, info.StartedAt); err != nil { return AppInfo{}, errors.New("invalid Faravan app start time") }
	if alive != nil {
		if !alive(info.PID) { return AppInfo{}, ErrStaleApp }
	} else {
		live, err := appProcessAlive(info)
		if err != nil { return AppInfo{}, err }
		if !live { return AppInfo{}, ErrStaleApp }
	}
	return info, nil
}

// NeedsYou is one item on the separate "needs you" axis of the effective state.
type NeedsYou struct {
	Kind string `json:"kind"`
	ApprovalID string `json:"approvalId"`
	Agent string `json:"agent"`
}

// BlockerModel is the ordered model returned by /api/home, not the legacy
// blockers array of reason codes. Copy comes from the app, as in trayLines.
type BlockerItem struct {
	Key string `json:"key"`
	Agent string `json:"agent"`
	Label string `json:"label"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Action string `json:"action"`
}
type BlockerModel struct {
	Headline string `json:"headline"`
	First *BlockerItem `json:"first"`
	Items []BlockerItem `json:"items"`
	NeedsYou []BlockerItem `json:"needsYou"`
	CanLend bool `json:"canLend"`
}

type CleanupItem struct {
	Name string `json:"name"`
	Message string `json:"message"`
}

type AppStatus struct {
	Cleanup struct {
		Items []CleanupItem `json:"items"`
	} `json:"cleanup"`
	// Optional update metadata must not make an otherwise valid home response unreadable.
	UpdateStatus json.RawMessage `json:"updateStatus"`
 LendingStopped *LendingStopped `json:"lendingStopped"`
	Host *struct { LastReachedAt string `json:"lastReachedAt"` } `json:"host"`
	LendingBlockers *BlockerModel `json:"lending_blockers"`
	Blockers json.RawMessage `json:"blockers"`
	Intent *struct {
		On bool `json:"on"`
		State string `json:"state"`
		Until *float64 `json:"until"`
	} `json:"intent"`
	// The effective state (S1.1): one state, one reason, an optional end time in
	// epoch milliseconds, and what needs the lender. IconState is the older projection.
	State string `json:"state"`
	Reason string `json:"reason"`
	Until *float64 `json:"until"`
	NeedsYou []NeedsYou `json:"needs_you"`
	// Intent and Execution are the two axes of S1.1b: what lending is set to do, and what runs now.
	// A running job shows whatever the intent says. Headline is the server's one-line text for both.
	Execution struct {
		State string `json:"state"` // idle, running, finishing, stopping
		Job string `json:"job"` // the attempt id
		Person string `json:"person"`
		StopsBy *float64 `json:"stops_by"`
	} `json:"execution"`
	Headline string `json:"headline"`
	// Setup is D8: a step (Windows hypervisor, Linux kvm group) waiting for a restart or log-out.
	Setup struct {
		Resume *struct {
			Step string `json:"step"`
			State string `json:"state"` // waiting, returned
		} `json:"resume"`
	} `json:"setup"`
	ActiveCircle string `json:"activeCircle"`
	// ChatgptPending counts remote ChatGPT actions that wait for the lender; the tray reads the list only when it is above 0.
	ChatgptPending int `json:"chatgpt_pending"`
	// RunningJob names who the running job is for. Optional: an older app does not send it.
	RunningJob *struct {
		Requester string `json:"requester"`
		Title string `json:"title"`
	} `json:"runningJob"`
	// Today is the counted use against today's limits; nil until the lender has counters.
	Today *struct {
		Jobs int `json:"jobs"`
		JobLimit int `json:"jobLimit"`
		Minutes int `json:"minutes"`
		MinuteLimit int `json:"minuteLimit"`
	} `json:"today"`
	IconState string `json:"iconState"`
	Lending struct {
		Enabled bool `json:"enabled"`
		Label string `json:"label"`
	} `json:"lending"`
	CurrentJob json.RawMessage `json:"currentJob"`
	Attention []struct { Label string `json:"label"` } `json:"attention"`
	Circles []struct {
		ID string `json:"id"`
		Name string `json:"name"`
	} `json:"circles"`
}

func VisualStateForAppState(state string) VisualState {
	switch state {
	case "Lending on": return VisualActive
	case "Paused": return VisualIdle
	default: return VisualAttention
	}
}

type AppClient struct { HTTPClient *http.Client }

// HTTPError is a non-2xx answer from the app.
type HTTPError struct {
	Status int
	Code string
}
func (e *HTTPError) Error() string { return fmt.Sprintf("Faravan returned HTTP %d", e.Status) }

func (c AppClient) request(ctx context.Context, info AppInfo, method, endpoint string) (*http.Response, error) {
	return c.requestBody(ctx, info, method, endpoint, "{}")
}
func (c AppClient) requestBody(ctx context.Context, info AppInfo, method, endpoint, payload string) (*http.Response, error) {
	var body *strings.Reader
	if method == http.MethodPost { body = strings.NewReader(payload) } else { body = strings.NewReader("") }
	req, err := http.NewRequestWithContext(ctx, method, localURL(info.Port, endpoint), body)
	if err != nil { return nil, err }
	req.Header.Set("X-Faravan-Session-Token", info.Token)
	if method == http.MethodPost { req.Header.Set("Content-Type", "application/json") }
	client := c.HTTPClient
	if client == nil { client = &http.Client{} } // every caller bounds the call with its own context
	// Never send the local session secret to a redirect destination.
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := copyClient.Do(req)
	if err != nil { return nil, errors.New("cannot connect to Faravan on this computer") }
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// The app's problem code (job_running, no_current_job, ...) is safe to keep; its text is not shown.
		var problem struct { Code string `json:"code"` }
		_ = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&problem)
		response.Body.Close()
		return nil, &HTTPError{Status: response.StatusCode, Code: problem.Code}
	}
	return response, nil
}
func (c AppClient) Status(ctx context.Context, info AppInfo) (AppStatus, error) {
	response, err := c.request(ctx, info, http.MethodGet, "/api/home")
	if err != nil { return AppStatus{}, err }
	defer response.Body.Close()
	var status AppStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil { return AppStatus{}, errors.New("Faravan status is unavailable") }
	return status, nil
}

// Approvals lists the jobs that wait for the lender's review.
func (c AppClient) Approvals(ctx context.Context, info AppInfo) ([]ApprovalCard, error) {
	response, err := c.request(ctx, info, http.MethodGet, "/api/approvals")
	if err != nil { return nil, err }
	defer response.Body.Close()
	var cards []ApprovalCard
	if err := json.NewDecoder(response.Body).Decode(&cards); err != nil { return nil, errors.New("Faravan requests are unavailable") }
	return cards, nil
}

// ChatgptApprovals lists the remote ChatGPT actions that wait for the lender. Ids get the "chatgpt:" prefix.
// The app sends only a static title and the effect; no peer prompt text is in the answer.
func (c AppClient) ChatgptApprovals(ctx context.Context, info AppInfo) ([]ApprovalCard, error) {
	response, err := c.request(ctx, info, http.MethodGet, "/api/chatgpt/actions")
	if err != nil { return nil, err }
	defer response.Body.Close()
	var actions []struct {
		ID string `json:"id"`
		Label string `json:"label"`
		What string `json:"what"`
		ExpiresAt float64 `json:"expiresAt"`
	}
	if err := json.NewDecoder(response.Body).Decode(&actions); err != nil { return nil, errors.New("Faravan ChatGPT requests are unavailable") }
	cards := make([]ApprovalCard, 0, len(actions))
	for _, a := range actions {
		if strings.TrimSpace(a.ID) == "" { continue }
		cards = append(cards, ApprovalCard{ID: ChatgptPrefix + a.ID, Kind: ChatgptKind, Label: a.Label, What: a.What, ExpiresAt: a.ExpiresAt})
	}
	return cards, nil
}

// Decline answers "Not now". It never accepts, so no job can start from it.
func (c AppClient) Decline(ctx context.Context, info AppInfo, id string) error {
	endpoint := "/api/approvals/" + url.PathEscape(id) + "/skip"
	if uuid, ok := strings.CutPrefix(id, ChatgptPrefix); ok { endpoint = "/api/chatgpt/actions/" + url.PathEscape(uuid) + "/decline" }
	response, err := c.request(ctx, info, http.MethodPost, endpoint)
	if err != nil { return err }
	response.Body.Close()
	return nil
}

// Handoff returns a one-time sign-in link for the browser; it never carries the session token.
func (c AppClient) Handoff(ctx context.Context, info AppInfo) (string, error) {
	response, err := c.request(ctx, info, http.MethodPost, "/api/handoff")
	if err != nil { return "", err }
	defer response.Body.Close()
	var body struct { URL string `json:"url"` }
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.URL == "" { return "", errors.New("Faravan did not give a sign-in link") }
	return body.URL, nil
}
// ReportTray tells the app whether this desktop has a status area for the icon.
func (c AppClient) ReportTray(ctx context.Context, info AppInfo, available bool) error {
	response, err := c.requestBody(ctx, info, http.MethodPost, "/api/desktop/tray", fmt.Sprintf(`{"tray":%t}`, available))
	if err != nil { return err }
	response.Body.Close()
	return nil
}
func (c AppClient) SetLending(ctx context.Context, info AppInfo, enabled bool) error {
	endpoint := "/api/lending/pause"
	if enabled { endpoint = "/api/lending/resume" }
	response, err := c.request(ctx, info, http.MethodPost, endpoint)
	if err != nil { return err }
	response.Body.Close()
	return nil
}

// Connection is a live v1 app, even when its API is unavailable, or nothing.
type Connection struct {
 AppGone bool // a verified app process exit; an unreadable discovery record is unknown
 Status *AppStatus
	App *AppInfo
	Menu Menu
	Cards []ApprovalCard // jobs waiting for the lender, for the menu and notifications
	CardsKnown bool // false when the approvals read failed: "unknown" is not "nobody is waiting"
	Circles map[string]string // circle id to name
}
type LocalClient struct {
	AppPath string
	Alive func(int) bool
	AppClient AppClient
}
func (c LocalClient) Discover(ctx context.Context) Connection {
	return c.discover(ctx, time.Now(), time.Local, runtime.GOOS)
}
func (c LocalClient) discover(ctx context.Context, now time.Time, loc *time.Location, goos string) Connection {
	offlineLine := startFailureLine(c.AppPath)
	info, err := ReadAppInfo(c.AppPath, c.Alive)
	if err == nil {
		connection := Connection{App:&info, Menu:Menu{State:VisualAttention, Status:offlineLine, Entries:[]Entry{
			{ID:"status", Label:offlineLine, Disabled:true}, {ID:"open", Label:"Open Faravan"}, {Separator:true}, {ID:"quit", Label:"Quit"}}}}
		if status, err := c.AppClient.Status(ctx, info); err == nil {
   connection.Status = &status
			connection.Circles = map[string]string{}
			for _, circle := range status.Circles { connection.Circles[circle.ID] = circle.Name }
			// A failed approvals read only hides the request lines; the state is still true.
			if cards, err := c.AppClient.Approvals(ctx, info); err == nil { connection.Cards, connection.CardsKnown = cards, true }
			if status.ChatgptPending > 0 {
				// A failed ChatGPT read makes the whole list unknown, so the tracker never reports a false "gone".
				if extra, err := c.AppClient.ChatgptApprovals(ctx, info); err == nil { connection.Cards = append(connection.Cards, extra...) } else { connection.CardsKnown = false }
			}
			connection.Menu = BuildMenu(MenuInput{Status:status, Cards:connection.Cards, Circles:connection.Circles, Now:now, Loc:loc, GOOS:goos})
		}
		return connection
	}
	// A malformed record is not evidence that its process stopped.
	stopped := errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrStaleApp)
	entries := []Entry{{ID:"status", Label:offlineLine, Disabled:true}}
	if stopped { entries = append(entries, Entry{ID:"start", Label:"Start Faravan"}) }
	return Connection{AppGone:errors.Is(err, ErrStaleApp), Menu:Menu{State:VisualAttention, Status:entries[0].Label, Entries:append(entries, Entry{Separator:true}, Entry{ID:"quit", Label:"Quit"})}}
}
func (c LocalClient) SetLending(ctx context.Context, connection Connection, enabled bool) error {
	if connection.App == nil { return errors.New("Faravan is unavailable") }
	return c.AppClient.SetLending(ctx, *connection.App, enabled)
}
// OpenConnection opens the app's home through a one-time sign-in link. The session token never leaves the handoff request header.
func OpenConnection(connection Connection, openURL func(string) error) error {
	if connection.App == nil { return errors.New("Faravan is unavailable") }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	link, err := AppClient{}.Handoff(ctx, *connection.App)
	if err != nil { return errors.New("could not get a sign-in link for Faravan") }
	if err := openURL(link + routes["open"]); err != nil { return errors.New("could not open Faravan in the default browser") }
	return nil
}

// CurrentApp re-reads the discovery record when a menu or notification is clicked. The app may have
// restarted (every update does) since the notification was shown, with a new port and token;
// the click must reach the app that runs now. Without a valid record it keeps the old one.
func (c LocalClient) CurrentApp(shown AppInfo) AppInfo {
	if info, err := ReadAppInfo(c.AppPath, c.Alive); err == nil { return info }
	return shown
}
// StartAndWait injects the launch boundary; tests never execute a real app.
// A stale/missing record is required. An unresponsive live app must not restart.
func (c LocalClient) StartAndWait(ctx context.Context, launch func() error) (AppInfo, error) {
	if err := ctx.Err(); err != nil { return AppInfo{}, err }
	unlock, err := appLaunchLock(ctx)
	if err != nil { return AppInfo{}, err }
	defer unlock()
	if err := ctx.Err(); err != nil { return AppInfo{}, err }
	// Re-read only after taking the lock, and hold it until discovery is ready.
	info, err := ReadAppInfo(c.AppPath, c.Alive)
	if err == nil { return info, nil }
	if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, ErrStaleApp) { return AppInfo{}, err }
	if err := launch(); err != nil { return AppInfo{}, err }
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if info, err := ReadAppInfo(c.AppPath, c.Alive); err == nil { return info, nil }
		select {
		case <-ctx.Done(): return AppInfo{}, errors.New("Faravan did not become available before the start timeout")
		case <-ticker.C:
		}
	}
}

// ReportPresence sends an observation made in the user's desktop session.
func (c AppClient) ReportPresence(ctx context.Context, info AppInfo, idleSeconds *float64) error {
 body, err := json.Marshal(struct { IdleSeconds *float64 `json:"idleSeconds"` }{idleSeconds})
 if err != nil { return err }
 response, err := c.requestBody(ctx, info, http.MethodPost, "/api/desktop/presence", string(body))
 if err != nil { return err }
 response.Body.Close()
 return nil
}


// RunMenuAction resolves the current app once at click time, not at menu draw or
// notification display time. It never retries a mutation after an uncertain
// failure, and leaves the selected attempt in id unchanged. Stop/quit retain
// their separate attempt-bound confirmation flows.
func (c LocalClient) RunMenuAction(ctx context.Context, env ActionEnv, id string) error {
	if err := ctx.Err(); err != nil { return err }
	env.Info = c.CurrentApp(env.Info)
	return RunMenuAction(ctx, env, id)
}

// Refresh holds the menu mutex only while publishing the discovered state.
// Discovery and desktop probes share the caller's deadline but never prevent
// Quit from taking a snapshot. Probe callbacks protect their own tracker state.
func (c LocalClient) Refresh(ctx context.Context, menuMu sync.Locker, update func(Connection), probe func(context.Context, Connection)) {
	connection := c.Discover(ctx)
	menuMu.Lock()
	update(connection)
	menuMu.Unlock()
	probe(ctx, connection)
}
