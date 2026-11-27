package faravantray

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestOwnerGoneClosesOnEndOfInputOnly(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer read.Close()
	gone := OwnerGone(read)
	if _, err := write.Write([]byte("noise is ignored\n")); err != nil { t.Fatal(err) }
	select {
	case <-gone: t.Fatal("input that has not ended does not mean the owner is gone")
	case <-time.After(50 * time.Millisecond):
	}
	write.Close() // what the kernel does when the launcher exits or is force-quit
	select {
	case <-gone:
	case <-time.After(2 * time.Second): t.Fatal("end of input means the owner is gone")
	}
	failing := OwnerGone(errReader{})
	select {
	case <-failing:
	case <-time.After(2 * time.Second): t.Fatal("a read error also ends ownership")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("closed") }

var _ io.Reader = errReader{}

func TestOwnedOnlyWhenTheLauncherSaysSo(t *testing.T) {
	for value, want := range map[string]bool{"stdin": true, "": false, "1": false, "yes": false} {
		if got := OwnedByLauncher(func(string) string { return value }); got != want { t.Fatalf("%q: %v", value, got) }
	}
}

func bundle(t *testing.T, notify, cli bool) (exe string) {
	t.Helper()
	contents := filepath.Join(t.TempDir(), "Spare Kin.app", "Contents")
	exe = filepath.Join(contents, "MacOS", "faravan-tray")
	write := func(path string, mode os.FileMode) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil { t.Fatal(err) }
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil { t.Fatal(err) }
	}
	write(exe, 0o755)
	if notify { write(filepath.Join(contents, "Helpers", "FaravanNotify.app", "Contents", "MacOS", "faravan-notify"), 0o755) }
	if cli { write(filepath.Join(contents, "MacOS", "faravan"), 0o755) }
	return exe
}

func TestBundledNotifyHelperIsFoundBesideTheTray(t *testing.T) {
	exe := bundle(t, true, false)
	want := filepath.Join(filepath.Dir(filepath.Dir(exe)), "Helpers", "FaravanNotify.app", "Contents", "MacOS", "faravan-notify")
	if got := NotifyHelperPath("darwin", exe, ""); got != want { t.Fatalf("%q", got) }
	if got := NotifyHelperPath("darwin", exe, "/explicit/helper"); got != "/explicit/helper" { t.Fatal("FARAVAN_NOTIFY_HELPER still wins") }
	if got := NotifyHelperPath("linux", exe, ""); got != "" { t.Fatal("only macOS has the helper app") }
	if got := NotifyHelperPath("darwin", bundle(t, false, false), ""); got != "" { t.Fatal("a tray without the bundle falls back to osascript") }
	// Not executable: not a helper.
	plain := bundle(t, false, false)
	helper := filepath.Join(filepath.Dir(filepath.Dir(plain)), "Helpers", "FaravanNotify.app", "Contents", "MacOS", "faravan-notify")
	os.MkdirAll(filepath.Dir(helper), 0o755)
	os.WriteFile(helper, nil, 0o644)
	if got := NotifyHelperPath("darwin", plain, ""); got != "" { t.Fatalf("%q", got) }
}

func TestFaravanCLIPrefersTheBundledWrapperOnMac(t *testing.T) {
	exe := bundle(t, false, true)
	sibling := filepath.Join(filepath.Dir(exe), "faravan")
	onPath := func(string) (string, error) { return "/usr/local/bin/faravan", nil }
	notOnPath := func(string) (string, error) { return "", errors.New("not found") }
	if got, err := FaravanCLI("darwin", exe, t.TempDir(), onPath); err != nil || got != sibling { t.Fatalf("%q %v: the bundle's own CLI, not another install", got, err) }
	if got, _ := FaravanCLI("linux", exe, t.TempDir(), onPath); got != "/usr/local/bin/faravan" { t.Fatalf("%q: other systems keep PATH first", got) }
	home := t.TempDir()
	local := filepath.Join(home, ".local", "bin", "faravan")
	os.MkdirAll(filepath.Dir(local), 0o755)
	os.WriteFile(local, nil, 0o755)
	if got, _ := FaravanCLI("darwin", bundle(t, false, false), home, notOnPath); got != local { t.Fatalf("%q", got) }
	if _, err := FaravanCLI("darwin", bundle(t, false, false), t.TempDir(), notOnPath); err == nil { t.Fatal("no CLI anywhere is an error") }
}

// TestLifecycleProcessHelper runs only in a child test process. Its initialization
// marker stands for everything that must not run in a second tray (including its poller).
func TestLifecycleProcessHelper(t *testing.T) {
	role := os.Getenv("FARAVAN_LIFECYCLE_TEST")
	if role == "" { return }
	root := os.Getenv("FARAVAN_LIFECYCLE_ROOT")
	mark := func(name string) {
		f, err := os.OpenFile(filepath.Join(root, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil { t.Fatal(err) }
		defer f.Close()
		if _, err := f.WriteString("started\n"); err != nil { t.Fatal(err) }
	}
	wait := func(name string) {
		deadline := time.Now().Add(5*time.Second)
		for {
			if _, err := os.Stat(filepath.Join(root, name)); err == nil { return }
			if time.Now().After(deadline) { t.Fatal("helper gate timed out") }
			time.Sleep(5*time.Millisecond)
		}
	}
	switch role {
	case "tray":
		if err := RunTrayInstance(func() { mark("tray-starts"); wait("release") }); err != nil { t.Fatal(err) }
	case "launch":
		wait("launch-gate")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		client := LocalClient{AppPath:filepath.Join(root, "app.json"), Alive:func(int) bool { return true }}
		if _, err := client.StartAndWait(ctx, func() error {
			mark("app-starts")
			time.Sleep(300*time.Millisecond)
			return os.WriteFile(client.AppPath, []byte(appRecord(1234)), 0o600)
		}); err != nil { t.Fatal(err) }
	case "zombie":
		return
	default:
		t.Fatalf("unknown helper role %q", role)
	}
}

func lifecycleChild(t *testing.T, ctx context.Context, root, role string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil { t.Fatal(err) }
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestLifecycleProcessHelper$")
	cmd.Env = append(os.Environ(), "FARAVAN_LIFECYCLE_TEST="+role, "FARAVAN_LIFECYCLE_ROOT="+root)
	return cmd
}

func waitLifecycleFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3*time.Second)
	for {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 { return }
		if time.Now().After(deadline) { t.Fatalf("waiting for %s", filepath.Base(path)) }
		time.Sleep(5*time.Millisecond)
	}
}

func TestTraySecondInstanceStartsNothingAndReleasesOnExit(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux instance lock") }
	root := t.TempDir()
	privateRuntimeDir(t, root)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	first := lifecycleChild(t, ctx, root, "tray")
	if err := first.Start(); err != nil { t.Fatal(err) }
	defer func() { _ = first.Process.Kill(); _ = first.Wait() }()
	waitLifecycleFile(t, filepath.Join(root, "tray-starts"))
	secondCtx, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	if out, err := lifecycleChild(t, secondCtx, root, "tray").CombinedOutput(); err != nil {
		t.Fatalf("second instance must exit successfully without initialization: %v: %s", err, out)
	}
	data, err := os.ReadFile(filepath.Join(root, "tray-starts"))
	if err != nil || string(data) != "started\n" { t.Fatalf("duplicate initialization/poller: %q, %v", data, err) }
	if err := os.WriteFile(filepath.Join(root, "release"), []byte("go"), 0o600); err != nil { t.Fatal(err) }
	if err := first.Wait(); err != nil { t.Fatal(err) }
	if out, err := lifecycleChild(t, ctx, root, "tray").CombinedOutput(); err != nil { t.Fatalf("restart: %v: %s", err, out) }
	data, err = os.ReadFile(filepath.Join(root, "tray-starts"))
	if err != nil || string(data) != "started\nstarted\n" { t.Fatalf("lock not released on exit: %q, %v", data, err) }
}

func TestStartAndWaitSerializesAcrossProcesses(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux launch lock") }
	root := t.TempDir()
	privateRuntimeDir(t, root)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	first, second := lifecycleChild(t, ctx, root, "launch"), lifecycleChild(t, ctx, root, "launch")
	if err := first.Start(); err != nil { t.Fatal(err) }
	defer func() { _ = first.Process.Kill(); _ = first.Wait() }()
	if err := second.Start(); err != nil { t.Fatal(err) }
	defer func() { _ = second.Process.Kill(); _ = second.Wait() }()
	if err := os.WriteFile(filepath.Join(root, "launch-gate"), []byte("go"), 0o600); err != nil { t.Fatal(err) }
	if err := first.Wait(); err != nil { t.Fatal(err) }
	if err := second.Wait(); err != nil { t.Fatal(err) }
	data, err := os.ReadFile(filepath.Join(root, "app-starts"))
	if err != nil || string(data) != "started\n" { t.Fatalf("concurrent Start launched more than once: %q, %v", data, err) }
}

func TestTrayLockReleasesAfterProcessCrash(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux instance lock") }
	root := t.TempDir()
	privateRuntimeDir(t, root)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	first := lifecycleChild(t, ctx, root, "tray")
	if err := first.Start(); err != nil { t.Fatal(err) }
	defer func() { _ = first.Process.Kill(); _ = first.Wait() }()
	waitLifecycleFile(t, filepath.Join(root, "tray-starts"))
	if err := first.Process.Kill(); err != nil { t.Fatal(err) }
	_ = first.Wait()
	if err := os.WriteFile(filepath.Join(root, "release"), []byte("go"), 0o600); err != nil { t.Fatal(err) }
	if out, err := lifecycleChild(t, ctx, root, "tray").CombinedOutput(); err != nil { t.Fatalf("restart after crash: %v: %s", err, out) }
	data, err := os.ReadFile(filepath.Join(root, "tray-starts"))
	if err != nil || string(data) != "started\nstarted\n" { t.Fatalf("crash left a stale lock: %q, %v", data, err) }
}

func TestLaunchLockCancellationFailureAndSeparateTrayLifetime(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux launch lock") }
	privateRuntimeDir(t, t.TempDir())
	client := LocalClient{AppPath:filepath.Join(t.TempDir(), "app.json"), Alive:func(int) bool { return true }}
	unlock, err := appLaunchLock(context.Background())
	if err != nil { t.Fatal(err) }
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	starts := 0
	_, err = client.StartAndWait(ctx, func() error { starts++; return nil })
	unlock()
	if !errors.Is(err, context.DeadlineExceeded) || starts != 0 { t.Fatalf("lock wait ignored cancellation: starts=%d err=%v", starts, err) }
	want := errors.New("launch failed")
	ctx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := client.StartAndWait(ctx, func() error { return want }); !errors.Is(err, want) { t.Fatal(err) }
	// A launch failure releases its lock; the tray's distinct lifetime lock
	// must not prevent Start from succeeding while the tray is running.
	if err := RunTrayInstance(func() {
		_, err := client.StartAndWait(ctx, func() error {
			starts++
			return os.WriteFile(client.AppPath, []byte(appRecord(1234)), 0o600)
		})
		if err != nil { t.Error(err) }
	}); err != nil { t.Fatal(err) }
	if starts != 1 { t.Fatalf("launch blocked by its failed predecessor or the tray lock: %d", starts) }
}

func TestTrayRejectsUnsafeRuntimePathsBeforeInitialization(t *testing.T) {
	if runtime.GOOS != "linux" { t.Skip("Linux instance lock") }
	for _, kind := range []string{"relative", "symlink", "public", "lock-symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			dir := root
			switch kind {
			case "relative":
				dir = "relative-runtime"
			case "symlink":
				dir = filepath.Join(root, "link")
				if err := os.Symlink(t.TempDir(), dir); err != nil { t.Fatal(err) }
			case "public":
				if err := os.Chmod(root, 0o755); err != nil { t.Fatal(err) }
			case "lock-symlink":
				target := filepath.Join(t.TempDir(), "target")
				if err := os.WriteFile(target, []byte("untouched"), 0o600); err != nil { t.Fatal(err) }
				home, err := HomePath()
				if err != nil { t.Fatal(err) }
				home, err = filepath.Abs(home)
				if err != nil { t.Fatal(err) }
				key := sha256.Sum256([]byte(home))
				name := fmt.Sprintf("faravan-tray.lock-%x", key[:8])
				if err := os.Symlink(target, filepath.Join(root, name)); err != nil { t.Fatal(err) }
			}
			t.Setenv("XDG_RUNTIME_DIR", dir)
			started := false
			if err := RunTrayInstance(func() { started = true }); err == nil || started {
				t.Fatalf("unsafe runtime initialized the tray: started=%v err=%v", started, err)
			}
		})
	}
}

// t.TempDir follows the umask; a group-writable runtime directory is refused,
// as XDG_RUNTIME_DIR must be private.
func privateRuntimeDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.Chmod(dir, 0o700); err != nil { t.Fatal(err) }
	t.Setenv("XDG_RUNTIME_DIR", dir)
}
