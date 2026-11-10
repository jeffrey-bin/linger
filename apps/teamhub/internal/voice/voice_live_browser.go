package voice

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// voiceLiveBrowserTarget is the local browser the live session may
// drive, or ok=false when its Agent has none the Human owns.
func (s *Service) voiceLiveBrowserTarget(ctx context.Context, session voicelive.Session) (store.GetVoiceLiveComputerTargetRow, roomagent.LocalBrowserTool, bool, error) {
	browser, ok := s.localComputers.(roomagent.LocalBrowserTool)
	if !ok {
		return store.GetVoiceLiveComputerTargetRow{}, nil, false, nil
	}
	target, err := s.queries.GetVoiceLiveComputerTarget(ctx, store.GetVoiceLiveComputerTargetParams{
		AgentActorID: session.Agent.ID, TenantID: session.TenantID, HumanActorID: session.HumanActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.GetVoiceLiveComputerTargetRow{}, nil, false, nil
	}
	if err != nil {
		return store.GetVoiceLiveComputerTargetRow{}, nil, false, err
	}
	return target, browser, true, nil
}

// callVoiceLiveBrowser runs one live browser action on the Agent's Local Computer. Failures are told to the live model, never retried here.
func (s *Service) callVoiceLiveBrowser(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.BrowserArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	toolName, arguments, ok := voicelive.BrowserCall(args)
	if !ok {
		return "", voicelive.ErrInvalid
	}
	target, browser, ok, err := s.voiceLiveBrowserTarget(ctx, session)
	if err != nil {
		return "", err
	}
	if !ok {
		return voicelive.ErrorOutput("no_local_computer"), nil
	}
	// The page the live voice saw last: where a hand-off continues, and what a
	// risky click would press.
	lastPage := ""
	if previous, err := s.queries.GetLatestVoiceLiveToolOutput(ctx, store.GetLatestVoiceLiveToolOutputParams{
		VoiceSessionID: session.ID, Name: voicelive.ToolComputerBrowser,
	}); err == nil {
		var shown struct {
			Page string `json:"page"`
		}
		_ = json.Unmarshal([]byte(previous), &shown)
		lastPage = shown.Page
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if request.TurnId != "" {
		calls, err := s.queries.CountVoiceLiveTurnToolCalls(ctx, store.CountVoiceLiveTurnToolCallsParams{
			VoiceSessionID: session.ID, TurnID: request.TurnId, Name: voicelive.ToolComputerBrowser,
		})
		if err != nil {
			return "", err
		}
		if calls >= voicelive.MaxBrowserCallsPerTurn {
			// Longer work moves to a background task that goes on from this
			// page, logged in through the same browser.
			return voicelive.Output(map[string]string{
				"error":       "step_limit",
				"current_url": voicelive.BrowserPageURL(lastPage),
				"detail":      "Stop driving the browser yourself. If the work should go on, call start_task with surface web and a goal that says what is left to do, what is already done and that it starts from current_url (the background work uses the same logged-in browser); otherwise tell the user where it is stuck.",
			}), nil
		}
	}
	// A click or Enter that may send, pay or delete waits for the user's yes.
	if summary, risky := voicelive.BrowserRisk(args, lastPage); risky {
		prompt := voicelive.NeedsConfirmation(summary)
		if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
			return prompt, err
		}
	}
	result, err := browser.CallLocalBrowserTool(ctx, roomagent.LocalBrowserToolCall{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID,
		ComputerID: target.ComputerID, AgentID: target.AgentManagementID,
		ToolSessionID: "voice-" + strings.TrimPrefix(session.ID, "voice_session_"),
		ToolName:      toolName, Arguments: arguments,
	})
	if err != nil {
		var rejected *roomagent.LocalComputerToolError
		if errors.As(err, &rejected) {
			code := strings.ToLower(rejected.Code)
			if detail, ok := voicelive.BrowserConnectionDetail(code); ok {
				return voicelive.Output(map[string]string{"error": code, "detail": detail}), nil
			}
			return voicelive.Output(map[string]string{"error": code, "detail": voicelive.Snippet(rejected.Message)}), nil
		}
		s.logger.Warn("live local browser call failed", "voice_session_id", session.ID, "tool", toolName, "error", err)
		return voicelive.ErrorOutput("browser_unavailable"), nil
	}
	page, truncated := voicelive.BrowserPage(result.Text)
	output := map[string]any{"page": page}
	if truncated {
		output["truncated"] = true
	}
	if result.IsError {
		output["error"] = "action_failed"
	}
	return voicelive.Output(output), nil
}
