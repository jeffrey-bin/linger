package agentauth

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestRetiredBuilderCannotAcquireBusinessCapability(t *testing.T) {
	builder := Authorization{Principal: &agentcredential.Principal{AgentType: "builder"}}
	for _, tool := range []string{"send_message", "create_document", "update_agent", "apply_document_semantic_mutation"} {
		if businessCapability(builder, tool) {
			t.Fatalf("retired Builder can execute %s", tool)
		}
	}
	for _, tool := range []string{"set_agent_build_status", "update_name", "update_prompt", "update_skills", "set_profile"} {
		if businessAction(tool) {
			t.Fatalf("retired capability %s is still exposed", tool)
		}
	}
	for _, agentType := range []string{"general", "anotherme"} {
		if !businessCapability(Authorization{Principal: &agentcredential.Principal{AgentType: agentType}}, "send_message") {
			t.Fatalf("ordinary %s collaboration was rejected", agentType)
		}
	}
}

func TestAllowsRoomTargetRequiresCallerRoomContext(t *testing.T) {
	for _, test := range []struct {
		name      string
		authority Authorization
		roomID    string
		want      bool
	}{
		{name: "same Room Context", authority: Authorization{RoomID: "room_a"}, roomID: "room_a", want: true},
		{name: "no Room Context", authority: Authorization{}, roomID: "room_a"},
		{name: "another Room Context", authority: Authorization{RoomID: "room_b"}, roomID: "room_a"},
		{name: "empty target Room", authority: Authorization{RoomID: "room_a"}, roomID: ""},
		{name: "Task participant gets no other Room", authority: Authorization{RoomID: "room_work", ParticipantTaskID: "task_1"}, roomID: "room_a"},
		{name: "Task participant still needs a Room", authority: Authorization{ParticipantTaskID: "task_1"}, roomID: ""},
	} {
		if got := AllowsRoomTarget(test.authority, test.roomID); got != test.want {
			t.Errorf("%s: AllowsRoomTarget=%v want %v", test.name, got, test.want)
		}
	}
}

func TestAgentManagementActionsNeedAMetaContext(t *testing.T) {
	for _, action := range []string{"list_available_agents", "get_agent", "create_agent", "update_agent"} {
		if !businessAction(action) {
			t.Fatalf("%s is not exposed", action)
		}
		for _, agentType := range []string{"general", "anotherme"} {
			meta := Authorization{Principal: &agentcredential.Principal{AgentType: agentType}}
			if !businessCapability(meta, action) {
				t.Fatalf("%s meta cannot run %s", agentType, action)
			}
			task, document := meta, meta
			task.ParticipantTaskID = "task_1"
			document.Target.Kind = "document"
			if businessCapability(task, action) || businessCapability(document, action) {
				t.Fatalf("%s %s ran outside a meta Context", agentType, action)
			}
		}
	}
}

func TestRoomMemberAdditionNeedsTheMetaOfARoom(t *testing.T) {
	if !businessAction("add_room_member") {
		t.Fatal("add_room_member is not exposed")
	}
	for _, agentType := range []string{"general", "anotherme"} {
		principal := &agentcredential.Principal{AgentType: agentType}
		for _, test := range []struct {
			name      string
			authority Authorization
			want      bool
		}{
			{name: "Room Meta", authority: Authorization{Principal: principal, Target: Target{Kind: "room", ID: "room_1"}, RoomID: "room_1"}, want: true},
			{name: "no Context", authority: Authorization{Principal: principal}},
			{name: "Task", authority: Authorization{Principal: principal, Target: Target{Kind: "task", ID: "task_1"}, RoomID: "room_1", ParticipantTaskID: "task_1"}},
			{name: "document", authority: Authorization{Principal: principal, Target: Target{Kind: "document", ID: "document_1"}}},
		} {
			if got := businessCapability(test.authority, "add_room_member"); got != test.want {
				t.Errorf("%s %s: allowed=%v want %v", agentType, test.name, got, test.want)
			}
		}
	}
}

func TestOwnerProfileActionsNeedAnAnotherMeWithAnOwner(t *testing.T) {
	principal := func(agentType, owner string) *agentcredential.Principal {
		return &agentcredential.Principal{AgentType: agentType, UserArtifactOwnerActorID: owner}
	}
	for _, action := range []string{"get_personal_profile", "write_personal_profile", "start_personal_profile_build", "get_account_profile", "update_account_profile"} {
		if !businessAction(action) {
			t.Fatalf("%s is not exposed", action)
		}
		for _, test := range []struct {
			name      string
			authority Authorization
			want      bool
		}{
			{name: "AnotherMe Meta", authority: Authorization{Principal: principal("anotherme", "actor_human")}, want: true},
			{name: "AnotherMe Task", authority: Authorization{Principal: principal("anotherme", "actor_human"), ParticipantTaskID: "task_1"}, want: true},
			{name: "general Agent", authority: Authorization{Principal: principal("general", "actor_human")}},
			{name: "document target", authority: Authorization{Principal: principal("anotherme", "actor_human"), Target: Target{Kind: "document", ID: "document_1"}}},
			{name: "no owner", authority: Authorization{Principal: principal("anotherme", "")}},
		} {
			if got := businessCapability(test.authority, action); got != test.want {
				t.Errorf("%s %s: allowed=%v want %v", test.name, action, got, test.want)
			}
		}
	}
}

// Without a Composio API key the connected app actions that reach Composio
// leave the allowlist; saving a key brings them back on the next request.
// Listing grants stays allowed so the Agent can ask for the key.
func TestConnectedAppActionsNeedAComposioKey(t *testing.T) {
	configured := false
	service := New(nil)
	service.SetConnectedApps(func() bool { return configured })
	if !service.actionConfigured("list_connected_apps") {
		t.Fatal("listing grants must not need a Composio key")
	}
	appActions := []string{"search_app_tools", "execute_app_tool", "manage_auto_reminders"}
	for _, action := range appActions {
		if !businessAction(action) {
			t.Fatalf("%s is not in the allowlist", action)
		}
		if service.actionConfigured(action) {
			t.Fatalf("%s is allowed without a Composio key", action)
		}
	}
	if !service.actionConfigured("send_message") || !service.actionConfigured("create_routine") {
		t.Fatal("actions without a configuration premise must stay allowed")
	}
	configured = true
	for _, action := range appActions {
		if !service.actionConfigured(action) {
			t.Fatalf("%s is refused with a Composio key", action)
		}
	}
	if !New(nil).actionConfigured("execute_app_tool") {
		t.Fatal("a Service without the capability check must not refuse app actions")
	}
}
