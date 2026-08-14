package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	allowedOrigin       = "chrome-extension://mdjfkiddlpdgchddcckhcmdjekmmhcgp/"
	userDataDirName     = "lane-local-ai-gateway"
	maxNativeRequest    = 64 * 1024
	maxControlResponse  = 1024 * 1024
	connectTimeout      = 8 * time.Second
	detachedProcess     = 0x00000008
	createNewProcessGrp = 0x00000200
)

type nativeRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Type            string `json:"type"`
}

type controlResponse struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error json.RawMessage `json:"error,omitempty"`
}

type nativeResponse struct {
	ProtocolVersion int             `json:"protocolVersion"`
	OK              bool            `json:"ok"`
	Data            json.RawMessage `json:"data,omitempty"`
	Error           json.RawMessage `json:"error,omitempty"`
}

func failure(code, message string, retryable bool) nativeResponse {
	errorBody, _ := json.Marshal(map[string]any{
		"code": code, "message": message, "retryable": retryable,
	})
	return nativeResponse{ProtocolVersion: 1, OK: false, Error: errorBody}
}

func writeNativeMessage(response nativeResponse) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if err := binary.Write(os.Stdout, binary.LittleEndian, uint32(len(payload))); err != nil {
		return err
	}
	_, err = os.Stdout.Write(payload)
	return err
}

func readNativeRequest() (nativeRequest, error) {
	var length uint32
	if err := binary.Read(os.Stdin, binary.LittleEndian, &length); err != nil {
		return nativeRequest{}, err
	}
	if length > maxNativeRequest {
		return nativeRequest{}, errors.New("native request is too large")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(os.Stdin, payload); err != nil {
		return nativeRequest{}, err
	}
	var request nativeRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nativeRequest{}, err
	}
	if request.ProtocolVersion != 1 || request.Type != "connect" {
		return nativeRequest{}, errors.New("unsupported native request")
	}
	return request, nil
}

func pipePath() (string, error) {
	if override := os.Getenv("LANE_CONTROL_SOCKET"); override != "" {
		return override, nil
	}
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", errors.New("APPDATA is unavailable")
	}
	identity := sha256.Sum256([]byte(filepath.Join(appData, userDataDirName)))
	return `\\.\pipe\lane-` + hex.EncodeToString(identity[:8]), nil
}

func wakeLane() {
	host, err := os.Executable()
	if err != nil {
		return
	}
	lane := filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(host))), "Lane.exe")
	command := exec.Command(lane)
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | createNewProcessGrp,
	}
	if command.Start() == nil {
		_ = command.Process.Release()
	}
}

func openLanePipe(path string) (*os.File, error) {
	deadline := time.Now().Add(connectTimeout)
	wokeLane := false
	var lastError error
	for time.Now().Before(deadline) {
		pipe, err := os.OpenFile(path, os.O_RDWR, 0)
		if err == nil {
			return pipe, nil
		}
		lastError = err
		if !wokeLane {
			wakeLane()
			wokeLane = true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, lastError
}

func requestLaneConnection(path string) (controlResponse, error) {
	pipe, err := openLanePipe(path)
	if err != nil {
		return controlResponse{}, err
	}
	defer pipe.Close()
	request, _ := json.Marshal(map[string]any{
		"version": 1,
		"command": "browser-client-connect",
		"params":  map[string]string{"origin": allowedOrigin},
	})
	request = append(request, '\n')
	if _, err := pipe.Write(request); err != nil {
		return controlResponse{}, err
	}
	reader := bufio.NewReader(io.LimitReader(pipe, maxControlResponse+1))
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return controlResponse{}, err
	}
	if len(line) > maxControlResponse {
		return controlResponse{}, errors.New("control response is too large")
	}
	var response controlResponse
	if err := json.Unmarshal(bytesTrimSpace(line), &response); err != nil {
		return controlResponse{}, err
	}
	return response, nil
}

func bytesTrimSpace(value []byte) []byte {
	return []byte(strings.TrimSpace(string(value)))
}

func run() int {
	if len(os.Args) < 2 || strings.TrimSuffix(os.Args[1], "/") !=
		strings.TrimSuffix(allowedOrigin, "/") {
		_ = writeNativeMessage(failure(
			"CALLER_NOT_ALLOWED",
			"This extension is not allowed to connect to Lane.",
			false,
		))
		return 1
	}
	if _, err := readNativeRequest(); err != nil {
		_ = writeNativeMessage(failure("LANE_UNAVAILABLE", "Lane is unavailable.", true))
		return 1
	}
	path, err := pipePath()
	if err != nil {
		_ = writeNativeMessage(failure("LANE_UNAVAILABLE", "Lane is unavailable.", true))
		return 1
	}
	control, err := requestLaneConnection(path)
	if err != nil {
		_ = writeNativeMessage(failure("LANE_UNAVAILABLE", "Lane is unavailable.", true))
		return 1
	}
	response := nativeResponse{
		ProtocolVersion: 1,
		OK:              control.OK,
		Data:            control.Data,
		Error:           control.Error,
	}
	if err := writeNativeMessage(response); err != nil || !control.OK {
		return 1
	}
	return 0
}

func main() {
	os.Exit(run())
}
