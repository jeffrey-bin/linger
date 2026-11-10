package computercli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLogsTailCompleteLinesAndRedactCredentials(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "config.json")
	writeFile(t, configPath, `{"state_directory":`+quote(state)+`}`)
	writeFile(t, filepath.Join(state, "daemon.log"), "old line\nAuthorization: Bearer secret-token\n{\"token\":\"abc\",\"ok\":1}\nproxy https://user:pass@example.test/x\n")
	var output strings.Builder
	if err := streamComputerLogs(context.Background(), logRequest{configPath: configPath, lines: 3}, &output); err != nil {
		t.Fatal(err)
	}
	want := "Authorization: [REDACTED]\n{\"token\":[REDACTED],\"ok\":1}\nproxy https://[REDACTED]@example.test/x\n"
	if output.String() != want {
		t.Fatalf("logs=%q", output.String())
	}
}

func TestLogsReadTheDaemonLogAfterAFailedSetupRemovedTheConfig(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "state", "daemon.log"), "setup failed\n")
	var output strings.Builder
	if err := streamComputerLogs(context.Background(), logRequest{configPath: filepath.Join(root, "config.json"), lines: 200}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "setup failed\n" {
		t.Fatalf("logs=%q", output.String())
	}
}

func TestLogsFollowPrintsAppendedLines(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "state", "daemon.log")
	writeFile(t, logPath, "first\n")
	ctx, cancel := context.WithCancel(context.Background())
	output := &syncBuilder{}
	done := make(chan error, 1)
	go func() {
		done <- streamComputerLogs(ctx, logRequest{configPath: filepath.Join(root, "config.json"), lines: 10, follow: true}, output)
	}()
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString("password=hunter2\npartial")
	_ = file.Close()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(output.String(), "password=[REDACTED]\n") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if output.String() != "first\npassword=[REDACTED]\npartial" {
		t.Fatalf("followed=%q", output.String())
	}
}
