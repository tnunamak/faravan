//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// detachedProcess starts the app in its own session, so closing the tray never stops it.
func detachedProcess() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func init() {
	prepareHelperProcess = func(cmd *exec.Cmd) func() {
		// The tray and the detached app are never members of this helper group.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		killGroup := func() error {
			if cmd.Process == nil { return nil }
			err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			if errors.Is(err, syscall.ESRCH) { return os.ErrProcessDone }
			return err
		}
		cmd.Cancel = killGroup
		// A helper can exit before children holding its output pipes. Clean up
		// its group on normal completion as well as cancellation.
		return func() { _ = killGroup() }
	}
}
