package lingercontext

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLiveTaskFilesWithoutMetaMountSurviveRestartAndRejectOtherScopes(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	scope := alterScope("task-1", "room-1")
	alter := applyScoped(t, fixture.store, scopedView("alter-1", testAlterKey, scope))
	content := bytes.Repeat([]byte("output"), 100000)
	taskDir := filepath.Join(alter.WorkspacePath, "playground", "task-1")
	if err := os.WriteFile(filepath.Join(taskDir, "report.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	fixture.reopen(t)
	var recovered []byte
	var offset int64
	for {
		args, _ := json.Marshal(map[string]any{"path": "report.txt", "offset": offset})
		result, err := fixture.store.ReadLiveTaskFiles(t.Context(), *scope, "read_file", args)
		if err != nil {
			t.Fatal(err)
		}
		chunk, err := base64.StdEncoding.DecodeString(result["data_base64"].(string))
		if err != nil {
			t.Fatal(err)
		}
		recovered = append(recovered, chunk...)
		offset = result["next_offset"].(int64)
		if result["eof"] == true {
			break
		}
	}
	if !bytes.Equal(recovered, content) {
		t.Fatal("Live did not read the actual Task output")
	}
	listed, err := fixture.store.ReadLiveTaskFiles(t.Context(), *scope, "list_files", json.RawMessage(`{}`))
	if err != nil || len(listed["files"].([]map[string]any)) != 1 {
		t.Fatalf("list=%v %v", listed, err)
	}
	for _, wrong := range []SharedTaskScope{{Version: 1, TenantID: "other", AgentID: scope.AgentID, OriginRoomID: scope.OriginRoomID, TaskID: scope.TaskID, Role: scope.Role}, {Version: 1, TenantID: scope.TenantID, AgentID: scope.AgentID, OriginRoomID: "other", TaskID: scope.TaskID, Role: scope.Role}, {Version: 1, TenantID: scope.TenantID, AgentID: "other", OriginRoomID: scope.OriginRoomID, TaskID: scope.TaskID, Role: scope.Role}} {
		if _, err := fixture.store.ReadLiveTaskFiles(t.Context(), wrong, "read_file", json.RawMessage(`{"path":"report.txt"}`)); !errors.Is(err, ErrSharedTaskScope) {
			t.Fatalf("cross-scope read=%v", err)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTestFileLink(t, outside, filepath.Join(taskDir, "link")); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"../secret", outside, "link"} {
		args, _ := json.Marshal(map[string]string{"path": filename})
		if _, err := fixture.store.ReadLiveTaskFiles(t.Context(), *scope, "read_file", args); err == nil {
			t.Fatalf("unsafe path accepted: %s", filename)
		}
	}
}
