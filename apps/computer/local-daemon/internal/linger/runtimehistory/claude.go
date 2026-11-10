package runtimehistory

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// InspectClaude shares bounded, frozen pagination and redaction with Codex.
// Its root is resolved from the authorized Context, never from a wire path.
func InspectClaude(ctx context.Context, request Request) Page {
	page, err := inspectClaude(ctx, request)
	if err == nil {
		return page
	}
	reason := "transcript_unavailable"
	var detail *readError
	if errors.As(err, &detail) {
		reason = detail.reason
	}
	return Page{Status: "unavailable", ProviderKind: "claude", Reason: reason, Instructions: Instructions{Status: "unavailable", Source: "claude_transcript", Reason: reason, Blocks: []InstructionBlock{}}, Records: []Record{}}
}

func inspectClaude(ctx context.Context, request Request) (Page, error) {
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
	projects := ".claude/projects"
	transcript := ""
	entries := 0
	err = fs.WalkDir(root.FS(), projects, func(name string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > maxDirectoryEntries {
			return fail("transcript_scan_limit")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fail("transcript_symlink")
		}
		if entry.IsDir() && strings.Count(name, "/") > 2 {
			return fs.SkipDir
		}
		if !entry.IsDir() && filepath.Base(name) == request.ThreadID+".jsonl" {
			if transcript != "" {
				return fail("transcript_session_ambiguous")
			}
			transcript = name
		}
		return nil
	})
	if err != nil {
		return Page{}, err
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
	matched := false
	instructions := Instructions{Status: "unavailable", Source: "claude_transcript", Reason: "Native transcript does not contain an instruction snapshot", Blocks: []InstructionBlock{}}
	instructionBytes := 0
	for i := range records {
		item := &records[i]
		id := stringValue(item.original, "sessionId", 256)
		if id != "" && id != request.ThreadID {
			return Page{}, fail("transcript_session_mismatch")
		}
		matched = matched || id == request.ThreadID
		kind := stringValue(item.original, "type", 256)
		message := objectValue(item.original["message"])
		item.history.Role = stringValue(message, "role", 64)
		item.history.TurnID = stringValue(item.original, "uuid", 256)
		if kind == "user" || kind == "assistant" {
			item.history.Category = "message"
		}
		if kind == "system" {
			item.history.Category = "lifecycle"
		}
		if claudeCompactionRecord(kind, item.original, message) {
			item.history.Category = "compaction"
		}
		for _, field := range []string{"systemPrompt", "system_prompt", "system_prompt_append"} {
			prompt := stringValue(item.original, field, maxInstructionBytes)
			if prompt != "" {
				instructionBytes += len(prompt)
				if len(instructions.Blocks) >= maxInstructionBlocks || instructionBytes > maxInstructionBytes {
					return Page{}, fail("instructions_too_large")
				}
				redactions := []RedactedField{}
				instructions.Blocks = append(instructions.Blocks, InstructionBlock{RecordOrdinal: item.ordinal, RecordType: kind, Field: field, Text: sanitizeString(prompt, request.CodexHome, field, &redactions)})
				instructions.Status = "available"
				instructions.Reason = ""
			}
		}
	}
	if !matched {
		return Page{}, fail("transcript_session_mismatch")
	}
	// The Local Claude Session marker freezes the append prompt on first use.
	// Only expose it when both marker and native transcript own this Session.
	if instructions.Status == "unavailable" {
		markerFile, markerErr := root.Open(filepath.Join("sessions", request.ThreadID+".json"))
		if markerErr == nil {
			markerBytes, readErr := io.ReadAll(io.LimitReader(markerFile, maxInstructionBytes+1))
			_ = markerFile.Close()
			var marker map[string]any
			if readErr == nil && len(markerBytes) <= maxInstructionBytes && json.Unmarshal(markerBytes, &marker) == nil && stringValue(marker, "session_id", 256) == request.ThreadID {
				prompt := stringValue(marker, "system_prompt_append", maxInstructionBytes)
				if prompt != "" {
					redactions := []RedactedField{}
					instructions.Status = "available"
					instructions.Reason = ""
					instructions.Blocks = []InstructionBlock{{RecordOrdinal: 0, RecordType: "linger_instruction_snapshot", Field: "system_prompt_append", Text: sanitizeString(prompt, request.CodexHome, "system_prompt_append", &redactions)}}
				}
			}
		}
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
	return Page{Status: "available", ProviderKind: "claude", Source: "claude_transcript", Instructions: instructions, Snapshot: &snapshot, Records: selected, PreviousCursor: previous}, nil
}

// claudeCompactionRecord reports a record a compaction wrote: its boundary, its
// summary, and the /compact command and its output that Claude records as user
// messages.
func claudeCompactionRecord(kind string, record, message map[string]any) bool {
	switch kind {
	case "system":
		return record["subtype"] == "compact_boundary"
	case "user":
		if record["isCompactSummary"] == true {
			return true
		}
		text, _ := message["content"].(string)
		if blocks, ok := message["content"].([]any); ok && len(blocks) > 0 {
			text, _ = objectValue(blocks[0])["text"].(string)
		}
		return strings.HasPrefix(text, "<command-name>/compact</command-name>") || strings.HasPrefix(text, "<local-command-stdout>")
	}
	return false
}
