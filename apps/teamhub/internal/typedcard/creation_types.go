package typedcard

import (
	"regexp"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

var creationActorIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

type RoomCreationSnapshot struct {
	OriginRoomID           string                         `json:"origin_room_id"`
	Name                   string                         `json:"name"`
	Description            *string                        `json:"description"`
	MemberIDs              []string                       `json:"member_ids"`
	Artifacts              []RoomCreationArtifactSnapshot `json:"artifacts,omitempty"`
	InitialMessageSegments []messagecreation.Segment      `json:"initial_message_segments"`
}

type RoomCreationArtifactSnapshot struct {
	DocumentID         string `json:"document_id"`
	DocumentVersionID  string `json:"document_version_id,omitempty"`
	DocumentRevisionID string `json:"document_revision_id,omitempty"`
}

func roomCreationArtifactReferences(
	artifacts []RoomCreationArtifactSnapshot,
) ([]string, []string, error) {
	if len(artifacts) > 5 {
		return nil, nil, ErrConflict
	}
	documentIDs := make([]string, 0, len(artifacts))
	versionIDs := make([]string, 0, len(artifacts))
	seenDocuments := make(map[string]struct{}, len(artifacts))
	seenContentHeads := make(map[string]struct{}, len(artifacts))
	for _, artifact := range artifacts {
		hasVersion := artifact.DocumentVersionID != ""
		hasRevision := artifact.DocumentRevisionID != ""
		if !creationActorIDPattern.MatchString(artifact.DocumentID) || hasVersion == hasRevision ||
			hasVersion && !creationActorIDPattern.MatchString(artifact.DocumentVersionID) ||
			hasRevision && !creationActorIDPattern.MatchString(artifact.DocumentRevisionID) {
			return nil, nil, ErrConflict
		}
		if _, exists := seenDocuments[artifact.DocumentID]; exists {
			return nil, nil, ErrConflict
		}
		contentHeadID := artifact.DocumentVersionID
		if hasRevision {
			contentHeadID = artifact.DocumentRevisionID
		}
		if _, exists := seenContentHeads[contentHeadID]; exists {
			return nil, nil, ErrConflict
		}
		seenDocuments[artifact.DocumentID] = struct{}{}
		seenContentHeads[contentHeadID] = struct{}{}
		documentIDs = append(documentIDs, artifact.DocumentID)
		if hasVersion {
			versionIDs = append(versionIDs, artifact.DocumentVersionID)
		}
	}
	return documentIDs, versionIDs, nil
}

func creationRoomMemberIDs(requested []string, creatorID, ownerID string) []string {
	result := make([]string, 0, len(requested))
	for _, actorID := range requested {
		if actorID != creatorID && actorID != ownerID {
			result = append(result, actorID)
		}
	}
	return result
}
