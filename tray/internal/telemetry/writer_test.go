package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

var clockAt = time.Date(2026, 10, 21, 19, 20, 0, 0, time.UTC)

// Invoked by the Node producer-boundary journey with the same policy and inbox as the app.
func TestPrivacyJourneyWriter(t *testing.T) {
	dir := os.Getenv("FARAVAN_PRIVACY_TEST_DIR")
	if dir == "" {
		t.Skip("only used by the Node producer journey")
	}
	w := Writer{Dir: dir, Now: clock(clockAt)}
	if err := w.Panic(time.Second); err != nil {
		t.Fatal(err)
	}
	if err := w.AppUnreachable(clockAt); err != nil {
		t.Fatal(err)
	}
}

// isolate gives the test its own HOME, so nothing reads or writes the real one.
func isolate(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func clock(at time.Time) func() time.Time { return func() time.Time { return at } }

func environ(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}

func writePolicy(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "policy.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// inboxFiles lists the finished inbox files, and fails if a temporary name was left behind.
func inboxFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "inbox"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary file left in inbox: %s", entry.Name())
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func onlyInboxFile(t *testing.T, dir string) []byte {
	t.Helper()
	names := inboxFiles(t, dir)
	if len(names) != 1 {
		t.Fatalf("want one inbox file, got %v", names)
	}
	body, err := os.ReadFile(filepath.Join(dir, "inbox", names[0]))
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func golden(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "telemetry", "golden", name))
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func genOf(t *testing.T, body []byte) int64 {
	t.Helper()
	var file struct {
		Gen int64 `json:"gen"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatal(err)
	}
	return file.Gen
}

func crashLoopOf(t *testing.T, body []byte) bool {
	t.Helper()
	var file struct {
		Record struct {
			Attrs struct {
				CrashLoop bool `json:"crash_loop"`
			} `json:"attrs"`
		} `json:"record"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatal(err)
	}
	return file.Record.Attrs.CrashLoop
}

func compact(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestPanicRecordIsTheGoldenBytes(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	writePolicy(t, dir, `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":3}`)
	w := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt)}
	if err := w.Panic(60 * time.Second); err != nil {
		t.Fatal(err)
	}
	if got, want := onlyInboxFile(t, dir), golden(t, "inbox.tray-panic.json"); !bytes.Equal(got, want) {
		t.Fatalf("panic record differs from the golden:\n got %s\nwant %s", got, want)
	}
}

func TestAppUnreachableIsTheGoldenBytes(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	writePolicy(t, dir, `{"version":1,"level":"diagnostics","region":null,"noticeShownAt":1,"decidedAt":1,"generation":3}`)
	w := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt)}
	if err := w.AppUnreachable(clockAt); err != nil {
		t.Fatal(err)
	}
	if got, want := onlyInboxFile(t, dir), golden(t, "inbox.tray-health-app-reachable.json"); !bytes.Equal(got, want) {
		t.Fatalf("health record differs from the golden:\n got %s\nwant %s", got, want)
	}
}

// TestTheAppAcceptsWhatTheTrayWrites feeds the tray's bytes to the catalog's inbox parser through node. The record that
// comes back must be the record that was written, and the envelope must carry the same generation and origin.
func TestTheAppAcceptsWhatTheTrayWrites(t *testing.T) {
	isolate(t)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH; the catalog acceptance check needs it")
	}
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	catalog := filepath.ToSlash(filepath.Join(root, "lib", "v1", "telemetry", "catalog.mjs"))
	script := "import {readFileSync} from 'node:fs';\n" +
		"import {canonicalJson, parseInboxFile} from '" + catalog + "';\n" +
		"const parsed = parseInboxFile(readFileSync(0, 'utf8'));\n" +
		"process.stdout.write(canonicalJson({gen: parsed.gen, origin: parsed.origin, record: parsed.record, schema_version: parsed.schemaVersion}));\n"

	dir := t.TempDir()
	writePolicy(t, dir, `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":3}`)
	w := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt)}
	if err := w.Panic(60 * time.Second); err != nil {
		t.Fatal(err)
	}
	if err := w.AppUnreachable(clockAt); err != nil {
		t.Fatal(err)
	}
	names := inboxFiles(t, dir)
	if len(names) != 2 {
		t.Fatalf("want two inbox files, got %v", names)
	}
	for _, name := range names {
		body, err := os.ReadFile(filepath.Join(dir, "inbox", name))
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(node, "--input-type=module", "-e", script)
		cmd.Stdin = bytes.NewReader(body)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("the app rejected %s: %v\n%s", name, err, body)
		}
		var accepted struct {
			Gen           int64           `json:"gen"`
			Origin        string          `json:"origin"`
			Record        json.RawMessage `json:"record"`
			SchemaVersion int             `json:"schema_version"`
		}
		if err := json.Unmarshal(out, &accepted); err != nil {
			t.Fatal(err)
		}
		var written struct {
			Record json.RawMessage `json:"record"`
		}
		if err := json.Unmarshal(body, &written); err != nil {
			t.Fatal(err)
		}
		if accepted.Gen != 3 || accepted.Origin != "tray" || accepted.SchemaVersion != SchemaVersion {
			t.Fatalf("envelope changed in the app: %+v", accepted)
		}
		if !bytes.Equal(compact(t, accepted.Record), compact(t, written.Record)) {
			t.Fatalf("record changed in the app:\n got %s\nwant %s", accepted.Record, written.Record)
		}
	}
}

// TestPolicyDecidesWhetherAnythingIsWritten walks the edge rule: only a readable policy that is not off, and no switch,
// lets a record out, and a missing policy writes generation 0.
func TestPolicyDecidesWhetherAnythingIsWritten(t *testing.T) {
	valid := `{"version":1,"level":"counts","region":"US","noticeShownAt":5,"decidedAt":5,"generation":7}`
	cases := []struct {
		name    string
		policy  string // "": no policy.json; "directory": policy.json is a directory
		env     map[string]string
		written bool
		gen     int64
	}{
		{name: "a missing policy writes generation 0", written: true, gen: 0},
		{name: "a counts policy writes its generation", policy: valid, written: true, gen: 7},
		{name: "a diagnostics policy writes its generation", policy: `{"version":1,"level":"diagnostics","region":null,"noticeShownAt":null,"decidedAt":null,"generation":2}`, written: true, gen: 2},
		{name: "a null level still writes; the app decides on region and notice", policy: `{"version":1,"level":null,"region":"DE","noticeShownAt":null,"decidedAt":null,"generation":3}`, written: true, gen: 3},
		{name: "an off policy writes nothing", policy: `{"version":1,"level":"off","region":null,"noticeShownAt":1,"decidedAt":1,"generation":4}`},
		{name: "corrupt JSON writes nothing", policy: `{"version":1,`},
		{name: "a JSON array writes nothing", policy: `[]`},
		{name: "a missing key is corrupt", policy: `{"version":1,"level":"counts","noticeShownAt":null,"decidedAt":null,"generation":1}`},
		{name: "a wrong version is corrupt", policy: `{"version":2,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":1}`},
		{name: "an unknown level is corrupt", policy: `{"version":1,"level":"all","region":null,"noticeShownAt":1,"decidedAt":1,"generation":1}`},
		{name: "a negative generation is corrupt", policy: `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":-1}`},
		{name: "a fractional generation is corrupt", policy: `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":1.5}`},
		{name: "a string generation is corrupt", policy: `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":"3"}`},
		{name: "a lowercase region is corrupt", policy: `{"version":1,"level":"counts","region":"us","noticeShownAt":1,"decidedAt":1,"generation":1}`},
		{name: "a non-number notice time is corrupt", policy: `{"version":1,"level":"counts","region":null,"noticeShownAt":"yes","decidedAt":null,"generation":1}`},
		{name: "an unreadable policy writes nothing", policy: "directory"},
		{name: "FARAVAN_NO_TELEMETRY switches off", policy: valid, env: map[string]string{"FARAVAN_NO_TELEMETRY": "1"}},
		{name: "DO_NOT_TRACK switches off", policy: valid, env: map[string]string{"DO_NOT_TRACK": "true"}},
		{name: "DO_NOT_TRACK=0 does not switch off", policy: valid, env: map[string]string{"DO_NOT_TRACK": "0"}, written: true, gen: 7},
		{name: "a padded false does not switch off", policy: valid, env: map[string]string{"FARAVAN_NO_TELEMETRY": " FALSE "}, written: true, gen: 7},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolate(t)
			dir := t.TempDir()
			switch tc.policy {
			case "":
			case "directory":
				if err := os.MkdirAll(filepath.Join(dir, "policy.json"), 0o700); err != nil {
					t.Fatal(err)
				}
			default:
				writePolicy(t, dir, tc.policy)
			}
			w := Writer{Dir: dir, Env: environ(tc.env), Now: clock(clockAt)}
			err := w.Panic(time.Second)
			names := inboxFiles(t, dir)
			if !tc.written {
				if err == nil || len(names) != 0 {
					t.Fatalf("want nothing written, got err=%v files=%v", err, names)
				}
				return
			}
			if err != nil || len(names) != 1 {
				t.Fatalf("want one file, got err=%v files=%v", err, names)
			}
			if got := genOf(t, onlyInboxFile(t, dir)); got != tc.gen {
				t.Fatalf("gen %d, want %d", got, tc.gen)
			}
		})
	}
}

// TestFullInboxTakesNothing: the app's inbox holds 200 files at most; a producer that finds them there writes nothing.
func TestFullInboxTakesNothing(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	writePolicy(t, dir, `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":1}`)
	inbox := filepath.Join(dir, "inbox")
	if err := os.MkdirAll(inbox, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 199; i++ {
		if err := os.WriteFile(filepath.Join(inbox, fmt.Sprintf("x%03d.json", i)), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	w := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt)}
	if err := w.Panic(time.Second); err != nil {
		t.Fatalf("199 files: want a write, got %v", err)
	}
	if n := len(inboxFiles(t, dir)); n != 200 {
		t.Fatalf("want 200 files, got %d", n)
	}
	if err := w.Panic(time.Second); err == nil {
		t.Fatal("200 files: want nothing written")
	}
	if n := len(inboxFiles(t, dir)); n != 200 {
		t.Fatalf("a full inbox grew to %d", n)
	}
}

// TestEmptyHomeWritesNothing: with no home there is no directory to read or write, so no relative path is touched.
func TestEmptyHomeWritesNothing(t *testing.T) {
	isolate(t)
	w := Writer{Dir: "", Env: environ(nil), Now: clock(clockAt)}
	if err := w.Panic(time.Second); err == nil {
		t.Fatal("want nothing written")
	}
	if err := w.AppUnreachable(clockAt); err == nil {
		t.Fatal("want nothing written")
	}
	for _, name := range []string{"inbox", "policy.json", crashLastFile} {
		if _, err := os.Stat(name); err == nil {
			t.Fatalf("%s appeared in the working directory", name)
		}
	}
}

// TestCrashLoopIsSharedWithTheAppMarker: a crash less than five minutes after the last one, from either process, is a loop.
func TestCrashLoopIsSharedWithTheAppMarker(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	writePolicy(t, dir, `{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":1}`)
	first := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt)}
	if err := first.Panic(time.Second); err != nil {
		t.Fatal(err)
	}
	if crashLoopOf(t, onlyInboxFile(t, dir)) {
		t.Fatal("the first crash is not a loop")
	}
	// The app's own marker says it crashed one minute after clockAt: four minutes before the next crash.
	marker := strconv.FormatInt(clockAt.Add(time.Minute).UnixMilli(), 10)
	if err := os.WriteFile(filepath.Join(dir, crashLastFile), []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(dir, "inbox")); err != nil {
		t.Fatal(err)
	}
	second := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt.Add(5 * time.Minute))}
	if err := second.Panic(time.Second); err != nil {
		t.Fatal(err)
	}
	if !crashLoopOf(t, onlyInboxFile(t, dir)) {
		t.Fatal("a crash 4 minutes after the last one is a loop")
	}
	// Six minutes after the second crash it is not.
	if err := os.RemoveAll(filepath.Join(dir, "inbox")); err != nil {
		t.Fatal(err)
	}
	later := Writer{Dir: dir, Env: environ(nil), Now: clock(clockAt.Add(11 * time.Minute))}
	if err := later.Panic(time.Second); err != nil {
		t.Fatal(err)
	}
	if crashLoopOf(t, onlyInboxFile(t, dir)) {
		t.Fatal("a crash 6 minutes after the last one is not a loop")
	}
}

// TestUnreachableWaitsTenMinutesThenReportsOncePerHour pins the cadence: nothing before ten minutes of silence, one
// record per UTC hour after that, and no second record in the same hour however often the app flickers.
func TestUnreachableWaitsTenMinutesThenReportsOncePerHour(t *testing.T) {
	var u Unreachable
	at := func(clock string) time.Time {
		parsed, err := time.Parse("2006-01-02 15:04:05", "2026-10-21 "+clock)
		if err != nil {
			t.Fatal(err)
		}
		return parsed.UTC()
	}
	steps := []struct {
		clock     string
		reachable bool
		want      bool
	}{
		{"19:50:00", false, false}, // unreachable since here
		{"20:00:00", false, false}, // exactly ten minutes is not more than ten
		{"20:00:01", false, true},  // more than ten minutes, hour 20: the first report
		{"20:02:00", false, false}, // the same hour
		{"20:03:00", true, false},  // the app answers
		{"20:04:00", false, false}, // silent again, and still hour 20
		{"20:25:00", false, false}, // still hour 20: no second report
		{"21:05:00", false, true},  // hour 21: reported again
		{"21:30:00", false, false}, // the same hour
	}
	for _, step := range steps {
		if got := u.Observe(at(step.clock), step.reachable); got != step.want {
			t.Fatalf("at %s reachable=%v: got %v, want %v", step.clock, step.reachable, got, step.want)
		}
	}
}

func TestDurationBucketsAreTheCatalogLabels(t *testing.T) {
	cases := map[float64]string{0.5: "1", 1: "1", 2: "5", 60: "60", 61: "300", 86400: "86400", 90000: "inf"}
	for seconds, want := range cases {
		if got := durationBucket(seconds); got != want {
			t.Fatalf("durationBucket(%v) = %q, want %q", seconds, got, want)
		}
	}
}
