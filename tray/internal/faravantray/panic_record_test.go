package faravantray

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tnunamak/faravan/tray/internal/telemetry"
)

// TestWorkerPanicIsRecordedAndStillCrashes runs a panicking tray worker in a child process. The child must still die of
// the same panic (exit status non-zero, the panic text on stderr), and the telemetry inbox must hold the one crash record
// that was written before it died.
func TestWorkerPanicIsRecordedAndStillCrashes(t *testing.T) {
	if os.Getenv("FARAVAN_TRAY_PANIC_CHILD") == "1" {
		childPanics(os.Getenv("FARAVAN_TRAY_PANIC_DIR"), false)
		return
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("DO_NOT_TRACK", "0")
	t.Setenv("FARAVAN_NO_TELEMETRY", "0")
	t.Setenv("FARAVAN_NO_TELEMETRY", "0")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "policy.json"),
		[]byte(`{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":1}`), 0o600); err != nil {
		t.Fatal(err)
	}

	stderr := runPanicChild(t, dir, false)
	if !strings.Contains(stderr, "panic: worker boom") {
		t.Fatalf("the panic text is gone from stderr:\n%s", stderr)
	}

	entries, err := os.ReadDir(filepath.Join(dir, "inbox"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("want one inbox file, got %v (%v)", entries, err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "inbox", entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Gen    int64  `json:"gen"`
		Origin string `json:"origin"`
		Record struct {
			Name  string `json:"name"`
			Attrs struct {
				CrashKind string `json:"crash.kind"`
			} `json:"attrs"`
		} `json:"record"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatal(err)
	}
	if file.Origin != "tray" || file.Gen != 1 || file.Record.Name != "app.crash" || file.Record.Attrs.CrashKind != "panic" {
		t.Fatalf("unexpected crash record: %s", body)
	}
}

// TestRecorderPanicDoesNotReplaceTheWorkerPanic: if the recorder itself fails, the process still dies of the worker's panic.
// The recorder's failure must not become the panic that is re-raised.
func TestRecorderPanicDoesNotReplaceTheWorkerPanic(t *testing.T) {
	if os.Getenv("FARAVAN_TRAY_PANIC_CHILD") == "1" {
		childPanics(os.Getenv("FARAVAN_TRAY_PANIC_DIR"), true)
		return
	}
	t.Setenv("HOME", t.TempDir())
	stderr := runPanicChild(t, t.TempDir(), true)
	if !strings.Contains(stderr, "panic: worker boom") {
		t.Fatalf("the worker's panic was replaced:\n%s", stderr)
	}
	if strings.Contains(stderr, "panic: recorder boom") {
		t.Fatalf("the recorder's failure became the crash:\n%s", stderr)
	}
}

// runPanicChild runs this test again in a child process and returns its stderr. The child must exit non-zero.
func runPanicChild(t *testing.T, dir string, recorderFails bool) string {
	t.Helper()
	name := "TestWorkerPanicIsRecordedAndStillCrashes"
	if recorderFails {
		name = "TestRecorderPanicDoesNotReplaceTheWorkerPanic"
	}
	cmd := exec.Command(os.Args[0], "-test.run=^"+name+"$")
	cmd.Env = append(os.Environ(), "FARAVAN_TRAY_PANIC_CHILD=1", "FARAVAN_TRAY_PANIC_DIR="+dir)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() == 0 {
		t.Fatalf("the worker did not crash: %v\n%s", err, stderr.String())
	}
	return stderr.String()
}

// childPanics is the child process: a tray worker panics, and the lifetime records it before the panic continues. With
// recorderFails, the recorder panics too.
func childPanics(dir string, recorderFails bool) {
	lifetime := &TrayLifetime{}
	lifetime.OnPanic = func() {
		if recorderFails {
			panic("recorder boom")
		}
		started := time.Now()
		_ = telemetry.Writer{Dir: dir, Now: func() time.Time { return started }}.Panic(time.Second)
	}
	lifetime.Go(func(context.Context) { panic("worker boom") })
	time.Sleep(10 * time.Second) // the panic ends the process first
}
