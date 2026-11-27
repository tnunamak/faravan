//go:build darwin

package main

import (
	"encoding/json"
	"github.com/tnunamak/faravan/tray/internal/processidentity"
	"os"
	"strconv"
)

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	pid, err := strconv.Atoi(os.Args[1])
	if err != nil || pid <= 0 {
		os.Exit(2)
	}
	identity, err := processidentity.Read(pid)
	if err != nil {
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(identity) != nil {
		os.Exit(1)
	}
}
