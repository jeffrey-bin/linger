package voice

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The live voice lists, sets up and changes this Room's Routines as the
// call's Agent, through the reminder commands the Agent's routine CLI uses.

func (s *Service) runVoiceLiveRoutineTool(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.RoutineArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	room, output, err := s.voiceLiveRoutineAuthority(ctx, session)
	if output != "" || err != nil {
		return output, err
	}
	switch request.Name {
	case voicelive.ToolListRoutines:
		return s.listVoiceLiveRoutines(ctx, room)
	case voicelive.ToolCreateRoutine:
		return s.createVoiceLiveRoutine(ctx, session, request, room, args)
	case voicelive.ToolChangeRoutine:
		return s.changeVoiceLiveRoutine(ctx, session, request, room, args)
	}
	return voicelive.ErrorOutput("unknown_tool"), nil
}

// voiceLiveRoutineAuthority is the call's Agent in the call's Room, as the
// routine commands authorize it.
func (s *Service) voiceLiveRoutineAuthority(ctx context.Context, session voicelive.Session) (reminder.Authority, string, error) {
	principal, err := s.voiceLiveAgentPrincipal(ctx, session)
	if errors.Is(err, errVoiceLiveAgentUnavailable) {
		return reminder.Authority{}, voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return reminder.Authority{}, "", err
	}
	room, err := s.reminders.AgentRoomAuthority(ctx, session.Agent.ID, principal.AgentID, session.RoomID)
	if errors.Is(err, reminder.ErrNotFound) || errors.Is(err, reminder.ErrForbidden) {
		return reminder.Authority{}, voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return reminder.Authority{}, "", err
	}
	room.Principal = &principal
	return room, "", nil
}

// listVoiceLiveRoutines reads this Room's routines as the Agent sees them.
func (s *Service) listVoiceLiveRoutines(ctx context.Context, room reminder.Authority) (string, error) {
	page, err := s.reminders.List(ctx, room, "", voicelive.AppResultLimit*2)
	if err != nil {
		return "", err
	}
	routines := make([]map[string]any, 0, len(page.Items))
	for _, item := range page.Items {
		routine := map[string]any{"routine_id": item.ID, "name": item.Name, "instruction": voicelive.Snippet(item.Instruction), "enabled": item.Enabled}
		if item.NextRunAt != nil {
			routine["next_run"] = item.NextRunAt.Local().Format("2006-01-02 15:04")
		}
		if item.Listener != nil {
			routine["listens_to"] = item.Listener.App
		} else {
			routine["schedule"] = voicelive.RoutineWhen(item.Cadence)
		}
		routines = append(routines, routine)
	}
	return voicelive.Output(map[string]any{"routines": routines}), nil
}

// createVoiceLiveRoutine sets up a Routine the user heard and agreed to. A
// reminder posts its instruction; agent_does_it wakes the call's Agent.
func (s *Service) createVoiceLiveRoutine(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, room reminder.Authority, args voicelive.RoutineArguments) (string, error) {
	name := strings.Join(strings.Fields(args.Name), " ")
	instruction := strings.TrimSpace(args.Instruction)
	if name == "" || instruction == "" {
		return "", voicelive.ErrInvalid
	}
	cadence, ok := voicelive.RoutineCadence(args)
	if !ok {
		return voicelive.ErrorOutput("invalid_schedule"), nil
	}
	prompt := voicelive.NeedsConfirmation(voicelive.RoutineSummary(name, instruction, cadence, bool(args.AgentDoesIt)))
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
		return prompt, err
	}
	var mention *string
	if args.AgentDoesIt {
		mention = &session.Agent.ID
	}
	encoded, err := json.Marshal(map[string]any{"name": name, "instruction": instruction, "cadence": cadence, "agent_does_it": bool(args.AgentDoesIt)})
	if err != nil {
		return "", err
	}
	// The same confirmed routine in one turn is one Routine even under new call IDs.
	key, hash := voiceLiveTurnKey(session, request, encoded)
	result, err := s.reminders.Create(ctx, reminder.AgentCaller(room), room.RoomID, key, hash, reminder.CreateInput{
		Name: name, Instruction: instruction, MentionActorID: mention, Cadence: cadence,
	})
	if output, handled := voiceLiveRoutineError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	output := map[string]any{"status": "created", "routine_id": result.Value.ID, "name": result.Value.Name, "schedule": voicelive.RoutineWhen(result.Value.Cadence)}
	if result.Value.NextRunAt != nil {
		output["next_run"] = result.Value.NextRunAt.Local().Format("2006-01-02 15:04")
	}
	return voicelive.Output(output), nil
}

// changeVoiceLiveRoutine pauses, resumes, runs or deletes one of this Room's
// Routines; deleting waits for the user's yes.
func (s *Service) changeVoiceLiveRoutine(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, room reminder.Authority, args voicelive.RoutineArguments) (string, error) {
	id := strings.TrimSpace(args.RoutineID)
	if id == "" {
		return "", voicelive.ErrInvalid
	}
	page, err := s.reminders.List(ctx, room, "", 100)
	if err != nil {
		return "", err
	}
	var routine *reminder.Reminder
	for index := range page.Items {
		if page.Items[index].ID == id {
			routine = &page.Items[index]
		}
	}
	if routine == nil {
		return voicelive.ErrorOutput("routine_not_found"), nil
	}
	key, hash := voiceLiveTurnKey(session, request, []byte(args.Action+"\x00"+id))
	caller := reminder.AgentCaller(room)
	var status string
	switch args.Action {
	case "pause", "resume":
		enabled := args.Action == "resume"
		_, err = s.reminders.Update(ctx, caller, id, key, hash, reminder.UpdateInput{Enabled: &enabled})
		status = map[bool]string{true: "resumed", false: "paused"}[enabled]
	case "run":
		_, err = s.reminders.RunNow(ctx, caller, id, key, hash)
		status = "ran"
	case "delete":
		prompt := voicelive.NeedsConfirmation("Will delete the routine “" + routine.Name + "”; it cannot be undone")
		if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
			return prompt, err
		}
		_, err = s.reminders.Delete(ctx, caller, id, key, hash, 0)
		status = "deleted"
	default:
		return "", voicelive.ErrInvalid
	}
	if output, handled := voiceLiveRoutineError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": status, "routine": routine.Name}), nil
}

// voiceLiveRoutineError is what the live model is told for a refused
// Routine command.
func voiceLiveRoutineError(err error) (string, bool) {
	var code string
	switch {
	case err == nil:
		return "", false
	case errors.Is(err, reminder.ErrAppListener):
		code = "listener_routine"
	case errors.Is(err, reminder.ErrPendingOnceLimit):
		code = "once_limit"
	case errors.Is(err, reminder.ErrLimitReached):
		code = "routine_limit"
	case errors.Is(err, reminder.ErrMentionInvalid), errors.Is(err, reminder.ErrTemplateAgentUnavailable):
		code = "agent_unavailable"
	case errors.Is(err, reminder.ErrInvalid):
		code = "invalid_schedule"
	case errors.Is(err, reminder.ErrNotFound):
		code = "routine_not_found"
	case errors.Is(err, reminder.ErrConflict), errors.Is(err, reminder.ErrIdempotencyConflict):
		code = "routine_changed"
	default:
		return "", false
	}
	return voicelive.ErrorOutput(code), true
}

// voiceLiveTurnKey makes one confirmed write in a turn one write even under
// new call IDs: its idempotency key and the hash of what it writes.
func voiceLiveTurnKey(session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, payload []byte) (string, []byte) {
	hash := sha256.Sum256(payload)
	digest := sha256.Sum256([]byte(session.ID + "\x00" + request.TurnId + "\x00" + request.Name + "\x00" + hex.EncodeToString(hash[:])))
	return "voice-live-" + hex.EncodeToString(digest[:16]), hash[:]
}
