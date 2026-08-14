package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	launcherPath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "lane: cannot locate the CLI launcher")
		os.Exit(1)
	}
	lanePath := filepath.Clean(filepath.Join(filepath.Dir(launcherPath), "..", "..", "Lane.exe"))
	command := exec.Command(lanePath, os.Args[1:]...)
	command.Env = append(os.Environ(), "LANE_BE_CLI=1")
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "lane: %v\n", err)
		os.Exit(1)
	}
}
