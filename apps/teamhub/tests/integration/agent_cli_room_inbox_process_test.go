//go:build integration_process

package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// The standalone CLI reads another Room or Thread the Agent belongs to through
// an explicit Inbox, and TeamHub refuses a Room, or a Thread of a Room, it is
// not a member of.
func TestAgentCLIReadsAnotherRoomInbox(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	env, alice := newAgentRunEnv(t, "http://unused-agent.invalid")
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("create Direct Room: %d %v %s", direct.status, direct.err, direct.body)
	}
	memberRoomID := direct.roomID
	const memberMarker = "cli-room-inbox-member-marker"
	env.createMessage(alice, memberRoomID, memberMarker, "cli-room-inbox-member")
	otherRoomID := env.createRoom(alice, acmeTenant, "CLI Room Inbox Other", "cli-room-inbox-other-room")
	const otherMarker = "cli-room-inbox-secret-marker"
	env.createMessage(alice, otherRoomID, otherMarker, "cli-room-inbox-other")
	thread := func(roomID, rootID, marker string) string {
		insertHistoryFixture(t, env, roomID, rootID, "conversation", "Thread root "+rootID)
		created := requestMessageThread(t, env, alice, roomID, rootID, rootID+"-thread")
		if created.room.ID == "" {
			t.Fatalf("create Thread: %d %s", created.status, created.body)
		}
		env.createMessage(alice, created.room.ID, marker, rootID+"-reply")
		return created.room.ID
	}
	const memberThreadMarker = "cli-room-inbox-member-thread-marker"
	memberThreadID := thread(memberRoomID, "cli_room_inbox_member_root", memberThreadMarker)
	const otherThreadMarker = "cli-room-inbox-secret-thread-marker"
	otherThreadID := thread(otherRoomID, "cli_room_inbox_other_root", otherThreadMarker)
	credential, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "room inbox read")
	if err != nil {
		t.Fatal(err)
	}
	read := func(inboxID string) ([]byte, error) {
		command := exec.Command("node", "apps/teamhub-cli/dist/teamhub.js", "message", "read", "--inbox", inboxID, "--json")
		command.Dir = repositoryPath()
		command.Env = append(withoutEnv(os.Environ(), "TEAMHUB_CONFIG", "TEAMHUB_PROFILE", "TEAMHUB_TOKEN", "TEAMHUB_TOKEN_FILE", "TEAMHUB_URL"), "TEAMHUB_URL="+env.server.URL, "TEAMHUB_TOKEN="+credential.AccessToken)
		return command.CombinedOutput()
	}
	for _, allowed := range []struct{ inbox, marker string }{
		{"room:" + memberRoomID, memberMarker},
		{"thread:" + memberThreadID, memberThreadMarker},
	} {
		body, err := read(allowed.inbox)
		if err != nil || !bytes.Contains(body, []byte(allowed.marker)) {
			t.Fatalf("read %s: err=%v body=%s", allowed.inbox, err, body)
		}
	}
	for _, refused := range []struct{ inbox, marker string }{
		{"room:" + otherRoomID, otherMarker},
		{"thread:" + otherThreadID, otherThreadMarker},
	} {
		body, err := read(refused.inbox)
		if err == nil || bytes.Contains(body, []byte(refused.marker)) {
			t.Fatalf("read %s: err=%v body=%s", refused.inbox, err, body)
		}
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if decodeErr := json.Unmarshal(bytes.TrimSpace(body), &failure); decodeErr != nil || failure.Error.Code != "NOT_FOUND" {
			t.Fatalf("read %s error: decode=%v body=%s", refused.inbox, decodeErr, body)
		}
	}
}
