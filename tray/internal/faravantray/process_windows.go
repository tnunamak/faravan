package faravantray

import "os"

// ProcessAlive: on Windows, FindProcess opens a handle and fails when the
// process is gone. (Signal(0) is not supported there, so it cannot be the probe.)
func ProcessAlive(pid int) bool {
	if pid <= 0 { return false }
	process, err := os.FindProcess(pid)
	if err != nil { return false }
	_ = process.Release()
	return true
}

