package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	winio "github.com/Microsoft/go-winio"
)

const maxProviderKeyBytes = 64 * 1024

type acceptResult struct {
	connection net.Conn
	err        error
}

func needsStdinBridge(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--api-key-stdin" {
			return true
		}
	}
	return false
}

func randomPipePath() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return `\\.\pipe\lane-cli-stdin-` + hex.EncodeToString(random), nil
}

func currentUserPipeSecurityDescriptor() (string, error) {
	currentUser, err := user.Current()
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(currentUser.Uid, "S-1-") {
		return "", fmt.Errorf("unexpected Windows user SID")
	}
	return "D:P(A;;GA;;;SY)(A;;GA;;;" + currentUser.Uid + ")", nil
}

func runWithStdinBridge(command *exec.Cmd) error {
	pipePath, err := randomPipePath()
	if err != nil {
		return fmt.Errorf("cannot create the CLI stdin pipe name: %w", err)
	}
	securityDescriptor, err := currentUserPipeSecurityDescriptor()
	if err != nil {
		return fmt.Errorf("cannot secure the CLI stdin pipe: %w", err)
	}
	listener, err := winio.ListenPipe(pipePath, &winio.PipeConfig{
		SecurityDescriptor: securityDescriptor,
		InputBufferSize:    maxProviderKeyBytes + 1,
		OutputBufferSize:   maxProviderKeyBytes + 1,
	})
	if err != nil {
		return fmt.Errorf("cannot create the CLI stdin pipe: %w", err)
	}
	defer listener.Close()
	command.Env = append(command.Env, "LANE_CLI_STDIN_PIPE="+pipePath)
	if err := command.Start(); err != nil {
		return err
	}

	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	accepted := make(chan acceptResult, 1)
	go func() {
		connection, acceptError := listener.Accept()
		accepted <- acceptResult{connection: connection, err: acceptError}
	}()

	var connection net.Conn
	select {
	case result := <-accepted:
		if result.err != nil {
			_ = command.Process.Kill()
			<-wait
			return fmt.Errorf("cannot connect the CLI stdin pipe: %w", result.err)
		}
		connection = result.connection
	case err := <-wait:
		return err
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		<-wait
		return fmt.Errorf("timed out waiting for Lane to read the CLI stdin pipe")
	}

	_, copyError := io.Copy(connection, io.LimitReader(os.Stdin, maxProviderKeyBytes+1))
	closeError := connection.Close()
	if copyError != nil {
		_ = command.Process.Kill()
		<-wait
		return fmt.Errorf("cannot forward the provider API key: %w", copyError)
	}
	if closeError != nil {
		_ = command.Process.Kill()
		<-wait
		return fmt.Errorf("cannot close the CLI stdin pipe: %w", closeError)
	}
	return <-wait
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
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if needsStdinBridge(os.Args[1:]) {
		err = runWithStdinBridge(command)
	} else {
		err = command.Run()
	}
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "lane: %v\n", err)
		os.Exit(1)
	}
}
