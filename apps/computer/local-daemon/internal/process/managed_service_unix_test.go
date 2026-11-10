//go:build !windows

package process

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestManagedServiceSurvivesRegistryRestartAndStopsProcessGroup(t *testing.T) {
	state := t.TempDir()
	registry, err := NewManagedServiceRegistry(state, map[string]string{
		"PATH": "/usr/bin:/bin", "HOME": state,
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := registry.Start(context.Background(), ManagedServiceStart{
		Name: "preview", Command: "/bin/sh", Cwd: state,
		Args: []string{"-c", "trap 'exit 0' TERM; while :; do sleep 1; done"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if service == nil || service.State != "running" || service.PID < 1 {
		t.Fatalf("started service = %+v", service)
	}
	if duplicate, err := registry.Start(context.Background(), ManagedServiceStart{
		Name: "preview", Command: "/bin/sh", Cwd: state, Args: []string{"-c", "exit 1"},
	}); err != nil || duplicate != nil {
		t.Fatalf("duplicate start = %+v err=%v", duplicate, err)
	}
	restarted, err := NewManagedServiceRegistry(state, map[string]string{"PATH": "/usr/bin:/bin", "HOME": state})
	if err != nil {
		t.Fatal(err)
	}
	listed, err := restarted.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].PID != service.PID {
		t.Fatalf("restarted list = %+v err=%v", listed, err)
	}
	stopped, err := restarted.Stop(context.Background(), "preview")
	if err != nil || stopped == nil || stopped.PID != service.PID {
		t.Fatalf("stopped service = %+v err=%v", stopped, err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(state, "managed-services", "preview.json")); os.IsNotExist(err) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if listed, err := restarted.List(context.Background()); err != nil || len(listed) != 0 {
		t.Fatalf("services after stop = %+v err=%v", listed, err)
	}
}

func TestManagedServiceStartKeepsThePreviousRunLog(t *testing.T) {
	state := t.TempDir()
	registry, err := NewManagedServiceRegistry(state, map[string]string{"PATH": "/usr/bin:/bin", "HOME": state})
	if err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(state, "service-logs", "preview.log")
	for _, run := range []string{"first", "second", "third"} {
		if _, err := registry.Start(context.Background(), ManagedServiceStart{
			Name: "preview", Command: "/bin/sh", Cwd: state, Args: []string{"-c", "echo " + run},
		}); err != nil {
			t.Fatal(err)
		}
		// Start rotates only once the previous run has exited.
		deadline := time.Now().Add(3 * time.Second)
		for {
			content, _ := os.ReadFile(logPath)
			listed, err := registry.List(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if string(content) == run+"\n" && len(listed) == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s run log=%q services=%+v", run, content, listed)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if previous, err := os.ReadFile(logPath + ".1"); err != nil || string(previous) != "second\n" {
		t.Fatalf("previous run log=%q err=%v", previous, err)
	}
}
