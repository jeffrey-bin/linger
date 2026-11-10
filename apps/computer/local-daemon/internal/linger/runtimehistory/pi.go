package runtimehistory

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// InspectPi reads only the current Pi branch with bounded, frozen pagination.
// Its root is resolved from the authorized Context, never from a wire path.
func InspectPi(ctx context.Context, request Request) Page {
	page, err := inspectPi(ctx, request)
	if err == nil {
		return page
	}
	reason := "transcript_unavailable"
	var detail *readError
	if errors.As(err, &detail) {
		reason = detail.reason
	}
	return Page{Status: "unavailable", ProviderKind: "pi", Reason: reason, Instructions: Instructions{Status: "unavailable", Source: "pi_session", Reason: reason, Blocks: []InstructionBlock{}}, Records: []Record{}}
}

func inspectPi(ctx context.Context, request Request) (Page, error) {
	if !threadIDRE.MatchString(request.ThreadID) {
		return Page{}, fail("transcript_session_invalid")
	}
	if request.Limit == 0 {
		request.Limit = defaultPageLimit
	}
	if request.Limit < 1 || request.Limit > maxPageLimit {
		return Page{}, fail("history_limit_invalid")
	}
	root, err := os.OpenRoot(request.CodexHome)
	if err != nil {
		return Page{}, err
	}
	defer root.Close()
	directory := filepath.Join("sessions", request.ThreadID)
	for _, name := range []string{"sessions", directory} {
		info, err := root.Lstat(name)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return Page{}, fail("transcript_unavailable")
		}
	}
	dir, err := root.Open(directory)
	if err != nil {
		return Page{}, err
	}
	entries, err := dir.ReadDir(maxDirectoryEntries + 1)
	closeErr := dir.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return Page{}, err
	}
	if closeErr != nil {
		return Page{}, closeErr
	}
	if len(entries) > maxDirectoryEntries {
		return Page{}, fail("transcript_scan_limit")
	}
	transcript := ""
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return Page{}, err
		}
		if !strings.HasSuffix(entry.Name(), "_"+request.ThreadID+".jsonl") {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return Page{}, fail("transcript_symlink")
		}
		if transcript != "" {
			return Page{}, fail("transcript_session_ambiguous")
		}
		transcript = filepath.Join(directory, entry.Name())
	}
	if transcript == "" {
		return Page{}, fail("transcript_unavailable")
	}
	var cursor *cursorPayload
	if request.Cursor != "" {
		cursor, err = decodeCursor(request.Cursor, request.ThreadID)
		if err != nil {
			return Page{}, err
		}
	}
	frozen := 0
	if cursor != nil {
		frozen = cursor.SnapshotBytes
	}
	file, err := root.Open(transcript)
	if err != nil {
		return Page{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Page{}, fail("transcript_unavailable")
	}
	count := info.Size()
	if frozen != 0 {
		count = int64(frozen)
	}
	if count < 1 || count > maxRolloutBytes {
		return Page{}, fail("transcript_too_large")
	}
	if info.Size() < count {
		return Page{}, fail("snapshot_expired")
	}
	raw := make([]byte, int(count))
	if _, err := io.ReadFull(io.NewSectionReader(file, 0, count), raw); err != nil {
		return Page{}, err
	}
	digestBytes := sha256.Sum256(raw)
	digest := base64.RawURLEncoding.EncodeToString(digestBytes[:])
	if cursor != nil && cursor.SnapshotDigest != digest {
		return Page{}, fail("snapshot_expired")
	}
	records, tail, err := parse(raw, request.CodexHome)
	if err != nil {
		return Page{}, err
	}
	if len(records) == 0 || stringValue(records[0].original, "type", 256) != "session" || stringValue(records[0].original, "id", 256) != request.ThreadID {
		return Page{}, fail("transcript_session_mismatch")
	}
	// Pi resumes from the last append-only entry. Follow parentId, excluding
	// abandoned branches. Keep physical ordinals so memory watermarks advance.
	byID := make(map[string]parsedRecord)
	leaf := ""
	for _, item := range records[1:] {
		id := stringValue(item.original, "id", 256)
		if id == "" {
			return Page{}, fail("transcript_entry_invalid")
		}
		if _, exists := byID[id]; exists {
			return Page{}, fail("transcript_entry_invalid")
		}
		byID[id] = item
		leaf = id
	}
	branch := []parsedRecord{records[0]}
	visited := make(map[string]bool)
	for leaf != "" {
		if err := ctx.Err(); err != nil {
			return Page{}, err
		}
		item, found := byID[leaf]
		if !found || visited[leaf] {
			return Page{}, fail("transcript_branch_invalid")
		}
		visited[leaf] = true
		branch = append(branch, item)
		parent := item.original["parentId"]
		if parent == nil {
			break
		}
		var valid bool
		leaf, valid = parent.(string)
		if !valid || leaf == "" {
			return Page{}, fail("transcript_branch_invalid")
		}
	}
	sort.Slice(branch, func(i, j int) bool { return branch[i].ordinal < branch[j].ordinal })
	records = branch
	instructions := Instructions{Status: "unavailable", Source: "pi_session", Reason: "Native session has no instruction snapshot", Blocks: []InstructionBlock{}}
	sections := make(map[string]InstructionBlock)
	for i := range records {
		item := &records[i]
		kind := stringValue(item.original, "type", 256)
		message := objectValue(item.original["message"])
		item.history.NativeType = kind
		item.history.TurnID = stringValue(item.original, "id", 256)
		item.history.Role = stringValue(message, "role", 64)
		item.history.Category = "lifecycle"
		if kind == "message" {
			switch item.history.Role {
			case "user", "assistant", "custom":
				item.history.Category = "message"
			case "toolResult":
				item.history.Category = "tool_result"
				item.history.ToolCallID = stringValue(message, "toolCallId", 256)
				item.history.ToolName = stringValue(message, "toolName", 256)
			case "system":
				for name, value := range objectValue(message["sections"]) {
					if value == nil {
						delete(sections, name)
						continue
					}
					text, ok := value.(string)
					if !ok {
						return Page{}, fail("instructions_invalid")
					}
					sections[name] = InstructionBlock{RecordOrdinal: item.ordinal, RecordType: kind, Field: name, Text: sanitizeString(text, request.CodexHome, name, &[]RedactedField{})}
				}
			}
		}
	}
	names := make([]string, 0, len(sections))
	size := 0
	for name, section := range sections {
		names = append(names, name)
		size += len(section.Text)
	}
	if len(names) > maxInstructionBlocks || size > maxInstructionBytes {
		return Page{}, fail("instructions_too_large")
	}
	sort.Strings(names)
	for _, name := range names {
		instructions.Blocks = append(instructions.Blocks, sections[name])
	}
	if len(instructions.Blocks) > 0 {
		instructions.Status, instructions.Reason = "available", ""
	}
	end := len(records)
	now := time.Now
	if request.Now != nil {
		now = request.Now
	}
	captured := now().UTC().Format(time.RFC3339Nano)
	if cursor != nil {
		end = cursor.BeforeOrdinal
		captured = cursor.CapturedAt
	}
	if end < 0 || end > len(records) {
		return Page{}, fail("snapshot_expired")
	}
	start := end - request.Limit
	if start < 0 {
		start = 0
	}
	previous := ""
	if start > 0 {
		previous = encodeCursor(cursorPayload{Version: cursorVersion, SessionID: request.ThreadID, SnapshotBytes: len(raw), SnapshotDigest: digest, CapturedAt: captured, BeforeOrdinal: start})
	}
	snapshot := Snapshot{ID: snapshotID(digest), SessionID: request.ThreadID, CapturedAt: captured, RecordCount: len(records), TailState: tail}
	selected := make([]Record, 0, end-start)
	for _, item := range records[start:end] {
		selected = append(selected, item.history)
	}
	selected = fitPage(selected, instructions, snapshot, previous)
	return Page{Status: "available", ProviderKind: "pi", Source: "pi_session", Instructions: instructions, Snapshot: &snapshot, Records: selected, PreviousCursor: previous}, nil
}
