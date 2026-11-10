//go:build windows

package process

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

func TestMain(m *testing.M) {
	if os.Getenv("LINGER_ARGV_FIXTURE") == "1" {
		runArgvFixture()
	}
	if len(os.Args) == 2 && os.Args[1] == "supervise-service" {
		if err := SuperviseManagedService(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if len(os.Args) == 3 && os.Args[1] == "managed-service-parent" {
		state := os.Args[2]
		registry, err := NewManagedServiceRegistry(state, serviceTestEnvironment())
		if err == nil {
			_, err = registry.Start(context.Background(), ManagedServiceStart{Name: "preview", Command: os.Args[0], Args: []string{"managed-service-worker", state}, Cwd: state})
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if len(os.Args) == 3 && os.Args[1] == "managed-service-worker" {
		state := os.Args[2]
		child := exec.Command(os.Args[0], "managed-service-child")
		if err := child.Start(); err != nil {
			os.Exit(1)
		}
		data, _ := json.Marshal(child.Process.Pid)
		_ = os.WriteFile(filepath.Join(state, "child.json"), data, 0o600)
		for {
			time.Sleep(time.Second)
		}
	}
	if len(os.Args) == 2 && os.Args[1] == "managed-service-child" {
		for {
			time.Sleep(time.Second)
		}
	}
	os.Exit(m.Run())
}

func TestManagedServiceRefusesPreexistingJob(t *testing.T) {
	self, err := winprocess.Inspect(os.Getpid())
	if err != nil || self == nil {
		t.Fatalf("self=%+v err=%v", self, err)
	}
	identity := managedProcessIdentity{PID: self.PID, ProcessGroupID: self.PID, StartToken: self.StartTime}
	job, err := createServiceJob(identity)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	duplicate, err := createServiceJob(identity)
	if duplicate != 0 {
		windows.CloseHandle(duplicate)
	}
	if err == nil || duplicate != 0 {
		t.Fatal("preexisting Job was adopted")
	}
	opened, err := openServiceJob(identity)
	if err != nil {
		t.Fatalf("original Job changed: %v", err)
	}
	windows.CloseHandle(opened)
}
func serviceTestEnvironment() map[string]string {
	result := map[string]string{}
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			result[key] = value
		}
	}
	return result
}
func TestManagedServiceSurvivesStartingProcessExitAndStopsDescendants(t *testing.T) {
	state := t.TempDir()
	parent := exec.Command(os.Args[0], "managed-service-parent", state)
	if output, err := parent.CombinedOutput(); err != nil {
		t.Fatalf("parent: %v %s", err, output)
	}
	registry, err := NewManagedServiceRegistry(state, serviceTestEnvironment())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = registry.Stop(context.Background(), "preview") })
	listed, err := registry.List(context.Background())
	if err != nil || len(listed) != 1 {
		t.Fatalf("surviving services=%+v err=%v", listed, err)
	}
	var childPID int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(state, "child.json")); err == nil && json.Unmarshal(data, &childPID) == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID < 1 {
		t.Fatal("service child never started")
	}
	child, err := winprocess.Inspect(childPID)
	if err != nil || child == nil {
		t.Fatalf("child identity=%+v err=%v", child, err)
	}
	if _, err := registry.Stop(context.Background(), "preview"); err != nil {
		t.Fatal(err)
	}
	if current, err := winprocess.Inspect(childPID); err != nil || current != nil {
		t.Fatalf("child %s survived stop: %+v %v", strconv.Itoa(childPID), current, err)
	}
}
