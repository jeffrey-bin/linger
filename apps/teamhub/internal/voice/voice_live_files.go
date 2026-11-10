package voice

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	api "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	voiceapi "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The scope is resolved from a persisted delegation, never from model-supplied
// tenant/agent/room IDs or a host filesystem path.
func (s *Service) voiceTaskComputer(ctx context.Context, session voicelive.Session, handle string) (store.VoiceLiveTask, roomagent.LocalComputerTools, api.LocalComputerToolCall, error) {
	ordinal, ok := voicelive.TaskOrdinal(handle)
	if !ok {
		return store.VoiceLiveTask{}, nil, api.LocalComputerToolCall{}, voicelive.ErrInvalid
	}
	task, err := s.queries.GetVoiceLiveTask(ctx, store.GetVoiceLiveTaskParams{RoomID: session.RoomID, OwnerActorID: session.HumanActorID, Ordinal: ordinal})
	if err != nil {
		return task, nil, api.LocalComputerToolCall{}, err
	}
	authorized, err := s.queries.VoiceLiveTaskCoordinatedBy(ctx, store.VoiceLiveTaskCoordinatedByParams{TaskID: task.WorkItemID, TenantID: session.TenantID, CoordinatorActorID: session.Agent.ID})
	if err != nil {
		return task, nil, api.LocalComputerToolCall{}, err
	}
	if !authorized {
		return task, nil, api.LocalComputerToolCall{}, voicelive.ErrNotFound
	}
	target, _, ok, err := s.voiceLiveBrowserTarget(ctx, session)
	if err != nil {
		return task, nil, api.LocalComputerToolCall{}, err
	}
	tools, supported := s.localComputers.(roomagent.LocalComputerTools)
	if !ok || !supported {
		return task, nil, api.LocalComputerToolCall{}, &roomagent.LocalComputerToolError{Code: "computer_unavailable", Message: "Connect the task's Local Computer"}
	}
	call := api.LocalComputerToolCall{TenantId: session.TenantID, OwnerActorId: session.HumanActorID, ComputerId: target.ComputerID, AgentId: target.AgentManagementID, ToolSessionId: session.ID, Server: api.TaskFiles}
	call.TaskScope = &struct {
		AgentId      string `json:"agent_id"`
		OriginRoomId string `json:"origin_room_id"`
		TaskId       string `json:"task_id"`
		TenantId     string `json:"tenant_id"`
	}{AgentId: target.AgentManagementID, OriginRoomId: task.HomeRoomID, TaskId: task.WorkItemID, TenantId: session.TenantID}
	return task, tools, call, nil
}

func (s *Service) voiceLiveTaskFiles(ctx context.Context, session voicelive.Session, request voiceapi.VoiceLiveToolCall) (string, error) {
	var args voicelive.TaskFilesArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || (args.Action != "list" && args.Action != "read") {
		return "", voicelive.ErrInvalid
	}
	task, tools, call, err := s.voiceTaskComputer(ctx, session, args.TaskID)
	if err != nil {
		return voiceFileError(err)
	}
	call.ToolName = "list_files"
	if args.Action == "read" {
		call.ToolName = "read_file"
	}
	call.Arguments = map[string]any{"path": voicelive.TaskFilePath(args.Path, task.WorkItemID), "offset": 0}
	result, err := tools.CallLocalComputerTool(ctx, call)
	if err != nil {
		return voiceFileError(err)
	}
	if args.Action == "list" {
		return voicelive.Output(result), nil
	}
	chunk, err := decodeVoiceFileChunk(result)
	if err != nil {
		return voiceFileError(err)
	}
	if !utf8.Valid(chunk.data) {
		return voicelive.ErrorOutput("not_text_use_publish_task_result"), nil
	}
	text, truncated := voicelive.Truncate(string(chunk.data), 3000)
	return voicelive.Output(map[string]any{"text": text, "truncated": truncated || !chunk.EOF, "size": chunk.Size}), nil
}

func voiceFileError(err error) (string, error) {
	var local *roomagent.LocalComputerToolError
	if errors.As(err, &local) {
		return voicelive.Output(map[string]string{"error": local.Code, "detail": local.Message}), nil
	}
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, voicelive.ErrNotFound) {
		return voicelive.ErrorOutput("task_not_found"), nil
	}
	if errors.Is(err, voicelive.ErrInvalid) {
		return "", voicelive.ErrInvalid
	}
	return "", err
}

type voiceFileChunk struct {
	Data     string `json:"data_base64"`
	Size     int64  `json:"size"`
	Modified string `json:"modified_ns"`
	Offset   int64  `json:"offset"`
	Next     int64  `json:"next_offset"`
	EOF      bool   `json:"eof"`
	data     []byte
}

func decodeVoiceFileChunk(result map[string]any) (voiceFileChunk, error) {
	var chunk voiceFileChunk
	raw, err := json.Marshal(result)
	if err == nil {
		err = json.Unmarshal(raw, &chunk)
	}
	if err != nil {
		return chunk, err
	}
	chunk.data, err = base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil || chunk.Modified == "" || chunk.Size < 0 || chunk.Offset < 0 || chunk.Next != chunk.Offset+int64(len(chunk.data)) || chunk.Next > chunk.Size || chunk.EOF != (chunk.Next == chunk.Size) || len(chunk.data) > 512*1024 {
		return chunk, voicelive.ErrInvalid
	}
	return chunk, nil
}

// Each read is bounded. Size/mtime must stay constant across chunks; changing
// outputs never become an apparently successful mixed-version attachment.
func (s *Service) stageVoiceTaskFile(ctx context.Context, tools roomagent.LocalComputerTools, call api.LocalComputerToolCall, filename string) (artifactstore.Object, error) {
	reader, writer := io.Pipe()
	go func() {
		_ = writer.CloseWithError(copyVoiceTaskFile(ctx, tools, call, filename, writer))
	}()
	defer reader.Close()
	return s.artifacts.Put(ctx, reader)
}

// maxVoiceTaskFileBytes bounds one task output the live voice reads whole.
const maxVoiceTaskFileBytes = 32 << 20

// copyVoiceTaskFile writes one task output file to w, chunk by chunk, and
// fails when the file changes while it is read.
func copyVoiceTaskFile(ctx context.Context, tools roomagent.LocalComputerTools, call api.LocalComputerToolCall, filename string, w io.Writer) error {
	var size int64 = -1
	var modified string
	var offset int64
	for {
		call.ToolName = "read_file"
		call.Arguments = map[string]any{"path": filename, "offset": offset}
		result, err := tools.CallLocalComputerTool(ctx, call)
		if err != nil {
			return err
		}
		chunk, err := decodeVoiceFileChunk(result)
		if err != nil {
			return err
		}
		if size < 0 {
			size = chunk.Size
			modified = chunk.Modified
		}
		if size > maxVoiceTaskFileBytes || chunk.Size != size || chunk.Modified != modified || chunk.Offset != offset || (!chunk.EOF && chunk.Next <= offset) {
			return errors.New("task output changed or exceeds 32 MiB")
		}
		if _, err = w.Write(chunk.data); err != nil {
			return err
		}
		if chunk.EOF {
			return nil
		}
		offset = chunk.Next
	}
}

func (s *Service) publishVoiceLiveTaskResult(ctx context.Context, session voicelive.Session, request voiceapi.VoiceLiveToolCall) (string, error) {
	var args voicelive.PublishTaskResultArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || args.ReportID == "" || strings.TrimSpace(args.Text) == "" || utf8.RuneCountInString(args.Text) > 20000 || strings.TrimSpace(args.Title) == "" || utf8.RuneCountInString(args.Title) > 120 || len(args.Files) > 5 {
		return "", voicelive.ErrInvalid
	}
	// A question/text-only report does not require an online Computer.
	ordinal, ok := voicelive.TaskOrdinal(args.TaskID)
	if !ok {
		return "", voicelive.ErrInvalid
	}
	task, err := s.queries.GetVoiceLiveTask(ctx, store.GetVoiceLiveTaskParams{RoomID: session.RoomID, OwnerActorID: session.HumanActorID, Ordinal: ordinal})
	if err != nil {
		return voiceFileError(err)
	}
	if _, err = s.queries.GetVoiceLiveReportTask(ctx, store.GetVoiceLiveReportTaskParams{ReportID: args.ReportID, TaskID: task.WorkItemID, CoordinatorActorID: session.Agent.ID, TenantID: session.TenantID}); err != nil {
		return voiceFileError(err)
	}
	prior, err := s.queries.GetVoiceLiveReportDelivery(ctx, args.ReportID)
	if err == nil {
		return voicelive.Output(map[string]string{"status": "delivered", "message_id": prior, "room_id": task.HomeRoomID}), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	objects := []artifactstore.Object{}
	commitAttempted := false
	defer func() {
		if !commitAttempted {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			for _, object := range objects {
				_ = artifactstore.DeleteDetached(cleanup, s.artifacts, object.Key)
			}
		}
	}()
	if len(args.Files) > 0 {
		task, tools, call, err := s.voiceTaskComputer(ctx, session, args.TaskID)
		if err != nil {
			return voiceFileError(err)
		}
		seen := map[string]bool{}
		for _, filename := range args.Files {
			filename = voicelive.TaskFilePath(filename, task.WorkItemID)
			if filename == "" || path.IsAbs(filename) || path.Clean(filename) != filename || filename == ".." || strings.HasPrefix(filename, "../") || seen[filename] {
				return voicelive.ErrorOutput("invalid_file_path"), nil
			}
			seen[filename] = true
			object, err := s.stageVoiceTaskFile(ctx, tools, call, filename)
			if err != nil {
				return voiceFileError(err)
			}
			objects = append(objects, object)
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	// Serialize close/lease loss against publication. A stale foreground can
	// finish reading bytes, but cannot publish a new result after handing over.
	queries := s.queries.WithTx(tx)
	current, err := queries.LockVoiceLiveSessionCurrent(ctx, session.ID)
	if err != nil {
		return "", err
	}
	if !current {
		return "", voicelive.ErrNotFound
	}
	if err = queries.LockVoiceLiveReport(ctx, args.ReportID); err != nil {
		return "", err
	}
	prior, err = queries.GetVoiceLiveReportDelivery(ctx, args.ReportID)
	if err == nil {
		return voicelive.Output(map[string]string{"status": "delivered", "message_id": prior, "room_id": task.HomeRoomID}), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	segments := []messagecreation.Segment{{Type: "text", Content: args.Text}}
	versions := []string{}
	for index, object := range objects {
		name := path.Base(args.Files[index])
		extension := strings.ToLower(path.Ext(name))
		format := strings.TrimPrefix(extension, ".")
		if format == "" {
			format = "binary"
		}
		if format == "md" {
			format = "markdown"
		}
		mediaType := mime.TypeByExtension(extension)
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		attachment, err := s.documents.CreateAgentMessageAttachmentTx(ctx, tx, document.CreateAgentMessageAttachmentInput{TenantID: session.TenantID, RoomID: task.HomeRoomID, AgentActorID: session.Agent.ID, AttachmentKey: fmt.Sprintf("live:%s:%d", args.ReportID, index), SourceInvocationID: request.CallId, Filename: name, RepresentationFormat: format, MediaType: mediaType, ObjectKey: object.Key, SizeBytes: object.Size, SHA256: hex.EncodeToString(object.SHA256[:])})
		if err != nil {
			return "", err
		}
		segments = append(segments, messagecreation.Segment{Type: "file", Content: name, DocumentID: attachment.DocumentID, DocumentVersionID: attachment.DocumentVersionID, Filename: name, MediaType: mediaType})
		versions = append(versions, attachment.DocumentVersionID)
	}
	content, err := messagecreation.Normalize(segments)
	if err != nil {
		return "", err
	}
	created, err := messagecreation.Create(ctx, queries, messagecreation.Draft{TenantID: session.TenantID, RoomID: task.HomeRoomID, Author: session.Agent, Content: content, CardTitle: args.Title, AttachmentVersionIDs: versions, SuppressMentionSignals: true})
	if err != nil {
		return "", err
	}
	if err = queries.CreateVoiceLiveReportDelivery(ctx, store.CreateVoiceLiveReportDeliveryParams{ReportID: args.ReportID, VoiceSessionID: session.ID, MessageID: created.Message.ID}); err != nil {
		return "", err
	}
	// It remains in history, but a switch must not ask Meta to deliver it again.
	if err = queries.MarkVoiceLiveReportNonActionable(ctx, args.ReportID); err != nil {
		return "", err
	}
	// A lost commit response does not prove rollback. Keep staged objects once
	// commit starts; otherwise an acknowledged publication could lose its files.
	commitAttempted = true
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "delivered", "message_id": created.Message.ID, "room_id": task.HomeRoomID}), nil
}
