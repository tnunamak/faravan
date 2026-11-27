//go:build darwin

package processidentity

import (
	"fmt"
	"golang.org/x/sys/unix"
)

type Identity struct {
	Boot  string `json:"boot"`
	Start string `json:"start"`
	State string `json:"state"`
}

func Read(pid int) (Identity, error) {
	process, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return Identity{}, err
	}
	if process == nil || process.Proc.P_pid != int32(pid) {
		return Identity{}, unix.ESRCH
	}
	boot, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil || boot == "" {
		return Identity{}, fmt.Errorf("cannot read boot identity: %v", err)
	}
	state := "live"
	if process.Proc.P_stat == 5 {
		state = "Z"
	}
	start := process.Proc.P_starttime
	if start.Sec <= 0 || start.Usec < 0 || start.Usec >= 1000000 {
		return Identity{}, fmt.Errorf("unknown process birth")
	}
	return Identity{Boot: "darwin:" + boot, Start: fmt.Sprintf("%d", start.Sec*1000000+int64(start.Usec)), State: state}, nil
}
