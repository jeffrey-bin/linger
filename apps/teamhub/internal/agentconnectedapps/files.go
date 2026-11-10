package agentconnectedapps

import (
	"bytes"
	"context"
	"crypto/md5" //nolint:gosec // Composio's file API names uploads by MD5.
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

type FileUploadInput struct {
	ConnectionID string `json:"connection_id"`
	ToolSlug     string `json:"tool_slug"`
	ToolVersion  string `json:"tool_version"`
	Filename     string `json:"filename"`
	Mimetype     string `json:"mimetype"`
	MD5          string `json:"md5"`
}
type fileUploadProvider interface {
	RequestFileUpload(context.Context, composio.FileUploadRequest) (composio.FileUploadTarget, error)
}

var md5Pattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var mimePattern = regexp.MustCompile(`^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$`)

func (s *Service) PrepareFileUpload(ctx context.Context, token string, input FileUploadInput) (target composio.FileUploadTarget, err error) {
	if !connectionIDPattern.MatchString(input.ConnectionID) || !toolSlugPattern.MatchString(input.ToolSlug) || !toolVersionPattern.MatchString(input.ToolVersion) ||
		strings.TrimSpace(input.Filename) == "" || input.Filename == "." || input.Filename == ".." || len(input.Filename) > 1024 || strings.ContainsAny(input.Filename, "/\\\r\n\x00") || len(input.Mimetype) > 255 || !mimePattern.MatchString(input.Mimetype) || !md5Pattern.MatchString(input.MD5) {
		return composio.FileUploadTarget{}, ErrInvalid
	}
	if s == nil || s.pool == nil || s.connections == nil || s.contexts == nil || s.provider == nil {
		return composio.FileUploadTarget{}, unavailableError(nil)
	}
	provider, ok := s.provider.(fileUploadProvider)
	if !ok {
		return composio.FileUploadTarget{}, unavailableError(nil)
	}
	connection, err := s.authorizeExecution(ctx, token, input.ConnectionID)
	if err != nil {
		return composio.FileUploadTarget{}, err
	}
	defer func() {
		s.logCall(ctx, "files/upload-request", connection, input.ToolSlug, input.ToolVersion, callOutcome(err))
	}()
	status, err := s.provider.GetConnectionStatusForToolkit(ctx, connection.UpstreamConnectionID, connection.ToolkitSlug)
	if err != nil {
		return composio.FileUploadTarget{}, mapToolError(err, "search")
	}
	if status != composio.ConnectionActive {
		return composio.FileUploadTarget{}, &Error{Code: "connection_not_active", Message: "The selected connected app is not active"}
	}
	tool, err := s.pinnedTool(ctx, connection, input.ToolSlug, input.ToolVersion, "search")
	if err != nil {
		return composio.FileUploadTarget{}, err
	}
	if !hasFileUploadInput(tool.InputParameters, 0) {
		return composio.FileUploadTarget{}, mapToolError(errToolNotFound, "search")
	}
	current, err := s.authorizeExecution(ctx, token, input.ConnectionID)
	if err != nil {
		return composio.FileUploadTarget{}, err
	}
	if current != connection {
		return composio.FileUploadTarget{}, &Error{Code: "connection_not_active", Message: "The selected connected app changed"}
	}
	target, err = provider.RequestFileUpload(ctx, composio.FileUploadRequest{Filename: input.Filename, Mimetype: input.Mimetype, MD5: input.MD5, ToolSlug: input.ToolSlug, ToolkitSlug: connection.ToolkitSlug})
	if err != nil {
		return composio.FileUploadTarget{}, mapToolError(err, "search")
	}
	u, err := url.Parse(target.URL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || target.Key == "" {
		return composio.FileUploadTarget{}, unavailableError(nil)
	}
	return target, nil
}
func hasFileUploadInput(value any, depth int) bool {
	if depth > 32 {
		return false
	}
	switch node := value.(type) {
	case map[string]any:
		if node["file_uploadable"] == true {
			return true
		}
		for _, child := range node {
			if hasFileUploadInput(child, depth+1) {
				return true
			}
		}
	case []any:
		for _, child := range node {
			if hasFileUploadInput(child, depth+1) {
				return true
			}
		}
	}
	return false
}

// fileTransferClient sends staged bytes to the provider's upload URL. It never
// follows a redirect, so the bytes go only where the provider said.
var fileTransferClient = &http.Client{
	Timeout:       3 * time.Minute,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// StageFile uploads content for a tool's file input and returns the reference
// that input takes. It is TeamHub's side of the CLI's upload staging, for
// files TeamHub itself holds; the staged file is used by one later call.
func (s *Service) StageFile(ctx context.Context, token string, input FileUploadInput, content []byte) (map[string]any, error) {
	sum := md5.Sum(content) //nolint:gosec // a checksum the file API asks for, not a security digest
	input.MD5 = hex.EncodeToString(sum[:])
	target, err := s.PrepareFileUpload(ctx, token, input)
	if err != nil {
		return nil, err
	}
	if err := transferFile(ctx, fileTransferClient, target.URL, input.Mimetype, content); err != nil {
		return nil, err
	}
	return map[string]any{"name": input.Filename, "mimetype": input.Mimetype, "s3key": target.Key}, nil
}

func transferFile(ctx context.Context, client *http.Client, url, mimetype string, content []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(content))
	if err != nil {
		return unavailableError(err)
	}
	request.Header.Set("Content-Type", mimetype)
	response, err := client.Do(request)
	if err != nil {
		return unavailableError(err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return unavailableError(fmt.Errorf("file upload returned HTTP %d", response.StatusCode))
	}
	return nil
}
