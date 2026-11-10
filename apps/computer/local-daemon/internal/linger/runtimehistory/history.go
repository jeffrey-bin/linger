package runtimehistory

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
)

const (
	defaultPageLimit     = 200
	maxPageLimit         = 500
	maxDirectoryDepth    = 3
	maxDirectoryEntries  = 10_000
	maxRolloutBytes      = 64 * 1024 * 1024
	maxNativeRecordBytes = 4 * 1024 * 1024
	maxPageBytes         = 3 * 1024 * 1024
	maxInstructionBytes  = 512 * 1024
	maxInstructionBlocks = 512
	maxRedactedFields    = 1_024
	maxHistoryRecords    = 1_000_000
	maxCursorLength      = 4_096
	cursorVersion        = 1
)

// Runner Gateway JsonValue limits for native_record. The record sits four
// levels below the executed debug_history frame root, whose depth limit is 32.
const (
	maxJSONDepth            = 27
	maxJSONStringRunes      = 262_144
	maxJSONArrayItems       = 1_024
	maxJSONObjectProperties = 256
	maxJSONSafeInteger      = 1<<53 - 1
)

var (
	cursorSecret  = newCursorSecret()
	threadIDRE    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)
	timestampRE   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)
	bearerRE      = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`)
	openAIKeyRE   = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}\b`)
	inlineSecret  = regexp.MustCompile(`(?i)\b(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+`)
	unixPathRE    = regexp.MustCompile(`(?:/Users/[^/\s"'` + "`" + `]+|/home/[^/\s"'` + "`" + `]+|/(?:private/)?tmp|/private/var|/var/(?:lib|folders))(?:/[^\s"'` + "`" + `<>]*)?`)
	windowsPathRE = regexp.MustCompile(`[A-Za-z]:\\Users\\[^\s"'` + "`" + `<>]*`)
)

type Request struct {
	CodexHome string
	ThreadID  string
	Cursor    string
	Limit     int
	Now       func() time.Time
}

type Page struct {
	Status         string       `json:"status"`
	ProviderKind   string       `json:"provider_kind"`
	Source         string       `json:"source,omitempty"`
	Reason         string       `json:"reason,omitempty"`
	Snapshot       *Snapshot    `json:"snapshot,omitempty"`
	Instructions   Instructions `json:"instructions"`
	Records        []Record     `json:"records"`
	PreviousCursor string       `json:"previous_cursor,omitempty"`
}

type Snapshot struct {
	ID          string `json:"id"`
	SessionID   string `json:"thread_id"`
	CapturedAt  string `json:"captured_at"`
	RecordCount int    `json:"record_count"`
	TailState   string `json:"tail_state"`
}

type Instructions struct {
	Status string             `json:"status"`
	Source string             `json:"source"`
	Reason string             `json:"reason,omitempty"`
	Blocks []InstructionBlock `json:"blocks"`
}

type InstructionBlock struct {
	RecordOrdinal  int    `json:"record_ordinal"`
	ContentOrdinal *int   `json:"content_ordinal,omitempty"`
	RecordType     string `json:"record_type"`
	Field          string `json:"field"`
	Timestamp      string `json:"timestamp,omitempty"`
	Text           string `json:"text"`
}

type Record struct {
	Ordinal        int             `json:"ordinal"`
	Timestamp      string          `json:"timestamp,omitempty"`
	TurnID         string          `json:"turn_id,omitempty"`
	Category       string          `json:"category"`
	NativeType     string          `json:"native_type"`
	ToolCallID     string          `json:"tool_call_id,omitempty"`
	ToolName       string          `json:"tool_name,omitempty"`
	Role           string          `json:"role,omitempty"`
	Phase          string          `json:"phase,omitempty"`
	NativeRecord   any             `json:"native_record"`
	RedactedFields []RedactedField `json:"redacted_fields"`
}

type RedactedField struct {
	Path      string `json:"path"`
	Reason    string `json:"reason"`
	ByteCount int    `json:"byte_count,omitempty"`
}

type parsedRecord struct {
	ordinal  int
	original map[string]any
	history  Record
}

type cursorPayload struct {
	Version        int    `json:"version"`
	SessionID      string `json:"sessionId"`
	SnapshotBytes  int    `json:"snapshotBytes"`
	SnapshotDigest string `json:"snapshotDigest"`
	CapturedAt     string `json:"capturedAt"`
	BeforeOrdinal  int    `json:"beforeOrdinal"`
}

type readError struct{ reason string }

func (e *readError) Error() string { return e.reason }
func fail(reason string) error     { return &readError{reason: reason} }

func Inspect(ctx context.Context, request Request) Page {
	page, err := inspect(ctx, request)
	if err == nil {
		return page
	}
	var historyErr *readError
	if !errors.As(err, &historyErr) {
		return unavailable("rollout_unavailable")
	}
	return unavailable(historyErr.reason)
}

func inspect(ctx context.Context, request Request) (Page, error) {
	if err := ctx.Err(); err != nil {
		return Page{}, err
	}
	if !threadIDRE.MatchString(request.ThreadID) {
		return Page{}, fail("rollout_session_invalid")
	}
	limit := request.Limit
	if limit == 0 {
		limit = defaultPageLimit
	}
	if limit < 1 || limit > maxPageLimit {
		return Page{}, fail("history_limit_invalid")
	}
	var cursor *cursorPayload
	var err error
	if request.Cursor != "" {
		cursor, err = decodeCursor(request.Cursor, request.ThreadID)
		if err != nil {
			return Page{}, err
		}
	}
	rollout, canonicalHome, err := findRollout(ctx, request.CodexHome, request.ThreadID)
	if err != nil {
		return Page{}, err
	}
	if rollout == "" {
		return unavailable("rollout_unavailable"), nil
	}
	frozenBytes := 0
	if cursor != nil {
		frozenBytes = cursor.SnapshotBytes
	}
	raw, err := readFrozen(rollout, frozenBytes)
	if err != nil {
		return Page{}, err
	}
	digestBytes := sha256.Sum256(raw)
	digest := base64.RawURLEncoding.EncodeToString(digestBytes[:])
	if cursor != nil && cursor.SnapshotDigest != digest {
		return Page{}, fail("snapshot_expired")
	}
	decoded := raw
	if strings.HasSuffix(rollout, ".zst") {
		decoder, err := zstd.NewReader(nil, zstd.WithDecoderMaxMemory(maxRolloutBytes))
		if err != nil {
			return Page{}, err
		}
		decoded, err = decoder.DecodeAll(raw, nil)
		decoder.Close()
		if err != nil || len(decoded) > maxRolloutBytes {
			return Page{}, fail("rollout_too_large")
		}
	}
	records, tailState, err := parse(decoded, canonicalHome)
	if err != nil {
		return Page{}, err
	}
	if len(records) == 0 || stringValue(records[0].original, "type", 256) != "session_meta" || stringValue(objectValue(records[0].original["payload"]), "id", 256) != request.ThreadID {
		return Page{}, fail("rollout_session_mismatch")
	}
	capturedAt := ""
	end := len(records)
	if cursor != nil {
		capturedAt, end = cursor.CapturedAt, cursor.BeforeOrdinal
	}
	if capturedAt == "" {
		now := time.Now
		if request.Now != nil {
			now = request.Now
		}
		capturedAt = now().UTC().Format(time.RFC3339Nano)
	}
	if end < 0 || end > len(records) {
		return Page{}, fail("snapshot_expired")
	}
	start := end - limit
	if start < 0 {
		start = 0
	}
	instructions := extractInstructions(records, canonicalHome)
	snapshot := Snapshot{ID: snapshotID(digest), SessionID: request.ThreadID, CapturedAt: capturedAt, RecordCount: len(records), TailState: tailState}
	previousCursor := ""
	if start > 0 {
		previousCursor = encodeCursor(cursorPayload{Version: cursorVersion, SessionID: request.ThreadID, SnapshotBytes: len(raw), SnapshotDigest: digest, CapturedAt: capturedAt, BeforeOrdinal: start})
	}
	selected := make([]Record, 0, end-start)
	for _, item := range records[start:end] {
		selected = append(selected, item.history)
	}
	selected = fitPage(selected, instructions, snapshot, previousCursor)
	return Page{Status: "available", ProviderKind: "codex", Source: "codex_rollout", Snapshot: &snapshot, Instructions: instructions, Records: selected, PreviousCursor: previousCursor}, nil
}

func findRollout(ctx context.Context, home, threadID string) (string, string, error) {
	if !filepath.IsAbs(home) {
		return "", "", fail("rollout_root_invalid")
	}
	canonicalHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", nil
		}
		return "", "", err
	}
	canonicalHome, err = filepath.Abs(canonicalHome)
	if err != nil {
		return "", "", err
	}
	sessions := filepath.Join(canonicalHome, "sessions")
	info, err := os.Lstat(sessions)
	if err != nil {
		if os.IsNotExist(err) {
			return "", canonicalHome, nil
		}
		return "", "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", "", fail("rollout_root_invalid")
	}
	realSessions, err := filepath.EvalSymlinks(sessions)
	if err != nil || filepath.Clean(realSessions) != filepath.Clean(sessions) {
		return "", "", fail("rollout_root_invalid")
	}
	entries := 0
	matches := []string{}
	var visit func(string, int) error
	visit = func(directory string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		items, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, item := range items {
			entries++
			if entries > maxDirectoryEntries {
				return fail("rollout_tree_too_large")
			}
			path := filepath.Join(directory, item.Name())
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fail("rollout_symlink_rejected")
			}
			if info.IsDir() {
				if depth >= maxDirectoryDepth {
					return fail("rollout_tree_too_deep")
				}
				if err := visit(path, depth+1); err != nil {
					return err
				}
				continue
			}
			if !info.Mode().IsRegular() {
				continue
			}
			if strings.HasSuffix(item.Name(), "-"+threadID+".jsonl") || strings.HasSuffix(item.Name(), "-"+threadID+".jsonl.zst") {
				matches = append(matches, path)
				if len(matches) > 1 {
					return fail("rollout_session_ambiguous")
				}
			}
		}
		return nil
	}
	if err := visit(sessions, 0); err != nil {
		return "", "", err
	}
	if len(matches) == 0 {
		return "", canonicalHome, nil
	}
	return matches[0], canonicalHome, nil
}

func readFrozen(path string, frozenBytes int) ([]byte, error) {
	file, err := openNoFollow(path)
	if err != nil {
		return nil, fail("rollout_file_invalid")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fail("rollout_file_invalid")
	}
	available := info.Size()
	bytesToRead := int64(frozenBytes)
	if frozenBytes == 0 {
		bytesToRead = available
	}
	if bytesToRead < 1 || bytesToRead > maxRolloutBytes {
		return nil, fail("rollout_too_large")
	}
	if available < bytesToRead {
		return nil, fail("snapshot_expired")
	}
	output := make([]byte, int(bytesToRead))
	if _, err := io.ReadFull(io.NewSectionReader(file, 0, bytesToRead), output); err != nil {
		return nil, fail("snapshot_expired")
	}
	return output, nil
}

func parse(source []byte, home string) ([]parsedRecord, string, error) {
	hasNewline := len(source) > 0 && source[len(source)-1] == '\n'
	lines := bytes.Split(source, []byte{'\n'})
	if hasNewline {
		lines = lines[:len(lines)-1]
	}
	records := []parsedRecord{}
	tail := "clean"
	for ordinal, rawLine := range lines {
		if ordinal > maxHistoryRecords {
			return nil, "", fail("rollout_too_many_records")
		}
		line := bytes.TrimSuffix(rawLine, []byte{'\r'})
		if len(line) == 0 {
			continue
		}
		var value map[string]any
		if err := json.Unmarshal(line, &value); err != nil {
			if ordinal == len(lines)-1 && !hasNewline {
				tail = "incomplete"
			} else {
				tail = "corrupt"
			}
			break
		}
		if len(records) >= maxHistoryRecords {
			return nil, "", fail("rollout_too_many_records")
		}
		history := toRecord(value, ordinal, home)
		records = append(records, parsedRecord{ordinal: ordinal, original: value, history: history})
	}
	return records, tail, nil
}

func toRecord(value map[string]any, ordinal int, home string) Record {
	payload := objectValue(value["payload"])
	recordType := stringValue(value, "type", 256)
	if recordType == "" {
		recordType = "unknown"
	}
	payloadType := stringValue(payload, "type", 256)
	nativeType := recordType
	if payloadType != "" {
		nativeType += "." + payloadType
	}
	if len(nativeType) > 256 {
		nativeType = nativeType[:256]
	}
	redactions := []RedactedField{}
	sanitized := sanitize(value, home, "", false, recordType == "event_msg" && payloadType == "agent_reasoning", 0, &redactions)
	encoded, _ := json.Marshal(sanitized)
	if len(encoded) > maxNativeRecordBytes || len(redactions) > maxRedactedFields {
		sanitized = omittedNativeRecord(len(encoded))
		redactions = []RedactedField{{Path: "", Reason: "omitted_too_large", ByteCount: len(encoded)}}
	}
	return Record{Ordinal: ordinal, Timestamp: timestamp(value), TurnID: nativeIndex(value, payload, "turn_id", 256), Category: categorize(recordType, payloadType), NativeType: nativeType, ToolCallID: nativeIndex(value, payload, "call_id", 256), ToolName: first(stringValue(payload, "name", 256), stringValue(payload, "tool_name", 256)), Role: stringValue(payload, "role", 64), Phase: nativeIndex(value, payload, "phase", 64), NativeRecord: sanitized, RedactedFields: redactions}
}

func sanitize(value any, home, pointer string, inReasoning, displayReasoning bool, depth int, redactions *[]RedactedField) any {
	if depth > maxJSONDepth {
		*redactions = append(*redactions, RedactedField{Path: manifestPath(pointer), Reason: "omitted_too_large"})
		return "[OMITTED_TOO_LARGE]"
	}
	switch typed := value.(type) {
	case nil, bool:
		return typed
	case float64:
		if math.Abs(typed) > maxJSONSafeInteger {
			return strconv.FormatFloat(typed, 'f', -1, 64)
		}
		return typed
	case string:
		result := sanitizeString(typed, home, pointer, redactions)
		if utf8.RuneCountInString(result) > maxJSONStringRunes {
			*redactions = append(*redactions, RedactedField{Path: manifestPath(pointer), Reason: "omitted_too_large", ByteCount: len(result)})
			return "[OMITTED_TOO_LARGE]"
		}
		return result
	case []any:
		if len(typed) > maxJSONArrayItems {
			*redactions = append(*redactions, RedactedField{Path: manifestPath(pointer), Reason: "omitted_too_large"})
			return "[OMITTED_TOO_LARGE]"
		}
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = sanitize(item, home, fmt.Sprintf("%s/%d", pointer, index), inReasoning, displayReasoning, depth+1, redactions)
		}
		return result
	case map[string]any:
		if len(typed) > maxJSONObjectProperties {
			*redactions = append(*redactions, RedactedField{Path: manifestPath(pointer), Reason: "omitted_too_large"})
			return "[OMITTED_TOO_LARGE]"
		}
		result := make(map[string]any, len(typed))
		contentPresent := false
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			item := typed[key]
			child := pointer + "/" + escapePointer(key)
			normalized := normalizeField(key)
			if normalized == "encrypted_content" || normalized == "signature" || normalized == "thinking_signature" || normalized == "thought_signature" || (normalized == "data" && stringValue(typed, "type", 64) == "redacted_thinking") {
				*redactions = append(*redactions, RedactedField{Path: manifestPath(child), Reason: "encrypted_content"})
				if inReasoning {
					contentPresent = true
				}
				continue
			}
			if normalized == "thinking" && (stringValue(typed, "type", 64) == "thinking" || stringValue(typed, "type", 64) == "redacted_thinking") {
				*redactions = append(*redactions, RedactedField{Path: manifestPath(child), Reason: "reasoning_content"})
				continue
			}
			if isSecretField(normalized) {
				*redactions = append(*redactions, RedactedField{Path: manifestPath(child), Reason: "secret"})
				continue
			}
			if inReasoning && (normalized == "content" || normalized == "text" || normalized == "raw_content") && !(displayReasoning && child == "/payload/text") {
				if item != nil && item != "" {
					contentPresent = true
				}
				*redactions = append(*redactions, RedactedField{Path: manifestPath(child), Reason: "reasoning_content"})
				continue
			}
			childReasoning := inReasoning && normalized != "summary"
			if !inReasoning && pointer == "" && key == "payload" {
				kind := stringValue(typed, "type", 256)
				payloadKind := stringValue(objectValue(item), "type", 256)
				childReasoning = payloadKind == "reasoning" || payloadKind == "agent_reasoning" || kind == "reasoning"
			}
			result[key] = sanitize(item, home, child, childReasoning, displayReasoning, depth+1, redactions)
		}
		if inReasoning && contentPresent {
			result["content_present"] = true
		}
		return result
	default:
		return fmt.Sprint(typed)
	}
}

func sanitizeString(value, home, pointer string, redactions *[]RedactedField) string {
	result := value
	roots := []string{home, filepath.Dir(home)}
	sort.Slice(roots, func(i, j int) bool { return len(roots[i]) > len(roots[j]) })
	for _, root := range roots {
		if len(root) > 1 {
			result = strings.ReplaceAll(result, root, "[REDACTED_PATH]")
		}
	}
	result = bearerRE.ReplaceAllString(result, "Bearer [REDACTED]")
	result = openAIKeyRE.ReplaceAllString(result, "[REDACTED]")
	result = inlineSecret.ReplaceAllString(result, "$1=[REDACTED]")
	result = unixPathRE.ReplaceAllString(result, "[REDACTED_PATH]")
	result = windowsPathRE.ReplaceAllString(result, "[REDACTED_PATH]")
	if result != value {
		reason := "secret"
		if strings.Contains(result, "[REDACTED_PATH]") {
			reason = "physical_path"
		}
		*redactions = append(*redactions, RedactedField{Path: manifestPath(pointer), Reason: reason})
	}
	if len([]byte(result)) > maxNativeRecordBytes {
		*redactions = append(*redactions, RedactedField{Path: manifestPath(pointer), Reason: "omitted_too_large", ByteCount: len([]byte(result))})
		return "[OMITTED_TOO_LARGE]"
	}
	return result
}

func extractInstructions(records []parsedRecord, home string) Instructions {
	blocks := []InstructionBlock{}
	bytesUsed := 0
	appendBlock := func(block InstructionBlock) bool {
		bytesUsed += len([]byte(block.Text))
		if len(blocks) >= maxInstructionBlocks || bytesUsed > maxInstructionBytes {
			return false
		}
		blocks = append(blocks, block)
		return true
	}
	for _, record := range records {
		payload := objectValue(record.original["payload"])
		if payload == nil {
			continue
		}
		if stringValue(record.original, "type", 256) == "session_meta" {
			base, present := "", false
			switch value := payload["base_instructions"].(type) {
			case string:
				base, present = value, true
			case map[string]any:
				if text, ok := value["text"].(string); ok {
					base, present = text, true
				}
			}
			if present && !appendBlock(InstructionBlock{RecordOrdinal: record.ordinal, RecordType: "session_meta", Field: "base_instructions", Timestamp: timestamp(record.original), Text: sanitizeString(base, home, "", &[]RedactedField{})}) {
				return unavailableInstructions("instructions_too_large")
			}
			continue
		}
		if stringValue(record.original, "type", 256) != "response_item" || stringValue(payload, "type", 256) != "message" || stringValue(payload, "role", 64) != "developer" {
			continue
		}
		content, ok := payload["content"].([]any)
		if !ok {
			continue
		}
		for index, item := range content {
			object := objectValue(item)
			if stringValue(object, "type", 64) != "input_text" {
				continue
			}
			textValue, ok := object["text"].(string)
			if !ok {
				continue
			}
			ordinal := index
			if !appendBlock(InstructionBlock{RecordOrdinal: record.ordinal, ContentOrdinal: &ordinal, RecordType: "response_item", Field: "developer_message", Timestamp: timestamp(record.original), Text: sanitizeString(textValue, home, "", &[]RedactedField{})}) {
				return unavailableInstructions("instructions_too_large")
			}
		}
	}
	if len(blocks) == 0 {
		return unavailableInstructions("instructions_unavailable")
	}
	return Instructions{Status: "available", Source: "codex_rollout", Blocks: blocks}
}

func fitPage(records []Record, instructions Instructions, snapshot Snapshot, previous string) []Record {
	envelope, _ := json.Marshal(struct {
		Status       string       `json:"status"`
		Provider     string       `json:"provider_kind"`
		Snapshot     Snapshot     `json:"snapshot"`
		Instructions Instructions `json:"instructions"`
		Previous     string       `json:"previous_cursor,omitempty"`
	}{"available", "codex", snapshot, instructions, previous})
	remaining := maxPageBytes - len(envelope) - 16_384
	if remaining < 0 {
		remaining = 0
	}
	for index := range records {
		encoded, _ := json.Marshal(records[index])
		share := remaining / (len(records) - index)
		if share < 1024 {
			share = 1024
		}
		if len(encoded) > share {
			records[index].NativeRecord = omittedNativeRecord(len(encoded))
			records[index].RedactedFields = []RedactedField{{Path: "", Reason: "omitted_too_large", ByteCount: len(encoded)}}
			encoded, _ = json.Marshal(records[index])
		}
		remaining -= len(encoded)
		if remaining < 0 {
			remaining = 0
		}
	}
	return records
}

func omittedNativeRecord(byteCount int) map[string]any {
	return map[string]any{"omitted_too_large": true, "byte_count": byteCount}
}

func encodeCursor(payload cursorPayload) string {
	encoded, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(encoded)
	signature := hmac.New(sha256.New, cursorSecret)
	signature.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(signature.Sum(nil))
}
func decodeCursor(value, threadID string) (*cursorPayload, error) {
	if len(value) < 1 || len(value) > maxCursorLength {
		return nil, fail("snapshot_expired")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return nil, fail("snapshot_expired")
	}
	mac := hmac.New(sha256.New, cursorSecret)
	mac.Write([]byte(parts[0]))
	supplied, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(supplied, mac.Sum(nil)) {
		return nil, fail("snapshot_expired")
	}
	encoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fail("snapshot_expired")
	}
	var payload cursorPayload
	if json.Unmarshal(encoded, &payload) != nil || payload.Version != cursorVersion || payload.SessionID != threadID || payload.SnapshotBytes < 1 || payload.SnapshotDigest == "" || payload.CapturedAt == "" || payload.BeforeOrdinal < 0 {
		return nil, fail("snapshot_expired")
	}
	return &payload, nil
}
func snapshotID(digest string) string {
	mac := hmac.New(sha256.New, cursorSecret)
	mac.Write([]byte(digest))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func unavailable(reason string) Page {
	return Page{Status: "unavailable", ProviderKind: "codex", Reason: reason, Instructions: unavailableInstructions(reason), Records: []Record{}}
}
func unavailableInstructions(reason string) Instructions {
	return Instructions{Status: "unavailable", Source: "codex_rollout", Reason: reason, Blocks: []InstructionBlock{}}
}
func categorize(recordType, payloadType string) string {
	if recordType == "compacted" || payloadType == "context_compacted" {
		return "compaction"
	}
	if recordType == "session_meta" || recordType == "turn_context" || payloadType == "task_started" || payloadType == "task_complete" || payloadType == "turn_aborted" {
		return "lifecycle"
	}
	if payloadType == "reasoning" || payloadType == "agent_reasoning" {
		return "reasoning"
	}
	if payloadType == "message" || payloadType == "user_message" || payloadType == "agent_message" {
		return "message"
	}
	if payloadType == "token_count" || payloadType == "token_usage" || payloadType == "usage" {
		return "usage"
	}
	if strings.HasSuffix(payloadType, "_output") || strings.HasSuffix(payloadType, "_result") {
		return "tool_result"
	}
	if strings.HasSuffix(payloadType, "_call") || payloadType == "function_call" || payloadType == "custom_tool_call" {
		return "tool_call"
	}
	return "provider_event"
}
func timestamp(value map[string]any) string {
	result := stringValue(value, "timestamp", 64)
	if result == "" || !timestampRE.MatchString(result) {
		return ""
	}
	if _, err := time.Parse(time.RFC3339Nano, result); err != nil {
		return ""
	}
	return result
}
func nativeIndex(record, payload map[string]any, key string, limit int) string {
	return first(stringValue(record, key, limit), stringValue(payload, key, limit))
}
func stringValue(value map[string]any, key string, limit int) string {
	if value == nil {
		return ""
	}
	result, ok := value[key].(string)
	if !ok || result == "" || len(result) > limit || !utf8.ValidString(result) {
		return ""
	}
	return result
}
func objectValue(value any) map[string]any { result, _ := value.(map[string]any); return result }
func first(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
func normalizeField(value string) string {
	var out strings.Builder
	for index, r := range value {
		if index > 0 && r >= 'A' && r <= 'Z' {
			out.WriteByte('_')
		}
		if r == '-' || r == ' ' {
			out.WriteByte('_')
		} else {
			out.WriteRune(r)
		}
	}
	return strings.ToLower(out.String())
}
func isSecretField(value string) bool {
	switch value {
	case "authorization", "cookie", "set_cookie", "secret", "client_secret", "password", "private_key", "api_key", "token", "access_token", "refresh_token", "session_token", "bearer_token", "id_token", "credential", "credentials":
		return true
	}
	return false
}
func escapePointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}
func manifestPath(value string) string {
	if len(value) > 4096 {
		return value[:4096]
	}
	return value
}
func newCursorSecret() []byte {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	return secret
}
