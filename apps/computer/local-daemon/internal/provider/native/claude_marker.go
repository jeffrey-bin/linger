package native

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const (
	claudeMarkerLimit = 1 << 20
	claudePromptLimit = 512 << 10
	claudeSessionRoot = "LINGER_CLAUDE_SESSION_ROOT"
)

// claudeMarkerWrites serializes marker rewrites across the whole Daemon.
var claudeMarkerWrites sync.Mutex

// claudeCanonicalUUID accepts the 36-character form with the RFC 4122
// variant and a version from 1 to 8.
func claudeCanonicalUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Variant() == uuid.RFC4122 && parsed.Version() >= 1 && parsed.Version() <= 8
}

func claudeMarkerPath(root, identity string) string {
	return filepath.Join(root, identity+".json")
}

// claudeSessionMaterialized reports whether the marker exists as a regular
// file: the native session was created by an earlier launch.
func claudeSessionMaterialized(root, identity string) bool {
	if root == "" || !claudeCanonicalUUID(identity) {
		return false
	}
	info, err := os.Lstat(claudeMarkerPath(root, identity))
	return err == nil && info.Mode().IsRegular()
}

// claudeMarker is a validated marker file. exists is false when the root or
// the file is absent.
type claudeMarker struct {
	exists    bool
	hasPrompt bool
	prompt    string
	document  map[string]json.RawMessage
}

func claudeCheckMarkerTarget(root, identity string) error {
	if strings.TrimSpace(root) == "" || !filepath.IsAbs(strings.TrimSpace(root)) {
		return errors.New("Claude session root is not an absolute path")
	}
	if !claudeCanonicalUUID(identity) {
		return errors.New("Claude Session identity is not a UUID")
	}
	return nil
}

// claudeReadMarker validates the marker of identity under root.
func claudeReadMarker(root, identity string) (claudeMarker, error) {
	if err := claudeCheckMarkerTarget(root, identity); err != nil {
		return claudeMarker{}, err
	}
	root = strings.TrimSpace(root)
	rootInfo, err := os.Lstat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return claudeMarker{}, nil
	}
	if err != nil {
		return claudeMarker{}, err
	}
	if rootInfo.Mode()&fs.ModeSymlink != 0 || !rootInfo.IsDir() {
		return claudeMarker{}, errors.New("Claude session root is not a real directory")
	}
	if !privateModeMatches(rootInfo, 0o700) {
		return claudeMarker{}, errors.New("Claude session root is not private")
	}
	if err := privatefs.CheckPath(root, "directory", true); err != nil {
		return claudeMarker{}, fmt.Errorf("Claude session root is not private: %w", err)
	}
	path := claudeMarkerPath(root, identity)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return claudeMarker{}, nil
	}
	if err != nil {
		return claudeMarker{}, err
	}
	if !info.Mode().IsRegular() {
		return claudeMarker{}, errors.New("Claude instruction marker is not a regular file")
	}
	if !privateModeMatches(info, 0o600) {
		return claudeMarker{}, errors.New("Claude instruction marker is not private")
	}
	if info.Size() > claudeMarkerLimit {
		return claudeMarker{}, errors.New("Claude instruction marker is too large")
	}
	file, err := privatefs.OpenRead(path, true)
	if err != nil {
		return claudeMarker{}, fmt.Errorf("Claude instruction marker is not private: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return claudeMarker{}, err
	}
	if !os.SameFile(info, opened) {
		return claudeMarker{}, errors.New("Claude instruction marker changed while it was read")
	}
	data, err := io.ReadAll(io.LimitReader(file, claudeMarkerLimit+1))
	if err != nil {
		return claudeMarker{}, err
	}
	after, err := file.Stat()
	if err != nil {
		return claudeMarker{}, err
	}
	if len(data) > claudeMarkerLimit || int64(len(data)) != info.Size() || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return claudeMarker{}, errors.New("Claude instruction marker changed while it was read")
	}
	return claudeDecodeMarker(data, identity)
}

func claudeDecodeMarker(data []byte, identity string) (claudeMarker, error) {
	invalid := errors.New("Claude instruction marker is invalid")
	if !utf8.Valid(data) {
		return claudeMarker{}, invalid
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(data, &document) != nil || document == nil {
		return claudeMarker{}, invalid
	}
	var session string
	if json.Unmarshal(document["session_id"], &session) != nil || session != identity {
		return claudeMarker{}, invalid
	}
	marker := claudeMarker{exists: true, document: document}
	if raw, present := document["system_prompt_append"]; present {
		var prompt *string
		if json.Unmarshal(raw, &prompt) != nil || prompt == nil || len(*prompt) > claudePromptLimit || !utf8.ValidString(*prompt) {
			return claudeMarker{}, invalid
		}
		marker.hasPrompt, marker.prompt = true, *prompt
	}
	return marker, nil
}

// claudeWriteMarker records prompt as the instructions of identity. An
// invalid existing marker is reported and left untouched.
func claudeWriteMarker(root, identity, prompt string) error {
	if len(prompt) > claudePromptLimit || !utf8.ValidString(prompt) {
		return errors.New("Claude system prompt addition is too large or not UTF-8")
	}
	if err := claudeCheckMarkerTarget(root, identity); err != nil {
		return err
	}
	root = strings.TrimSpace(root)
	claudeMarkerWrites.Lock()
	defer claudeMarkerWrites.Unlock()
	if _, err := os.Lstat(root); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
			return err
		}
		if err := os.Mkdir(root, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if err := protectPrivateDir(root); err != nil {
			return err
		}
	}
	marker, err := claudeReadMarker(root, identity)
	if err != nil {
		return err
	}
	if marker.exists && marker.hasPrompt && marker.prompt == prompt {
		return nil
	}
	document := marker.document
	if document == nil {
		document = map[string]json.RawMessage{}
	}
	document["session_id"], _ = json.Marshal(identity)
	document["system_prompt_append"], _ = json.Marshal(prompt)
	data, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if len(data) > claudeMarkerLimit {
		return errors.New("Claude instruction marker would be too large")
	}
	temp := filepath.Join(root, "."+identity+"."+uuid.NewString()+".tmp")
	defer os.Remove(temp)
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(temp, claudeMarkerPath(root, identity)); err != nil {
		return err
	}
	return syncDirectory(root)
}
