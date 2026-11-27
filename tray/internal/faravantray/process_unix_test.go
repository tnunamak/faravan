//go:build !windows

package faravantray

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func acquireHomeRuntimeLock(t *testing.T, name string) func() {
	t.Helper()
	unlock, acquired, err := tryRuntimeLock(name)
	if err != nil || !acquired {
		t.Fatalf("acquire %s: acquired=%v err=%v", name, acquired, err)
	}
	t.Cleanup(unlock)
	return unlock
}

func requireHomeRuntimeLockHeld(t *testing.T, name string) {
	t.Helper()
	unlock, acquired, err := tryRuntimeLock(name)
	if acquired {
		unlock()
	}
	if err != nil || acquired {
		t.Fatalf("duplicate %s: acquired=%v err=%v", name, acquired, err)
	}
}

func TestRuntimeLocksArePerHome(t *testing.T) {
	for _, name := range []string{"tray.lock", "app-launch.lock"} {
		t.Run(name, func(t *testing.T) {
			privateRuntimeDir(t, t.TempDir())
			first, second := t.TempDir(), t.TempDir()
			t.Setenv("FARAVAN_HOME", first)
			acquireHomeRuntimeLock(t, name)
			requireHomeRuntimeLockHeld(t, name)
			t.Setenv("FARAVAN_HOME", second)
			acquireHomeRuntimeLock(t, name)
			requireHomeRuntimeLockHeld(t, name)
			t.Setenv("FARAVAN_HOME", first)
			requireHomeRuntimeLockHeld(t, name)
		})
	}
}

func TestRuntimeLocksCanonicalizeHome(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	relative, err := filepath.Rel(cwd, home)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tray.lock", "app-launch.lock"} {
		t.Run(name, func(t *testing.T) {
			privateRuntimeDir(t, t.TempDir())
			t.Setenv("FARAVAN_HOME", home)
			acquireHomeRuntimeLock(t, name)
			for _, equivalent := range []string{relative, home + "/", home + "/child/..", "./" + relative} {
				t.Setenv("FARAVAN_HOME", equivalent)
				requireHomeRuntimeLockHeld(t, name)
			}
		})
	}
}

func TestRuntimeLocksDefaultHomeIsSingleton(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("FARAVAN_HOME", "")
	privateRuntimeDir(t, t.TempDir())
	for _, name := range []string{"tray.lock", "app-launch.lock"} {
		acquireHomeRuntimeLock(t, name)
		requireHomeRuntimeLockHeld(t, name)
	}
}

func TestAppLaunchWaitUsesHomeLock(t *testing.T) {
	privateRuntimeDir(t, t.TempDir())
	t.Setenv("FARAVAN_HOME", t.TempDir())
	acquireHomeRuntimeLock(t, "app-launch.lock")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if unlock, err := waitAppLaunchLock(ctx); !errors.Is(err, context.DeadlineExceeded) {
		if unlock != nil {
			unlock()
		}
		t.Fatalf("same home launch must wait: %v", err)
	}
	t.Setenv("FARAVAN_HOME", t.TempDir())
	otherCtx, otherCancel := context.WithTimeout(context.Background(), time.Second)
	defer otherCancel()
	unlock, err := waitAppLaunchLock(otherCtx)
	if err != nil {
		t.Fatalf("different home launch blocked: %v", err)
	}
	unlock()
}

func TestRuntimeLockReleaseKeepsStablePrivateFile(t *testing.T) {
	dir, home := t.TempDir(), t.TempDir()
	privateRuntimeDir(t, dir)
	t.Setenv("FARAVAN_HOME", home)
	for _, name := range []string{"tray.lock", "app-launch.lock"} {
		unlock := acquireHomeRuntimeLock(t, name)
		key := sha256.Sum256([]byte(home))
		path := filepath.Join(dir, fmt.Sprintf("faravan-%s-%x", name, key[:8]))
		before, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !before.Mode().IsRegular() || before.Mode().Perm()&0o077 != 0 {
			t.Fatalf("unsafe lock mode: %v", before.Mode())
		}
		unlock()
		after, err := os.Lstat(path)
		if err != nil || !os.SameFile(before, after) {
			t.Fatalf("release removed/replaced lock inode: %v", err)
		}
		acquireHomeRuntimeLock(t, name)
	}
}
