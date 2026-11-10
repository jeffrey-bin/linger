package lingercontext

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContextApplyTimingLogsOnlyLowCardinalityPhaseMetrics(t *testing.T) {
	contents := map[string][]byte{
		"/first":  []byte("first secret body"),
		"/second": []byte("second secret body"),
	}
	server := fileServer(t, nil, contents["/first"], contents["/second"])

	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	t.Cleanup(func() {
		_ = filepath.Walk(filepath.Dir(store.root), func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	var logs bytes.Buffer
	store.logger = slog.New(slog.NewJSONHandler(&logs, nil))

	command := testView("view-timing")
	command.Mappings = []Mapping{
		mappingFile("memory", "private-first.txt", contents["/first"]),
		mappingFile("inbox_view", "private-second.txt", contents["/second"]),
	}
	if _, err := store.applyTestView(context.Background(), command, server.URL); err != nil {
		t.Fatal(err)
	}

	line := strings.TrimSpace(logs.String())
	var event map[string]any
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("decode timing log %q: %v", line, err)
	}
	if event["msg"] != "runner.context_view.timing" || event["outcome"] != "success" {
		t.Fatalf("event=%v", event)
	}
	for field, expected := range map[string]float64{
		"file_count":            2,
		"total_bytes":           float64(len(contents["/first"]) + len(contents["/second"])),
		"reused_file_count":     0,
		"download_file_count":   2,
		"local_copy_file_count": 0,
	} {
		if event[field] != expected {
			t.Fatalf("%s=%v, want %v", field, event[field], expected)
		}
	}
	for _, field := range []string{
		"total_ms", "lock_wait_ms", "prepare_ms", "materialize_ms", "admit_ms", "download_wall_ms", "pending_commit_ms",
		"publish_ms", "ready_commit_ms", "cleanup_ms",
	} {
		value, ok := event[field].(float64)
		if !ok || value < 0 {
			t.Fatalf("%s=%v", field, event[field])
		}
	}
	for _, sensitive := range []string{server.URL, "private-first.txt", "private-second.txt", "first secret body"} {
		if strings.Contains(line, sensitive) {
			t.Fatalf("timing log leaked %q: %s", sensitive, line)
		}
	}
}
