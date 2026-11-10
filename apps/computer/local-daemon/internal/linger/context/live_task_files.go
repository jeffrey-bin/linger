package lingercontext

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ReadLiveTaskFiles resolves a TeamHub-authorized task identity against the
// locally retained scope. It needs no Meta view or playground mount.
func (s *ViewStore) ReadLiveTaskFiles(ctx context.Context, scope SharedTaskScope, name string, args json.RawMessage) (map[string]any, error) {
	if scope.Version != 1 || scope.Role != sharedTaskRoleAlterEgo || !sharedTaskIDPattern.MatchString(scope.TaskID) || scope.TenantID == "" || scope.AgentID == "" || scope.OriginRoomID == "" {
		return nil, ErrSharedTaskScope
	}
	storage := s.sharedTaskStorage()
	if storage == nil {
		return nil, ErrSharedTaskStorageUnavailable
	}
	var found bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM shared_task_scopes WHERE json_extract(scope_json,'$.tenant_id')=? AND json_extract(scope_json,'$.agent_id')=? AND json_extract(scope_json,'$.origin_room_id')=? AND json_extract(scope_json,'$.task_id')=? AND json_extract(scope_json,'$.role')='alter_ego')`, scope.TenantID, scope.AgentID, scope.OriginRoomID, scope.TaskID).Scan(&found)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrSharedTaskScope
	}
	var input struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
	}
	if json.Unmarshal(args, &input) != nil || input.Offset < 0 || filepath.IsAbs(input.Path) || strings.ContainsRune(input.Path, 0) {
		return nil, errors.New("invalid Task file request")
	}
	directory := storage.taskDirectory(scope, scope.TaskID)
	// Reject every symbolic directory in the locally owned prefix as well as
	// escapes through user-created links inside the Task.
	relative, err := filepath.Rel(storage.root, directory)
	if err != nil {
		return nil, err
	}
	current := storage.root
	for _, part := range append([]string{""}, strings.Split(relative, string(filepath.Separator))...) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return nil, err
		}
		if !realDirectory(info) {
			return nil, ErrSharedTaskPathConflict
		}
	}
	if name == "list_files" {
		root, err := os.OpenRoot(directory)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		path := input.Path
		if path == "" {
			path = "."
		}
		file, err := root.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		entries, err := file.ReadDir(101)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		truncated := len(entries) > 100
		if truncated {
			entries = entries[:100]
		}
		items := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			items = append(items, map[string]any{"name": entry.Name(), "directory": entry.IsDir()})
		}
		return map[string]any{"files": items, "truncated": truncated}, nil
	}
	if name != "read_file" {
		return nil, errors.New("unknown Task file tool")
	}
	file, err := openContextFile(directory, input.Path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Task file is not regular")
	}
	if _, err = file.Seek(input.Offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, 512*1024))
	if err != nil {
		return nil, err
	}
	return map[string]any{"data_base64": base64.StdEncoding.EncodeToString(data), "size": info.Size(), "modified_ns": strconv.FormatInt(info.ModTime().UnixNano(), 10), "offset": input.Offset, "next_offset": input.Offset + int64(len(data)), "eof": input.Offset+int64(len(data)) >= info.Size()}, nil
}
