package document

import (
	"errors"
	"path"
	"regexp"
	"sort"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// A directory an Agent sends in a message becomes one publication Group of
// Documents, committed with the message by CreateMessageTreeTx.
const (
	agentTreeMaxFiles     = 64
	agentTreeMaxEntries   = 10_000
	agentTreeMaxBytes     = 512 << 20
	agentTreeMaxFileBytes = 50 << 20
	agentTreeMaxDepth     = 32
)

var (
	ErrAgentTreePathConflict = errors.New("Agent CLI tree placement conflicts with current Documents")

	agentTreeOperationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	agentTreeDigestPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type AgentTreeManifestEntry struct {
	Kind, RelativePath, MediaType, SHA256 string
	SizeBytes                             int64
}

type AgentTreePublicationInput struct {
	Principal                                              *agentcredential.Principal
	TenantID, AgentID, ContextKind, ContextID, OperationID string
	DirectoryPath                                          string
	Entries                                                []AgentTreeManifestEntry
}

type AgentTreeStableFile struct {
	RelativePath, MediaType, SHA256, ObjectKey string
	SizeBytes                                  int64
}

type AgentTreePublishedDocument struct {
	RelativePath, DocumentID, DocumentVersionID string
}

type AgentTreePublicationResult struct {
	Status, PublicationGroupID, RootPlacementPath string
	EntryDocumentID, EntryDocumentVersionID       string
	FileCount, DirectoryCount                     int
	TotalBytes                                    int64
	Documents                                     []AgentTreePublishedDocument
}

type normalizedAgentTreeInput struct {
	AgentTreePublicationInput
	fileCount, directoryCount int
	totalBytes                int64
}

func normalizeAgentTreeInput(input AgentTreePublicationInput) (normalizedAgentTreeInput, error) {
	if input.Principal == nil || input.TenantID == "" || input.AgentID == "" || input.ContextID == "" ||
		input.Principal.TenantID != input.TenantID || input.Principal.AgentID != input.AgentID ||
		!agentTreeOperationPattern.MatchString(input.OperationID) || input.ContextKind != "room" {
		return normalizedAgentTreeInput{}, ErrInvalidInput
	}
	directoryParts, err := Parse(input.DirectoryPath)
	if err != nil || len(directoryParts) < 2 || len(directoryParts) > agentTreeMaxDepth || directoryParts[0] != input.ContextID {
		return normalizedAgentTreeInput{}, ErrInvalidInput
	}
	if len(input.Entries) < 1 || len(input.Entries) > agentTreeMaxEntries {
		return normalizedAgentTreeInput{}, ErrInvalidInput
	}
	entries := append([]AgentTreeManifestEntry(nil), input.Entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].RelativePath < entries[j].RelativePath })
	seen := make(map[string]string, len(entries))
	fileCount, directoryCount := 0, 1
	var totalBytes int64
	for _, entry := range entries {
		parts, parseErr := Parse(entry.RelativePath)
		if parseErr != nil || len(parts) > agentTreeMaxDepth || seen[entry.RelativePath] != "" {
			return normalizedAgentTreeInput{}, ErrInvalidInput
		}
		for parent := path.Dir(entry.RelativePath); parent != "."; parent = path.Dir(parent) {
			if seen[parent] == "file" {
				return normalizedAgentTreeInput{}, ErrInvalidInput
			}
		}
		switch entry.Kind {
		case "directory":
			if entry.MediaType != "" || entry.SizeBytes != 0 || entry.SHA256 != "" {
				return normalizedAgentTreeInput{}, ErrInvalidInput
			}
			directoryCount++
		case "file":
			if entry.MediaType == "" || len(entry.MediaType) > 255 || entry.SizeBytes < 0 ||
				entry.SizeBytes > agentTreeMaxFileBytes || !agentTreeDigestPattern.MatchString(entry.SHA256) {
				return normalizedAgentTreeInput{}, ErrInvalidInput
			}
			fileCount++
			totalBytes += entry.SizeBytes
		default:
			return normalizedAgentTreeInput{}, ErrInvalidInput
		}
		seen[entry.RelativePath] = entry.Kind
	}
	if fileCount < 1 || fileCount > agentTreeMaxFiles || totalBytes > agentTreeMaxBytes {
		return normalizedAgentTreeInput{}, ErrRecoveryBudgetExceeded
	}
	input.Entries = entries
	return normalizedAgentTreeInput{
		AgentTreePublicationInput: input,
		fileCount:                 fileCount, directoryCount: directoryCount, totalBytes: totalBytes,
	}, nil
}

func agentTreeRootPath(directoryPath string) string { return path.Base(path.Clean(directoryPath)) }

func agentTreeTargetKey(directoryPath, relativePath string) string {
	return path.Join(agentTreeRootPath(directoryPath), relativePath)
}

func agentTreeEntryRelativePath(input normalizedAgentTreeInput) string {
	htmlPaths := make([]string, 0, 1)
	for _, entry := range input.Entries {
		if entry.Kind != "file" || entry.MediaType != "text/html" {
			continue
		}
		if entry.RelativePath == "index.html" {
			return entry.RelativePath
		}
		htmlPaths = append(htmlPaths, entry.RelativePath)
	}
	if len(htmlPaths) == 1 {
		return htmlPaths[0]
	}
	return ""
}
