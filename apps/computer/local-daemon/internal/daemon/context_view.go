package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// skillPackageClient fetches Skill packages from TeamHub. A package is at most
// 32 MiB, so the timeout leaves room for a slow link.
var skillPackageClient = &http.Client{Timeout: 2 * time.Minute}

// ensureContextView brings the command's Context to the View the reference
// names, fetching what the workspace lacks from the current connection.
// A Daemon without a View store runs Operations where its resolver places
// them, so it has no View to bring current.
func (d *Daemon) ensureContextView(ctx context.Context, command protocol.Command, encoded json.RawMessage) error {
	if d.contextViews == nil {
		return nil
	}
	// The content URL is valid only for the connection that sent it, so a
	// fetch ends with that connection or a drain.
	if dispatch := d.dispatcher.Load(); dispatch != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		defer context.AfterFunc(dispatch.ctx, cancel)()
	}
	var ref lingercontext.ViewRef
	if err := json.Unmarshal(encoded, &ref); err != nil {
		return lingercontext.ErrContextConflict
	}
	contentURL := ""
	if current := d.contentURL.Load(); current != nil {
		contentURL = *current
	}
	startedAt := time.Now()
	_, err := d.contextViews.Ensure(ctx, lingercontext.ViewRequest{
		TenantID: command.TenantID, RunnerID: command.RunnerID, AgentID: command.AgentID,
		WorkspaceGrantID: command.WorkspaceGrantID, ExecutionContextKey: command.ExecutionContextKey,
		RuntimeInstanceID: command.RuntimeInstanceID, ViewDigest: ref.ViewDigest,
	}, lingercontext.ContentSource{
		ContentURL:        contentURL,
		FetchSkillPackage: d.skillPackageFetcher(command.TenantID, command.AgentID),
	})
	slog.Info("runner.context_view.ensured", "command_id", command.CommandID, "agent_id", command.AgentID,
		"view_digest", ref.ViewDigest, "duration_ms", time.Since(startedAt).Milliseconds(), "ok", err == nil)
	return err
}

// contextViewFailure reports why an Operation could not get its View. Only a
// fetch that a later attempt may pass is retryable.
func contextViewFailure(err error) map[string]any {
	code := "CONTEXT_VIEW_FAILED"
	if errors.Is(err, lingercontext.ErrProjectionRecoveryRequired) {
		code = "CONTEXT_RECOVERY_REQUIRED"
	} else if errors.Is(err, lingercontext.ErrSkillPackageUnavailable) {
		code = "SKILL_PACKAGE_UNAVAILABLE"
	}
	return map[string]any{
		"code": code, "message": err.Error(),
		"retryable": errors.Is(err, lingercontext.ErrInputDownloadUnavailable),
	}
}

func (d *Daemon) finishContextViewFailure(ctx context.Context, stream transport.Stream, command protocol.Command, cause error) error {
	event := withOperationIdentity(protocol.Event{
		Type: protocol.EventOperationFailed, Stage: "operation_admission", SentAt: time.Now().UTC(),
		Payload: mustJSON(contextViewFailure(cause)),
	}, command)
	persisted, err := d.ledger.Complete(ctx, operationIdentity(command), event)
	if err != nil {
		return err
	}
	return stream.Send(ctx, persisted)
}

// contextHasActiveOperation reports whether an Operation of the Context runs
// or is prepared; its View must not change under it.
func (d *Daemon) contextHasActiveOperation(command protocol.Command) bool {
	_, busy := d.operationOccupancy(OperationIdentity{
		TenantID: command.TenantID, ExecutionContextKey: command.ExecutionContextKey, OperationID: command.OperationID,
	})
	return busy
}

// skillPackageFetcher downloads Skill packages with the Agent's TeamHub CLI
// credential, the one the Agent Service already pushed to this Computer.
func (d *Daemon) skillPackageFetcher(tenantID, agentID string) func(context.Context, string) (io.ReadCloser, error) {
	return func(ctx context.Context, manifestID string) (io.ReadCloser, error) {
		if d.cliCredentials == nil {
			return nil, fmt.Errorf("%w: TeamHub CLI credentials are unavailable", lingercontext.ErrSkillPackageUnavailable)
		}
		installation, err := d.cliCredentials.Lookup(tenantID, agentID)
		if errors.Is(err, clicredential.ErrNotInstalled) {
			return nil, fmt.Errorf("%w: %w", lingercontext.ErrInputDownloadUnavailable, err)
		}
		if err != nil {
			return nil, err
		}
		token, err := os.ReadFile(installation.CredentialPath)
		if err != nil {
			return nil, err
		}
		route := strings.TrimSuffix(installation.Profile.URL, "/") + "/api/agent/v1/skills/packages/" + manifestID
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, route, nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
		response, err := skillPackageClient.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, lingercontext.ErrInputDownloadUnavailable
		}
		if response.StatusCode == http.StatusOK {
			return skillPackageArchive(route, response)
		}
		_ = response.Body.Close()
		if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("%w (HTTP %d)", lingercontext.ErrSkillPackageUnavailable, response.StatusCode)
		}
		return nil, fmt.Errorf("%w (HTTP %d)", lingercontext.ErrInputDownloadUnavailable, response.StatusCode)
	}
}

// skillPackageArchive returns the body of a TeamHub Skill package response.
// Any other 200, such as a Web host's SPA page for a URL that does not reach
// TeamHub, names the route and what it returned instead of a ZIP error.
func skillPackageArchive(route string, response *http.Response) (io.ReadCloser, error) {
	contentType := response.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(contentType)
	body := bufio.NewReader(response.Body)
	magic, _ := body.Peek(4)
	if mediaType == "application/zip" && bytes.Equal(magic, []byte("PK\x03\x04")) {
		return struct {
			io.Reader
			io.Closer
		}{body, response.Body}, nil
	}
	_ = response.Body.Close()
	if contentType == "" {
		contentType = "no Content-Type"
	}
	return nil, fmt.Errorf("Skill package download GET %s returned HTTP 200 %s, not a ZIP archive; the TeamHub CLI URL may not reach the Agent API", route, contentType)
}

func operationAcceptedEvent(command protocol.Command) protocol.Event {
	return withOperationIdentity(protocol.Event{
		Type: protocol.EventOperationAccepted, ProtocolVersion: command.ProtocolVersion,
		SentAt: time.Now().UTC(), Payload: mustJSON(map[string]any{
			"runner_pid": os.Getpid(), "operation_kind": command.OperationKind,
		}),
	}, command)
}
