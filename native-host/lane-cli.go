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

func bridgeStdin() (string, error) {
	value, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	file, err := os.CreateTemp("", "lane-cli-stdin-*")
	if err != nil {
		return "", err
	}
	path := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(path)
	}
	if err := file.Chmod(0600); err != nil {
		cleanup()
		return "", err
	}
	if _, err := file.Write(value); err != nil {
		cleanup()
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
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
	var stdinBridgePath string
	if needsStdinBridge(os.Args[1:]) {
		stdinBridgePath, err = bridgeStdin()
		if err != nil {
			fmt.Fprintln(os.Stderr, "lane: cannot securely forward stdin")
			os.Exit(1)
		}
		defer os.Remove(stdinBridgePath)
		command.Env = append(command.Env, "LANE_CLI_STDIN_FILE="+stdinBridgePath)
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
