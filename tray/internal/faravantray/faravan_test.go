package faravantray

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func appRecord(port int) string {
	return fmt.Sprintf(`{"port":%d,"token":"app token&secret","pid":42,"started_at":"2026-10-09T09:00:00.000Z"}`, port)
}
func writeRecord(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil { t.Fatal(err) }
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil { t.Fatal(err) }
}
func TestAppInfoDiscovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v1", "app.json")
	if _, err := ReadAppInfo(path, func(int) bool { return true }); !errors.Is(err, os.ErrNotExist) { t.Fatalf("missing: %v", err) }
	for name, record := range map[string]string{
		"malformed":"{", "port":strings.Replace(appRecord(1234), "1234", "65536", 1),
		"token":strings.Replace(appRecord(1234), "app token&secret", "", 1),
		"pid":strings.Replace(appRecord(1234), `"pid":42`, `"pid":0`, 1),
		"timestamp":strings.Replace(appRecord(1234), "2026-10-09T09:00:00.000Z", "yesterday", 1),
	} {
		t.Run(name, func(t *testing.T) {
			writeRecord(t, path, record)
			if _, err := ReadAppInfo(path, func(int) bool { return true }); err == nil { t.Fatal("accepted invalid record") }
		})
	}
	writeRecord(t, path, appRecord(1234))
	if _, err := ReadAppInfo(path, func(int) bool { return false }); !errors.Is(err, ErrStaleApp) { t.Fatalf("stale: %v", err) }
	info, err := ReadAppInfo(path, func(pid int) bool { return pid == 42 })
	if err != nil || info.Port != 1234 { t.Fatalf("valid record: %#v %v", info, err) }
	t.Setenv("FARAVAN_HOME", t.TempDir())
	want := filepath.Join(os.Getenv("FARAVAN_HOME"), "v1", "app.json")
	if got, err := AppInfoPath(); err != nil || got != want { t.Fatalf("home override: %s %v", got, err) }
	if !ProcessAlive(os.Getpid()) || ProcessAlive(0) { t.Fatal("process liveness") }
}
func TestExactlyThreeIcons(t *testing.T) {
	icons := [][]byte{IconPNG(VisualActive), IconPNG(VisualIdle), IconPNG(VisualAttention)}
	for i := range icons { for j := i+1; j<len(icons); j++ { if bytes.Equal(icons[i], icons[j]) { t.Fatal("icons are not distinct") } } }
}
type roundTripFunc func(*http.Request) (*http.Response, error)
func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func appHTTP(t *testing.T, handler func(*http.Request) string) *http.Client {
	t.Helper()
	return &http.Client{Transport:roundTripFunc(func(r *http.Request) (*http.Response,error) {
		return &http.Response{StatusCode:200,Body:io.NopCloser(strings.NewReader(handler(r))),Header:make(http.Header)},nil
	})}
}
func hasEntry(m Menu, id string) bool {
	for _, e := range m.Entries { if e.ID == id { return true } }
	return false
}
func TestAppClientTokenAndControls(t *testing.T) {
	var paths []string
	client := AppClient{HTTPClient:appHTTP(t, func(r *http.Request) string {
		if r.URL.Host != "127.0.0.1:1234" || r.Header.Get("X-Faravan-Session-Token") != "secret" || r.URL.RawQuery != "" { t.Errorf("unsafe request: %s", r.URL.Path) }
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Method == "POST" {
			body, _ := io.ReadAll(r.Body)
			if string(body) != "{}" || r.Header.Get("Content-Type") != "application/json" { t.Error("invalid POST body") }
		}
		return `{"iconState":"Paused"}`
	})}
	info := AppInfo{Port:1234,Token:"secret"}
	if _, err := client.Status(context.Background(), info); err != nil { t.Fatal(err) }
	for _, enabled := range []bool{false,true} { if err := client.SetLending(context.Background(), info, enabled); err != nil { t.Fatal(err) } }
	want := []string{"GET /api/home","POST /api/lending/pause","POST /api/lending/resume"}
	if !reflect.DeepEqual(paths,want) { t.Fatal(paths) }
}
func TestDiscoveryNeverFallsBackToV0(t *testing.T) {
	directory := t.TempDir()
	c := LocalClient{AppPath:filepath.Join(directory,"v1","app.json"),Alive:func(int) bool{return true}}
	// A v0 daemon record must be ignored entirely, even beside a stale app.
	writeRecord(t,filepath.Join(directory,"daemon.json"),`{"port":1235,"token":"legacy"}`)
	v1calls := 0
	c.AppClient.HTTPClient = appHTTP(t, func(r *http.Request) string { v1calls++; return `{"iconState":"Paused"}` })
	writeRecord(t,c.AppPath,appRecord(1234))
	connection := c.Discover(context.Background())
	if connection.App == nil || v1calls != 2 || connection.Menu.State != VisualPaused { t.Fatal("live app not used") }
	c.AppClient.HTTPClient = &http.Client{Transport:roundTripFunc(func(*http.Request)(*http.Response,error){return nil,errors.New("offline")})}
	connection = c.Discover(context.Background())
	if connection.App == nil || hasEntry(connection.Menu, "start") || !hasEntry(connection.Menu, "open") || connection.Menu.State != VisualAttention { t.Fatal("live unreachable app offered Start or lost Open") }
	c.Alive = func(int)bool{return false}
	connection = c.Discover(context.Background())
	if connection.App != nil || !hasEntry(connection.Menu, "start") || hasEntry(connection.Menu, "open") { t.Fatal("stale app must offer Start only") }
	if err := os.Remove(c.AppPath); err != nil { t.Fatal(err) }
	if connection = c.Discover(context.Background()); connection.App != nil || !hasEntry(connection.Menu, "start") { t.Fatal("missing app must offer Start") }
	writeRecord(t,c.AppPath,"{")
	connection = c.Discover(context.Background())
	if hasEntry(connection.Menu, "start") || connection.App != nil { t.Fatal("malformed record asserted stopped") }
	if err := os.Remove(c.AppPath); err != nil { t.Fatal(err) }
	connection = c.Discover(context.Background())
	if !reflect.DeepEqual(connection.Menu.Labels(),[]string{"We can't connect to Faravan on this computer.","Start Faravan","Quit"}) { t.Fatal(connection.Menu.Labels()) }
	if err := c.SetLending(context.Background(), connection, true); err == nil { t.Fatal("control without an app succeeded") }
	if err := OpenConnection(connection, func(string) error { t.Fatal("opened without an app"); return nil }); err == nil { t.Fatal("open without an app succeeded") }
}
func TestHomePathMirrorsNodeConfigHome(t *testing.T) {
  t.Setenv("FARAVAN_HOME", "")
  t.Setenv("FARAVAN_DATA_HOME", "")
  home := t.TempDir()
  t.Setenv("HOME", home)
  t.Setenv("XDG_DATA_HOME", "")
  want := filepath.Join(home, ".local", "share", "Faravan")
  if runtime.GOOS == "darwin" { want = filepath.Join(home, "Library", "Application Support", "Faravan") }
  if runtime.GOOS == "windows" { want = filepath.Join(windowsDataBase(os.Getenv("LOCALAPPDATA"), home), "Faravan") }
  if got, err := HomePath(); err != nil || got != want { t.Fatalf("default: %s %v", got, err) }
  t.Setenv("FARAVAN_HOME", "override")
  if got, err := HomePath(); err != nil || got != "override" { t.Fatalf("override: %s %v", got, err) }
}

func TestHomePathHonorsCanonicalDataFolder(t *testing.T) {
	t.Setenv("FARAVAN_HOME", "")
	t.Setenv("FARAVAN_HOME", "")
	want := filepath.Join(t.TempDir(), "preview")
	t.Setenv("FARAVAN_DATA_HOME", want)
	if got, err := HomePath(); err != nil || got != want {
		t.Fatalf("canonical data folder: %s %v", got, err)
	}
	t.Setenv("FARAVAN_DATA_HOME", "relative/path")
	if _, err := HomePath(); err == nil {
		t.Fatal("relative canonical data folder accepted")
	}
}
func TestTooltipsCoverEveryState(t *testing.T) {
	for state, want := range map[VisualState]string{VisualActive:"Faravan — On or finishing a job",VisualIdle:"Faravan — Off or paused",VisualAttention:"Faravan — Needs you"} {
		if got := TooltipForVisualState(state); got != want { t.Errorf("%s: %q", state, got) }
	}
}
func TestStartAndOpenUseInjectedBoundaries(t *testing.T) {
	c := LocalClient{AppPath:filepath.Join(t.TempDir(),"app.json"),Alive:func(int)bool{return true}}
	starts := 0
	ctx,cancel := context.WithTimeout(context.Background(),time.Second)
	defer cancel()
	_,err := c.StartAndWait(ctx,func()error{starts++;writeRecord(t,c.AppPath,appRecord(1234));return nil})
	if err != nil || starts != 1 { t.Fatalf("start: %d %v",starts,err) }
	if _,err := c.StartAndWait(ctx,func()error{starts++;return nil});err != nil || starts != 1 { t.Fatal("duplicate start") }
	opens := 0
	err = OpenConnection(Connection{App:&AppInfo{Port:fakeAppHandoff(t),Token:"app token&secret"}},func(raw string)error {
		opens++
		u,err := url.Parse(raw)
		if err != nil || u.Path != "/auth/handoff" || u.Query().Get("code") != "one-time" { t.Fatalf("opened URL is not a one-time handoff link (path %q)", u.Path) }
		if u.Query().Has("token") || strings.Contains(raw,"app token") { t.Fatal("the session token reached the opener") }
		return nil
	})
	if err != nil || opens != 1 { t.Fatal("open boundary") }
	if err := os.Remove(c.AppPath); err != nil { t.Fatal(err) }
	want := errors.New("launch failed")
	if _,err := c.StartAndWait(ctx,func()error{return want}); !errors.Is(err,want) { t.Fatal(err) }
	short,stop := context.WithCancel(context.Background());stop()
	if _,err := c.StartAndWait(short,func()error{return nil});err == nil { t.Fatal("missing startup timeout") }
}

// fakeAppHandoff stands in for the running app's POST /api/handoff: it answers with a one-time link on its own origin.
func fakeAppHandoff(t *testing.T) int {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/handoff" { http.NotFound(w, r); return }
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"url":"http://%s/auth/handoff?code=one-time"}`, r.Host)
	}))
	t.Cleanup(server.Close)
	u, err := url.Parse(server.URL)
	if err != nil { t.Fatal(err) }
	port, err := strconv.Atoi(u.Port())
	if err != nil { t.Fatal(err) }
	return port
}
func TestOpenFaravanOpensOneTimeHandoffNotSessionURL(t *testing.T) {
	var opened []string
	err := OpenConnection(Connection{App:&AppInfo{Port:fakeAppHandoff(t),Token:"private-session-token"}}, func(raw string) error { opened = append(opened, raw); return nil })
	if err != nil || len(opened) != 1 { t.Fatalf("open: %v (%d opens)", err, len(opened)) }
	u, err := url.Parse(opened[0])
	if err != nil { t.Fatal(err) }
	if u.Path != "/auth/handoff" || u.Query().Get("code") != "one-time" { t.Fatalf("path %q, code %q", u.Path, u.Query().Get("code")) }
	if u.RawQuery != "code=one-time" || strings.Contains(opened[0], "private-session-token") { t.Fatal("the session token is in the opened URL") }
}
func TestBrowserErrorsNeverRevealSessionURL(t *testing.T) {
	info := AppInfo{Port:1234,Token:"private-token"}
	err := OpenConnection(Connection{App:&info},func(raw string)error{return fmt.Errorf("failed to open %s",raw)})
	if err == nil || strings.Contains(err.Error(),"private-token") || strings.Contains(err.Error(),"http:") { t.Fatalf("unsafe error: %v",err) }
}
func TestAppClientNeverForwardSessionTokensOnRedirect(t *testing.T) {
	calls := 0
	httpClient := &http.Client{Transport:roundTripFunc(func(r *http.Request)(*http.Response,error) {
		calls++
		return &http.Response{StatusCode:302,Header:http.Header{"Location":[]string{"http://example.invalid/redirect"}},Body:io.NopCloser(strings.NewReader("secret in response body"))},nil
	})}
	if _,err := (AppClient{HTTPClient:httpClient}).Status(context.Background(),AppInfo{Port:1234,Token:"secret"});err == nil || strings.Contains(err.Error(),"secret") { t.Fatal("app redirect/error handling") }
	if calls != 1 { t.Fatalf("followed redirect: %d requests",calls) }
}

func TestLinuxDiscoveryRejectsReusedPIDButKeepsUnresponsiveLiveApp(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux process identity") }
	path := filepath.Join(t.TempDir(), "app.json")
	record := func(started time.Time) string {
		return fmt.Sprintf(`{"port":1234,"token":"test-token","pid":%d,"started_at":%q}`, os.Getpid(), started.Format(time.RFC3339Nano))
	}
	// The PID is alive, but belongs to a process born after the recorded app.
	writeRecord(t, path, record(time.Unix(1, 0)))
	if _, err := ReadAppInfo(path, nil); !errors.Is(err, ErrStaleApp) { t.Errorf("reused PID accepted: %v", err) }
	writeRecord(t, path, record(time.Now()))
	if _, err := ReadAppInfo(path, nil); err != nil { t.Fatalf("current process rejected: %v", err) }
	client := LocalClient{AppPath:path, AppClient:AppClient{HTTPClient:&http.Client{Transport:roundTripFunc(func(*http.Request)(*http.Response,error) {
		return nil, errors.New("unresponsive")
	})}}}
	connection := client.Discover(context.Background())
	if connection.App == nil || hasEntry(connection.Menu, "start") || !hasEntry(connection.Menu, "open") {
		t.Fatal("a live unresponsive process must remain live and must not offer Start")
	}
	starts := 0
	if _, err := client.StartAndWait(context.Background(), func() error { starts++; return nil }); err != nil || starts != 0 {
		t.Fatalf("live unresponsive process restarted: starts=%d err=%v", starts, err)
	}
}

func TestLinuxZombieIsNotRunning(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux zombie state") }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	child := lifecycleChild(t, ctx, t.TempDir(), "zombie")
	if err := child.Start(); err != nil { t.Fatal(err) }
	defer child.Wait()
	pid := child.Process.Pid
	deadline := time.Now().Add(3*time.Second)
	for {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil { t.Fatal(err) }
		end := strings.LastIndexByte(string(data), ')')
		if end >= 0 {
			fields := strings.Fields(string(data)[end+1:])
			if len(fields) > 0 && fields[0] == "Z" { break }
		}
		if time.Now().After(deadline) { t.Fatal("child did not become a zombie") }
		time.Sleep(5*time.Millisecond)
	}
	if ProcessAlive(pid) { t.Error("zombie accepted as live by ProcessAlive") }
	path := filepath.Join(t.TempDir(), "app.json")
	writeRecord(t, path, fmt.Sprintf(`{"port":1234,"token":"test-token","pid":%d,"started_at":%q}`, pid, time.Now().Format(time.RFC3339Nano)))
	if _, err := ReadAppInfo(path, nil); !errors.Is(err, ErrStaleApp) { t.Errorf("zombie discovery accepted: %v", err) }
}
