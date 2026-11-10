package document

import (
	"context"
	"errors"
	"fmt"
	"path"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// CreateMessageTreeTx publishes an Agent's directory as new Documents inside
// the message transaction that delivers it. Every file becomes a new Document
// with its first Version; a target that already exists fails the whole tree.
// The message transaction owns replay.
func (s *Service) CreateMessageTreeTx(ctx context.Context, tx pgx.Tx, input AgentTreePublicationInput, files []AgentTreeStableFile) (AgentTreePublicationResult, error) {
	normalized, err := normalizeAgentTreeInput(input)
	if err != nil {
		return AgentTreePublicationResult{}, err
	}
	if input.Principal == nil || input.ContextID == "" || input.OperationID == "" || len(input.OperationID) > 255 {
		return AgentTreePublicationResult{}, ErrInvalidInput
	}
	byPath := map[string]AgentTreeStableFile{}
	for _, file := range files {
		if _, ok := byPath[file.RelativePath]; ok {
			return AgentTreePublicationResult{}, ErrInvalidInput
		}
		byPath[file.RelativePath] = file
	}
	principal := *input.Principal
	roomID, err := lockPublicationRoom(ctx, tx, principal, input.ContextID)
	if err != nil {
		return AgentTreePublicationResult{}, err
	}
	groupID := stableCreateID("document_publication_group_", principal.AgentActorID, input.OperationID)
	output := AgentTreePublicationResult{Status: "accepted", PublicationGroupID: groupID,
		RootPlacementPath: agentTreeRootPath(input.DirectoryPath), FileCount: normalized.fileCount,
		DirectoryCount: normalized.directoryCount, TotalBytes: normalized.totalBytes,
		Documents: []AgentTreePublishedDocument{}}
	entryPath := agentTreeEntryRelativePath(normalized)
	var published []publishedFile
	for _, entry := range normalized.Entries {
		if entry.Kind != "file" {
			continue
		}
		file, ok := byPath[entry.RelativePath]
		if !ok || file.SizeBytes != entry.SizeBytes || file.SHA256 != entry.SHA256 || file.MediaType != entry.MediaType ||
			!validPublicationText(file.MediaType, 255) || !validPublicationText(file.ObjectKey, 1024) ||
			!documentAssetSHA256.MatchString(file.SHA256) || file.SizeBytes < 0 {
			return AgentTreePublicationResult{}, ErrInvalidInput
		}
		targetKey := agentTreeTargetKey(input.DirectoryPath, entry.RelativePath)
		published = append(published, publishedFile{
			DocumentID: stableCreateID("document_", principal.TenantID, principal.AgentActorID, roomID, targetKey),
			VersionID:  stableCreateID("document_version_", groupID, fmt.Sprintf("%d", len(published)+1), targetKey),
			Filename:   path.Base(entry.RelativePath), RepresentationFormat: treeFileFormat(entry.RelativePath),
			File: file,
		})
	}
	if len(files) != len(published) || len(published) == 0 || len(published) > 64 {
		return AgentTreePublicationResult{}, ErrInvalidInput
	}
	documentIDs := make([]string, len(published))
	for index, item := range published {
		documentIDs[index] = item.DocumentID
	}
	if err := Lock(ctx, tx, documentIDs); err != nil {
		return AgentTreePublicationResult{}, err
	}
	for _, item := range published {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM documents WHERE id=$1)`,
			item.DocumentID).Scan(&exists); err != nil {
			return AgentTreePublicationResult{}, err
		}
		if exists {
			return AgentTreePublicationResult{}, ErrAgentTreePathConflict
		}
		if err := commitAgentFileVersion(ctx, tx, principal, input.OperationID, item); err != nil {
			return AgentTreePublicationResult{}, err
		}
		if err := bindPublishedDocument(ctx, tx, principal.TenantID, item.DocumentID,
			stableCreateID("document_binding_", groupID, item.DocumentID), "room", roomID); err != nil {
			return AgentTreePublicationResult{}, err
		}
		if err := appendLifecycleEvent(ctx, tx, principal.TenantID, item.DocumentID,
			principal.AgentActorID, item.VersionID, "publication_item", "document.created"); err != nil {
			return AgentTreePublicationResult{}, err
		}
		output.Documents = append(output.Documents, AgentTreePublishedDocument{
			RelativePath: item.File.RelativePath, DocumentID: item.DocumentID, DocumentVersionID: item.VersionID,
		})
		if item.File.RelativePath == entryPath {
			output.EntryDocumentID, output.EntryDocumentVersionID = item.DocumentID, item.VersionID
		}
	}
	return output, nil
}

type publishedFile struct {
	DocumentID, VersionID, Filename, RepresentationFormat string
	File                                                  AgentTreeStableFile
}

// treeFileFormat keeps directory contents raw, Markdown and HTML included;
// only an explicit single Document publication enters the native import.
func treeFileFormat(relativePath string) string {
	format := path.Ext(relativePath)
	if len(format) <= 1 {
		return "file"
	}
	switch format = format[1:]; format {
	case "markdown":
		return "md"
	case "html":
		return "htm"
	}
	return format
}

func validPublicationText(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && utf8.ValidString(value)
}

// lockPublicationRoom revalidates the Agent's credential and Room membership
// and holds them for the transaction.
func lockPublicationRoom(ctx context.Context, tx pgx.Tx, p agentcredential.Principal, roomID string) (string, error) {
	if agentcredential.RevalidateInTx(ctx, tx, p) != nil {
		return "", ErrNotFound
	}
	err := tx.QueryRow(ctx, `SELECT room.id FROM rooms room JOIN room_members member
		ON member.room_id=room.id AND member.tenant_id=room.tenant_id AND member.actor_id=$3
		WHERE room.id=$1 AND room.tenant_id=$2 AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
		FOR SHARE OF room,member`, roomID, p.TenantID, p.AgentActorID).Scan(&roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return roomID, err
}
