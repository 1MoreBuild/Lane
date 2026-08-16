package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

func needsStdinBridge(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--api-key-stdin" {
			return true
		}
	}
	return false
}

func main() {
	launcherPath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "lane: cannot locate the CLI launcher")
		os.Exit(1)
	}
	lanePath := filepath.Clean(filepath.Join(filepath.Dir(launcherPath), "..", "..", "Lane.exe"))
	command := exec.Command(lanePath, os.Args[1:]...)
	command.Env = append(os.Environ(), "LANE_BE_CLI=1")
	if needsStdinBridge(os.Args[1:]) {
		// Wrapping stdin forces os/exec to create an inherited anonymous pipe
		// instead of passing the console handle directly to the GUI executable.
		// Provider keys therefore stay in memory and never touch the filesystem.
		command.Stdin = io.LimitReader(os.Stdin, 64*1024)
	} else {
		command.Stdin = os.Stdin
	}
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
