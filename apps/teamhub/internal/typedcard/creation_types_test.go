package typedcard

import (
	"reflect"
	"testing"
)

func TestCreationRoomMemberIDsPreservesAssignmentsButFiltersDerivedMembers(t *testing.T) {
	requested := []string{"actor_agent", "actor_owner", "actor_worker"}
	got := creationRoomMemberIDs(requested, "actor_agent", "actor_owner")
	if !reflect.DeepEqual(got, []string{"actor_worker"}) {
		t.Fatalf("Room member IDs=%v", got)
	}
	if !reflect.DeepEqual(requested, []string{"actor_agent", "actor_owner", "actor_worker"}) {
		t.Fatalf("requested assignments mutated: %v", requested)
	}
}

func TestRoomCreationArtifactReferencesPreservesFrozenOrder(t *testing.T) {
	documentIDs, versionIDs, err := roomCreationArtifactReferences([]RoomCreationArtifactSnapshot{
		{DocumentID: "document_brief", DocumentVersionID: "version_brief"},
		{DocumentID: "document_notes", DocumentRevisionID: "revision_notes"},
		{DocumentID: "document_evidence", DocumentVersionID: "version_evidence"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(documentIDs, []string{"document_brief", "document_notes", "document_evidence"}) ||
		!reflect.DeepEqual(versionIDs, []string{"version_brief", "version_evidence"}) {
		t.Fatalf("documents=%v versions=%v", documentIDs, versionIDs)
	}
}

func TestRoomCreationArtifactReferencesRejectsInvalidFrozenSnapshots(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		artifacts []RoomCreationArtifactSnapshot
	}{
		{
			name: "duplicate document",
			artifacts: []RoomCreationArtifactSnapshot{
				{DocumentID: "document_brief", DocumentVersionID: "version_1"},
				{DocumentID: "document_brief", DocumentVersionID: "version_2"},
			},
		},
		{
			name: "duplicate version",
			artifacts: []RoomCreationArtifactSnapshot{
				{DocumentID: "document_1", DocumentVersionID: "version_brief"},
				{DocumentID: "document_2", DocumentVersionID: "version_brief"},
			},
		},
		{
			name: "duplicate revision",
			artifacts: []RoomCreationArtifactSnapshot{
				{DocumentID: "document_1", DocumentRevisionID: "revision_brief"},
				{DocumentID: "document_2", DocumentRevisionID: "revision_brief"},
			},
		},
		{
			name: "both content heads",
			artifacts: []RoomCreationArtifactSnapshot{{
				DocumentID: "document_brief", DocumentVersionID: "version_brief",
				DocumentRevisionID: "revision_brief",
			}},
		},
		{
			name: "malformed extra content head",
			artifacts: []RoomCreationArtifactSnapshot{{
				DocumentID: "document_brief", DocumentVersionID: "version/brief",
				DocumentRevisionID: "revision_brief",
			}},
		},
		{
			name:      "missing content head",
			artifacts: []RoomCreationArtifactSnapshot{{DocumentID: "document_brief"}},
		},
		{
			name:      "invalid identifier",
			artifacts: []RoomCreationArtifactSnapshot{{DocumentID: "document/brief", DocumentVersionID: "version_brief"}},
		},
		{
			name: "too many",
			artifacts: []RoomCreationArtifactSnapshot{
				{DocumentID: "document_1", DocumentVersionID: "version_1"},
				{DocumentID: "document_2", DocumentVersionID: "version_2"},
				{DocumentID: "document_3", DocumentVersionID: "version_3"},
				{DocumentID: "document_4", DocumentVersionID: "version_4"},
				{DocumentID: "document_5", DocumentVersionID: "version_5"},
				{DocumentID: "document_6", DocumentVersionID: "version_6"},
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, _, err := roomCreationArtifactReferences(testCase.artifacts); err == nil {
				t.Fatal("invalid frozen Room artifact snapshot accepted")
			}
		})
	}
}
