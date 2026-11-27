// Windows' installed entrypoint registers the resident task under the current
// interactive user. Task Scheduler owns process recovery, not this short launcher.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	layout := filepath.Dir(executable)
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(layout, "register-resident.ps1"), "-Layout", layout)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		os.Exit(1)
	}
}
