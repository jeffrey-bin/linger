package app

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentRoutineRequestMaxBytes = 256 << 10

func (a *App) createAgentRoutine(c *gin.Context) {
	raw, request, ok := decodeAgentRoutineBody[teamhubagentapi.AgentCreateRoutineRequest](c)
	if !ok {
		return
	}
	room, ok := a.authorizeAgentRoutine(c, "create_routine")
	if !ok {
		return
	}
	schedule, err := reminder.ParseSchedule(reminderSchedule(request.Schedule))
	if a.writeAgentRoutineError(c, err) {
		return
	}
	mention := request.MentionActorId
	if mention != nil && *mention == "self" {
		actorID := room.ActorID
		mention = &actorID
	}
	result, err := a.reminders.Create(c.Request.Context(), reminder.AgentCaller(room), room.RoomID, agentauth.IdempotencyKey("create_routine", request.InvocationId), hashRoutineBody(raw), reminder.CreateInput{
		Name: request.Name, Instruction: request.Instruction, MentionActorID: mention, Cadence: schedule,
		TrackingItemID: valueOrEmpty(request.TrackingItemId), TrackingPurpose: valueOrEmpty(request.TrackingPurpose),
	})
	if a.writeAgentRoutineError(c, err) {
		return
	}
	a.finishAgentRoutine(c, result)
}

func (a *App) listAgentRoutines(c *gin.Context) {
	_, _, ok := decodeAgentRoutineBody[teamhubagentapi.AgentRoutineCommandRequest](c)
	if !ok {
		return
	}
	room, ok := a.authorizeAgentRoutine(c, "list_routines")
	if !ok {
		return
	}
	page, err := a.reminders.List(c.Request.Context(), room, "", reminderMaxList)
	if a.writeAgentRoutineError(c, err) {
		return
	}
	routines := make([]teamhubagentapi.AgentRoutine, 0, len(page.Items))
	for _, item := range page.Items {
		routines = append(routines, agentRoutineModel(item))
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentListRoutinesResponse{
		Routines: routines,
	})
}

func (a *App) pauseAgentRoutine(c *gin.Context) {
	a.setAgentRoutineEnabled(c, "pause_routine", false)
}

func (a *App) enableAgentRoutine(c *gin.Context) {
	a.setAgentRoutineEnabled(c, "enable_routine", true)
}

func (a *App) setAgentRoutineEnabled(c *gin.Context, tool string, enabled bool) {
	raw, request, ok := decodeAgentRoutineBody[teamhubagentapi.AgentRoutineIdRequest](c)
	if !ok {
		return
	}
	room, ok := a.authorizeAgentRoutine(c, tool)
	if !ok {
		return
	}
	result, err := a.reminders.Update(c.Request.Context(), reminder.AgentCaller(room), request.RoutineId, agentauth.IdempotencyKey(tool, request.InvocationId), hashRoutineBody(raw), reminder.UpdateInput{Enabled: &enabled})
	if a.writeAgentRoutineError(c, err) {
		return
	}
	a.finishAgentRoutine(c, result)
}

func (a *App) runAgentRoutine(c *gin.Context) {
	raw, request, ok := decodeAgentRoutineBody[teamhubagentapi.AgentRoutineIdRequest](c)
	if !ok {
		return
	}
	room, ok := a.authorizeAgentRoutine(c, "run_routine")
	if !ok {
		return
	}
	result, err := a.reminders.RunNow(c.Request.Context(), reminder.AgentCaller(room), request.RoutineId, agentauth.IdempotencyKey("run_routine", request.InvocationId), hashRoutineBody(raw))
	if a.writeAgentRoutineError(c, err) {
		return
	}
	a.finishAgentRoutine(c, result)
}

func (a *App) deleteAgentRoutine(c *gin.Context) {
	raw, request, ok := decodeAgentRoutineBody[teamhubagentapi.AgentRoutineIdRequest](c)
	if !ok {
		return
	}
	room, ok := a.authorizeAgentRoutine(c, "delete_routine")
	if !ok {
		return
	}
	result, err := a.reminders.Delete(c.Request.Context(), reminder.AgentCaller(room), request.RoutineId, agentauth.IdempotencyKey("delete_routine", request.InvocationId), hashRoutineBody(raw), 0)
	if a.writeAgentRoutineError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentDeleteRoutineResponse{
		Deleted: true, RoutineId: result.Value.ID,
	})
}

const reminderMaxList int32 = 50

func (a *App) authorizeAgentRoutine(
	c *gin.Context,
	tool string,
) (reminder.Authority, bool) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return reminder.Authority{}, false
	}
	authority, err := a.agentAuth.Authorize(c.Request.Context(), token, tool)
	if a.writeAgentRoutineError(c, err) {
		return reminder.Authority{}, false
	}
	if authority.RoomID == "" {
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, "Routines are only available in the current room")
		return reminder.Authority{}, false
	}
	room, err := a.reminders.AgentRoomAuthority(c.Request.Context(), authority.AgentActorID, authority.AgentID, authority.RoomID)
	if a.writeAgentRoutineError(c, err) {
		return reminder.Authority{}, false
	}
	room.Principal = authority.Principal
	return room, true
}

func (a *App) finishAgentRoutine(c *gin.Context, result reminder.Result) {
	c.JSON(http.StatusOK, teamhubagentapi.AgentRoutineResponse{
		Routine: agentRoutineModel(result.Value),
	})
}

func (a *App) writeAgentRoutineError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, reminder.ErrMentionInvalid):
		a.writeAgentAPIErrorWithIssues(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Routine mention is invalid", []teamhubagentapi.AgentApiErrorIssue{{
			Path: "mention_actor_id", Code: "mention_unavailable",
			Message: "Use self, or the actor id of an Agent who is still in this room.",
		}})
	case errors.Is(err, reminder.ErrPendingOnceLimit):
		a.writeAgentAPIErrorWithIssues(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "This room already has 20 one-shot routines waiting", []teamhubagentapi.AgentApiErrorIssue{{
			Path: "schedule.run_at", Code: "routine_once_limit",
			Message: "Wait for a one-shot routine to fire, or delete one, before adding another.",
		}})
	case errors.Is(err, reminder.ErrAppListener):
		a.writeAgentAPIErrorWithIssues(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "This routine listens to a connected app", []teamhubagentapi.AgentApiErrorIssue{{
			Path: "routine_id", Code: "routine_app_listener",
			Message: "An app listener can only be paused or enabled. It goes away when the Human revokes your access to that app.",
		}})
	case errors.Is(err, reminder.ErrLimitReached):
		a.writeAgentAPIErrorWithIssues(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "This room already has 50 routines", []teamhubagentapi.AgentApiErrorIssue{{
			Path: "name", Code: "routine_limit",
			Message: "Delete a routine in this room before creating another.",
		}})
	case errors.Is(err, reminder.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Routine input is invalid")
	case errors.Is(err, reminder.ErrNotFound), errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "Routine is not available in this room")
	case errors.Is(err, reminder.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "This Routine call was already used with different input")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, reminder.ErrTemplateAgentUnavailable):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeAgentConfigurationUpdating, "The Agent this Routine belongs to is not active; try again after it is back")
	case errors.Is(err, reminder.ErrConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeVersionConflict, "Routine changed while it was being updated")
	default:
		if a.logger != nil {
			a.logger.Error("Agent routine", "request_id", c.GetString("request_id"), "error_type", err.Error())
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Routine service could not complete the request")
	}
	return true
}

func decodeAgentRoutineBody[T any](c *gin.Context) ([]byte, T, bool) {
	var request T
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentRoutineRequestMaxBytes)
	raw, err := io.ReadAll(body)
	if err != nil || decodeStrictJSON(bytes.NewReader(raw), &request, "request body must contain one JSON object") != nil {
		c.JSON(http.StatusBadRequest, teamhubagentapi.AgentApiErrorEnvelope{Error: teamhubagentapi.AgentApiError{
			Code: teamhubagentapi.AgentApiErrorCodeInvalidRequest, Message: "Routine request is invalid", RequestId: requestIDOrNew(c),
		}})
		return nil, request, false
	}
	return raw, request, true
}

func requestIDOrNew(c *gin.Context) string {
	if requestID := c.GetString("request_id"); requestID != "" {
		return requestID
	}
	return idgen.New("request")
}

func reminderSchedule(schedule teamhubagentapi.AgentRoutineSchedule) reminder.Schedule {
	parsed := reminder.Schedule{Kind: string(schedule.Kind)}
	if schedule.Time != nil {
		parsed.Time = *schedule.Time
	}
	if schedule.Timezone != nil {
		parsed.Timezone = *schedule.Timezone
	}
	if schedule.Weekdays != nil {
		parsed.Weekdays = make([]string, 0, len(*schedule.Weekdays))
		for _, day := range *schedule.Weekdays {
			parsed.Weekdays = append(parsed.Weekdays, string(day))
		}
	}
	if schedule.IntervalHours != nil {
		hours := *schedule.IntervalHours
		parsed.IntervalHours = &hours
	}
	parsed.RunAt = schedule.RunAt
	return parsed
}

func agentRoutineModel(value reminder.Reminder) teamhubagentapi.AgentRoutine {
	model := teamhubagentapi.AgentRoutine{
		Id: value.ID, Name: value.Name, Instruction: value.Instruction, Enabled: value.Enabled,
	}
	if value.Listener != nil {
		model.Listener = &teamhubagentapi.AgentRoutineListener{App: teamhubagentapi.AgentRoutineListenerApp(value.Listener.App)}
	} else {
		model.Schedule = agentRoutineSchedule(value.Cadence)
	}
	model.MentionActorId = value.MentionActorID
	model.TrackingItemId = value.TrackingItemID
	if value.NextRunAt != nil {
		next := value.NextRunAt.UTC()
		model.NextRunAt = &next
	}
	return model
}

func agentRoutineSchedule(cadence reminder.Cadence) *teamhubagentapi.AgentRoutineSchedule {
	schedule := reminder.ScheduleFromCadence(cadence)
	model := &teamhubagentapi.AgentRoutineSchedule{
		Kind: teamhubagentapi.AgentRoutineScheduleKind(schedule.Kind), IntervalHours: schedule.IntervalHours, RunAt: schedule.RunAt,
	}
	if schedule.Time != "" {
		model.Time = &schedule.Time
	}
	if schedule.Timezone != "" {
		model.Timezone = &schedule.Timezone
	}
	if len(schedule.Weekdays) > 0 {
		days := make([]teamhubagentapi.AgentRoutineWeekday, 0, len(schedule.Weekdays))
		for _, day := range schedule.Weekdays {
			days = append(days, teamhubagentapi.AgentRoutineWeekday(day))
		}
		model.Weekdays = &days
	}
	return model
}

func hashRoutineBody(raw []byte) []byte {
	sum := sha256.Sum256(raw)
	return sum[:]
}
