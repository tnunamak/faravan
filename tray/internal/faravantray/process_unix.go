//go:build !windows

package faravantray

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func init() {
	if runtime.GOOS != "linux" { return }
	trayInstanceLock = func() (func(), bool, error) { return tryRuntimeLock("tray.lock") }
	appLaunchLock = waitAppLaunchLock
	appProcessAlive = linuxAppProcessAlive
}

// ProcessAlive treats unknown/permission errors as live, avoiding duplicate
// starts, but Linux zombies have exited even while signal 0 still succeeds.
func ProcessAlive(pid int) bool {
	if pid <= 0 { return false }
	if runtime.GOOS == "linux" {
		state, _, err := linuxProcessStat(pid)
		if err == nil { return state != "Z" && state != "X" && state != "x" }
		if errors.Is(err, os.ErrNotExist) { return false }
	}
	process, err := os.FindProcess(pid)
	if err != nil { return false }
	err = process.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

// stat's comm can contain spaces and parentheses, so field 3 starts after the
// last closing parenthesis. starttime is field 22, in Linux USER_HZ (100 ticks/s).
func linuxProcessStat(pid int) (string, uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil { return "", 0, err }
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 { return "", 0, errors.New("invalid process identity") }
	fields := strings.Fields(string(data)[end+1:])
	if len(fields) < 20 || len(fields[0]) != 1 { return "", 0, errors.New("invalid process identity") }
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil { return "", 0, errors.New("invalid process start time") }
	return fields[0], ticks, nil
}

// The discovery writer stamps StartedAt after its process starts. A process
// born later cannot own that record, even if the kernel recycled its PID.
// btime is rounded down to seconds; use that conservative lower bound rather
// than misclassifying a genuinely live app as stopped due to clock precision.
func linuxAppProcessAlive(info AppInfo) (bool, error) {
	state, ticks, err := linuxProcessStat(info.PID)
	if errors.Is(err, os.ErrNotExist) { return false, nil }
	if err != nil { return false, errors.New("cannot verify Faravan process identity") }
	if state == "Z" || state == "X" || state == "x" { return false, nil }
	data, err := os.ReadFile("/proc/stat")
	if err != nil { return false, errors.New("cannot verify Faravan process start time") }
	var boot int64
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "btime" {
			boot, err = strconv.ParseInt(fields[1], 10, 64)
			found = err == nil && boot > 0
			break
		}
	}
	if !found { return false, errors.New("cannot verify Faravan process start time") }
	started, err := time.Parse(time.RFC3339Nano, info.StartedAt)
	if err != nil { return false, errors.New("invalid Faravan app start time") }
	processStart := time.Unix(boot+int64(ticks/100), int64(ticks%100)*int64(10*time.Millisecond))
	return !started.Before(processStart), nil
}

// Runtime lock files are stable inodes: never unlink them on release, or a
// third process could lock a new inode while another still owns the old one.
func trayRuntimeDir() (string, error) {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = filepath.Join("/run/user", strconv.Itoa(os.Getuid()))
		if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
			dir = filepath.Join(os.TempDir(), "faravan-"+strconv.Itoa(os.Getuid()))
			if err := os.MkdirAll(dir, 0o700); err != nil { return "", err }
		}
	}
	if !filepath.IsAbs(dir) { return "", errors.New("runtime directory must be absolute") }
	info, err := os.Lstat(dir)
	if err != nil { return "", err }
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 || !ok || stat.Uid != uint32(os.Getuid()) {
		return "", errors.New("runtime directory must be private and owned by this user")
	}
	return dir, nil
}

func tryRuntimeLock(name string) (func(), bool, error) {
	dir, err := trayRuntimeDir()
	if err != nil { return nil, false, err }
	home, err := HomePath()
	if err != nil { return nil, false, err }
	// Abs also cleans relative components and trailing separators. The state
	// root need not exist yet, so do not require filesystem canonicalization.
	home, err = filepath.Abs(home)
	if err != nil { return nil, false, err }
	homeKey := sha256.Sum256([]byte(home))
	filename := fmt.Sprintf("faravan-%s-%x", name, homeKey[:8])
	file, err := os.OpenFile(filepath.Join(dir, filename), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil { return nil, false, err }
	info, err := file.Stat()
	if err != nil { file.Close(); return nil, false, err }
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || !ok || stat.Uid != uint32(os.Getuid()) {
		file.Close()
		return nil, false, errors.New("lock file must be private and owned by this user")
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if !errors.Is(err, syscall.EINTR) { break }
	}
	if err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) { return nil, false, nil }
		return nil, false, err
	}
	// os.OpenFile creates a close-on-exec descriptor; launched apps must not
	// inherit the tray/launch lock. Closing also releases it after a crash.
	return func() { _ = file.Close() }, true, nil
}

func waitAppLaunchLock(ctx context.Context) (func(), error) {
	ticker := time.NewTicker(20*time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil { return nil, err }
		unlock, acquired, err := tryRuntimeLock("app-launch.lock")
		if err != nil { return nil, err }
		if acquired { return unlock, nil }
		select {
		case <-ctx.Done(): return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
