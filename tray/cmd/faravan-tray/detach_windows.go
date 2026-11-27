package main

import "syscall"

// detachedProcess starts the app without a console window and outside the
// tray's process group, so closing the tray never stops it.
func detachedProcess() *syscall.SysProcAttr {
	const detachedProcessFlag, newProcessGroup = 0x00000008, 0x00000200
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcessFlag | newProcessGroup}
}
