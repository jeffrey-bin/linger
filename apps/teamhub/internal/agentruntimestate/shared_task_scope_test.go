package agentruntimestate

import (
	"reflect"
	"testing"
)

func TestSharedTaskScopeUsesFrozenCoordinatorRoom(t *testing.T) {
	roomMeta := `["meta","agent-a","room","room-origin"]`
	coordinators := map[taskCoordinatorKey]string{
		{"tenant-a", "task-shared"}:      roomMeta,
		{"tenant-a", "task-cross-room"}:  `["meta","agent-a"]`,
		{"tenant-a", "task-other-agent"}: `["meta","agent-b","room","room-origin"]`,
		{"tenant-a", "task-alter-ego"}:   `["alter_ego","agent-a","task-parent"]`,
		{"tenant-b", "task-tenant"}:      roomMeta,
	}
	for _, test := range []struct {
		name   string
		tenant string
		ref    ContextRef
		want   *SharedTaskScope
	}{
		{"room meta", "tenant-a", ContextRef{Kind: "meta", AgentID: "agent-a", RoomID: "room-1"},
			&SharedTaskScope{Version: 1, TenantID: "tenant-a", AgentID: "agent-a", OriginRoomID: "room-1", Role: "meta"}},
		{"cross-room meta", "tenant-a", ContextRef{Kind: "meta", AgentID: "agent-a"}, nil},
		{"document", "tenant-a", ContextRef{Kind: "document", AgentID: "agent-a", DocumentID: "doc-1"}, nil},
		{"alter_ego of room meta", "tenant-a", ContextRef{Kind: "alter_ego", AgentID: "agent-a", TaskID: "task-shared"},
			&SharedTaskScope{Version: 1, TenantID: "tenant-a", AgentID: "agent-a", OriginRoomID: "room-origin", Role: "alter_ego", TaskID: "task-shared"}},
		{"human-created task", "tenant-a", ContextRef{Kind: "alter_ego", AgentID: "agent-a", TaskID: "task-none"}, nil},
		{"cross-room coordinator", "tenant-a", ContextRef{Kind: "alter_ego", AgentID: "agent-a", TaskID: "task-cross-room"}, nil},
		{"other agent coordinator", "tenant-a", ContextRef{Kind: "alter_ego", AgentID: "agent-a", TaskID: "task-other-agent"}, nil},
		{"alter_ego coordinator", "tenant-a", ContextRef{Kind: "alter_ego", AgentID: "agent-a", TaskID: "task-alter-ego"}, nil},
		{"other tenant", "tenant-a", ContextRef{Kind: "alter_ego", AgentID: "agent-a", TaskID: "task-tenant"}, nil},
	} {
		if got := sharedTaskScope(test.tenant, test.ref, coordinators); !reflect.DeepEqual(got, test.want) {
			t.Errorf("%s: scope=%+v want %+v", test.name, got, test.want)
		}
	}
}
