package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

type fakeComputerPermissions struct {
	calls    []string
	deadline time.Time
	err      error
}

func (f *fakeComputerPermissions) ComputerPermission(ctx context.Context, action, subject, permission string) (localtools.ComputerPermissionStatus, error) {
	f.calls = append(f.calls, action+"/"+subject+"/"+permission)
	f.deadline, _ = ctx.Deadline()
	if f.err != nil {
		return localtools.ComputerPermissionStatus{}, f.err
	}
	return localtools.ComputerPermissionStatus{Platform: "darwin", Host: "desktop", Subjects: []localtools.ComputerPermissionGroup{{
		Subject: "linger", Permissions: []localtools.ComputerPermissionState{{ID: "screen_recording", State: "granted", Prompt: "available"}},
	}}}, nil
}

func TestComputerPermissionCommandEchoesIdentityAndOutcome(t *testing.T) {
	permissions := &fakeComputerPermissions{}
	d := &Daemon{computerID: "computer", computerPermissions: permissions, owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}}}
	expires := time.Now().Add(time.Minute).UTC().Truncate(time.Second)
	send := func(fields map[string]any) map[string]any {
		t.Helper()
		request := map[string]any{"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "owner", "expires_at": expires}
		for key, value := range fields {
			request[key] = value
		}
		payload, _ := json.Marshal(request)
		stream := &browserEventStream{}
		command := protocol.Command{Type: protocol.CommandCapabilityComputerPermission, ProtocolVersion: "2", CommandID: "command-1", RunnerID: "computer", ConnectionEpoch: 7, Payload: payload}
		if err := d.handleComputerPermissionCommand(t.Context(), stream, command); err != nil {
			t.Fatal(err)
		}
		if len(stream.events) != 1 {
			t.Fatalf("events = %+v", stream.events)
		}
		event := stream.events[0]
		var result map[string]any
		if err := json.Unmarshal(event.Payload, &result); err != nil {
			t.Fatal(err)
		}
		wantRoute := protocol.EventCapabilityComputerPermissionSucceeded
		if result["outcome"] == "failed" {
			wantRoute = protocol.EventCapabilityComputerPermissionFailed
		}
		if event.Type != wantRoute || event.CommandID != "command-1" || event.ConnectionEpoch != 7 || event.TenantID != request["tenant_id"] ||
			result["type"] != "executed" || result["kind"] != "computer_permission" || result["command_id"] != "command-1" ||
			result["runner_id"] != "computer" || result["connection_epoch"] != float64(7) || result["protocol_version"] != "2" ||
			result["expires_at"] != request["expires_at"].(time.Time).UTC().Format(time.RFC3339Nano) || result["action"] != request["action"] {
			t.Fatalf("identity was not echoed: %s %v", event.Type, result)
		}
		return result
	}
	for _, action := range []map[string]any{
		{"action": "status"},
		{"action": "prompt", "subject": "linger", "permission": "screen_recording"},
		{"action": "open_settings", "subject": "computer_use", "permission": "accessibility"},
		{"action": "relaunch", "subject": "linger"},
	} {
		result := send(action)
		if result["outcome"] != "succeeded" || result["status"].(map[string]any)["platform"] != "darwin" {
			t.Fatalf("%v: %v", action, result)
		}
	}
	if want := []string{"status//", "prompt/linger/screen_recording", "open_settings/computer_use/accessibility", "relaunch/linger/"}; !slices.Equal(permissions.calls, want) {
		t.Fatalf("calls = %v", permissions.calls)
	}
	if !permissions.deadline.Equal(expires) {
		t.Fatalf("permission work may outlive the Gateway wait: %v", permissions.deadline)
	}

	failure := func(result map[string]any) string {
		t.Helper()
		if result["outcome"] != "failed" || result["status"] != nil {
			t.Fatalf("result = %v", result)
		}
		return result["error"].(map[string]any)["code"].(string)
	}
	if code := failure(send(map[string]any{"action": "status", "owner_actor_id": "intruder"})); code != "COMPUTER_PERMISSION_INVALID" {
		t.Fatalf("another owner reached permissions: %s", code)
	}
	if code := failure(send(map[string]any{"action": "status", "expires_at": time.Now().Add(-time.Second).UTC()})); code != "COMPUTER_PERMISSION_TIMEOUT" {
		t.Fatalf("expired: %s", code)
	}
	calls := len(permissions.calls)
	permissions.err = &localtools.ComputerPermissionError{Code: "COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE", Message: "no", Retryable: false}
	if code := failure(send(map[string]any{"action": "relaunch", "subject": "linger"})); code != "COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE" {
		t.Fatalf("typed failure: %s", code)
	}
	permissions.err = errors.New("/Users/someone/private path")
	result := send(map[string]any{"action": "status"})
	if code := failure(result); code != "COMPUTER_PERMISSION_UNAVAILABLE" || result["error"].(map[string]any)["message"] == "/Users/someone/private path" {
		t.Fatalf("internal failure leaked: %v", result)
	}
	if len(permissions.calls) != calls+2 {
		t.Fatalf("rejected requests reached the service: %v", permissions.calls)
	}

	d.computerPermissions = nil
	if code := failure(send(map[string]any{"action": "status"})); code != "COMPUTER_PERMISSION_UNSUPPORTED" {
		t.Fatalf("missing service: %s", code)
	}
}

func TestComputerPermissionsCapabilityIsAlwaysAdvertised(t *testing.T) {
	if got := (&Daemon{}).capabilities(); len(got) != 1 || got[0] != "computer_permissions" {
		t.Fatalf("capabilities = %v", got)
	}
	d := &Daemon{browserConnections: &deadlineBrowserConnections{}}
	if got := d.capabilities(); len(got) != 2 || got[0] != "computer_permissions" || got[1] != "browser_connection" {
		t.Fatalf("capabilities = %v", got)
	}
}
