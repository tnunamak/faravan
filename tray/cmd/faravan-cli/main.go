package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "faravan: could not locate the CLI launcher:", err)
		os.Exit(1)
	}
	root := filepath.Dir(executable)
	node := filepath.Join(root, "app", "runtime", "node.exe")
	cli := filepath.Join(root, "app", "bin", "faravan")
	command := exec.Command(node, append([]string{cli}, os.Args[1:]...)...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "faravan: could not start the bundled CLI:", err)
		os.Exit(1)
	}
}
