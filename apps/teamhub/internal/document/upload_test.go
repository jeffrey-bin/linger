package document

import (
	"crypto/sha256"
	"fmt"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

func TestUploadIdentityMatrixSeparatesSourcesAndKeepsReplaysStable(t *testing.T) {
	// Identity is independent of wall time: same-content requests made in one
	// clock tick or after a clock step retain distinct keys and stable replays.
	// Real transaction replay, unique facts, and monotonic timestamps remain in
	// TestUnifiedDocumentWritesSurviveClockRegression's PostgreSQL boundary cases.
	target := uploadDocumentTarget{Kind: uploadDocumentContextWiki, TenantID: "tenant_document_a", ContextID: "wiki_document_a"}
	object := artifactstore.Object{Key: "first-object", Size: int64(len("Wiki source")), SHA256: sha256.Sum256([]byte("Wiki source"))}
	seenDocuments, seenVersions := map[string]bool{}, map[string]bool{}
	for index := range 96 {
		input := UploadDocumentInput{
			AccountID: "account_document_a", IdempotencyKey: fmt.Sprintf("clock-wiki-source-%03d", index),
			Filename: fmt.Sprintf("source-%03d.txt", index), RepresentationFormat: "plain_text", MediaType: "text/plain",
		}
		id, version := uploadDocumentIdentity("actor_human_a", target.Kind, input.IdempotencyKey, object.SHA256)
		if seenDocuments[id] || seenVersions[version] {
			t.Fatalf("source %d collides with an earlier Document or Version", index)
		}
		seenDocuments[id], seenVersions[version] = true, true
		replayObject := object
		replayObject.Key = "replayed-object"
		replayID, replayVersion := uploadDocumentIdentity("actor_human_a", target.Kind, input.IdempotencyKey, replayObject.SHA256)
		if replayID != id || replayVersion != version {
			t.Fatalf("source %d replay identity changed: Document %s != %s, Version %s != %s", index, replayID, id, replayVersion, version)
		}
		hash := uploadDocumentRequestHash(input, target, object)
		if uploadDocumentRequestHash(input, target, replayObject) != hash {
			t.Fatalf("source %d replay conflicts because object storage generated a new key", index)
		}
		changed := object
		changed.SHA256 = sha256.Sum256([]byte("Changed source"))
		changedID, changedVersion := uploadDocumentIdentity("actor_human_a", target.Kind, input.IdempotencyKey, changed.SHA256)
		if changedID != id {
			t.Fatalf("source %d changed content moved its Document: %s != %s", index, changedID, id)
		}
		if uploadDocumentRequestHash(input, target, changed) == hash ||
			changedVersion == version {
			t.Fatalf("source %d changed content reused its request or Version identity", index)
		}
	}
	if len(seenDocuments) != 96 || len(seenVersions) != 96 {
		t.Fatalf("identity matrix has %d Documents and %d Versions; want 96 each", len(seenDocuments), len(seenVersions))
	}
}

func TestUploadIdentitySeparatesActorAndIdempotencyKey(t *testing.T) {
	contentSHA256 := sha256.Sum256([]byte("Wiki source"))
	documentID, versionID := uploadDocumentIdentity("actor_human_a", uploadDocumentContextWiki, "upload-key-a", contentSHA256)
	for _, testCase := range []struct {
		name, actorID, contextKind, idempotencyKey string
	}{
		{name: "actor", actorID: "actor_agent_a", contextKind: uploadDocumentContextWiki, idempotencyKey: "upload-key-a"},
		{name: "idempotency key", actorID: "actor_human_a", contextKind: uploadDocumentContextWiki, idempotencyKey: "upload-key-b"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			otherDocumentID, otherVersionID := uploadDocumentIdentity(testCase.actorID, testCase.contextKind, testCase.idempotencyKey, contentSHA256)
			if otherDocumentID == documentID || otherVersionID == versionID {
				t.Fatalf("distinct upload scope shares identity: Document %s, Version %s", otherDocumentID, otherVersionID)
			}
		})
	}
}

func TestUploadIdentitySeparatesOperations(t *testing.T) {
	contentSHA256 := sha256.Sum256([]byte("Wiki source"))
	contextKinds := []string{"", uploadDocumentContextRoom, uploadDocumentContextTask, uploadDocumentContextWiki}
	for _, contextKind := range contextKinds {
		t.Run(uploadOperation(contextKind), func(t *testing.T) {
			documentID, versionID := uploadDocumentIdentity("actor_human_a", contextKind, "upload-key-a", contentSHA256)
			for _, otherContextKind := range contextKinds {
				if otherContextKind == contextKind {
					continue
				}
				otherDocumentID, otherVersionID := uploadDocumentIdentity("actor_human_a", otherContextKind, "upload-key-a", contentSHA256)
				if otherDocumentID == documentID || otherVersionID == versionID {
					t.Fatalf("operations %s and %s share identity: Document %s, Version %s", uploadOperation(contextKind), uploadOperation(otherContextKind), documentID, versionID)
				}
			}
		})
	}
}
