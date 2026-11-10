package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listRoomRoutines(c *gin.Context) {
	params := contractParams[httpapi.ListRoomRoutinesParams](c)
	authority, err := a.reminders.HumanRoomAuthority(c, currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	if a.writeReminderError(c, "authorize Reminder list", err) {
		return
	}
	cursor, limit := "", int32(50)
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = int32(*params.Limit)
	}
	page, err := a.reminders.List(c, authority, cursor, limit)
	if a.writeReminderError(c, "list Reminders", err) {
		return
	}
	items := make([]httpapi.Routine, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, reminderModel(item))
	}
	c.JSON(http.StatusOK, httpapi.RoutinePage{Items: items, Page: pageMeta(page.HasMore, page.NextCursor)})
}

func (a *App) createRoomRoutine(c *gin.Context) {
	var request httpapi.RoutineCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reminder input is invalid")
		return
	}
	caller := reminder.HumanCaller(currentPrincipal(c).Session.AccountID)
	result, err := a.reminders.Create(c, caller, c.Param("roomId"), "", nil, reminderCreateInput(request))
	if a.writeReminderError(c, "create Reminder", err) {
		return
	}
	writeReminderResult(c, result)
}

func (a *App) updateRoutine(c *gin.Context) {
	payload, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20))
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reminder input is invalid")
		return
	}
	var request httpapi.RoutineUpdateRequest
	if decodeStrictJSON(bytes.NewReader(payload), &request, "request body must contain one JSON object") != nil || request.ExpectedRevision < 1 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reminder input is invalid")
		return
	}
	caller := reminder.HumanCaller(currentPrincipal(c).Session.AccountID)
	result, err := a.reminders.Update(c, caller, c.Param("routineId"), "", nil, reminderUpdateInput(request, payload))
	if a.writeReminderError(c, "update Reminder", err) {
		return
	}
	writeReminderResult(c, result)
}

func (a *App) deleteRoutine(c *gin.Context) {
	params := contractParams[httpapi.DeleteRoutineParams](c)
	if params.ExpectedRevision < 1 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reminder input is invalid")
		return
	}
	caller := reminder.HumanCaller(currentPrincipal(c).Session.AccountID)
	_, err := a.reminders.Delete(c, caller, c.Param("routineId"), "", nil, params.ExpectedRevision)
	if a.writeReminderError(c, "delete Reminder", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) runRoutine(c *gin.Context) {
	caller := reminder.HumanCaller(currentPrincipal(c).Session.AccountID)
	result, err := a.reminders.RunNow(c, caller, c.Param("routineId"), "", nil)
	if a.writeReminderError(c, "run Routine", err) {
		return
	}
	writeReminderResult(c, result)
}

func reminderCreateInput(request httpapi.RoutineCreateRequest) reminder.CreateInput {
	input := reminder.CreateInput{
		Name:        request.Name,
		Instruction: request.Instruction,
		Cadence:     reminderCadence(request.Cadence),
		Enabled:     request.Enabled,
	}
	if request.MentionActorId != nil {
		mention := *request.MentionActorId
		input.MentionActorID = &mention
	}
	return input
}

func reminderUpdateInput(request httpapi.RoutineUpdateRequest, payload []byte) reminder.UpdateInput {
	input := reminder.UpdateInput{ExpectedRevision: request.ExpectedRevision}
	if request.Name != nil {
		input.Name = request.Name
	}
	if request.Instruction != nil {
		input.Instruction = request.Instruction
	}
	if request.Cadence != nil {
		cadence := reminderCadence(*request.Cadence)
		input.Cadence = &cadence
	}
	if request.Enabled != nil {
		input.Enabled = request.Enabled
	}
	if mention, ok := mentionPatch(payload); ok {
		input.MentionActorID = &mention
	}
	return input
}

func mentionPatch(payload []byte) (*string, bool) {
	var body map[string]json.RawMessage
	if json.Unmarshal(payload, &body) != nil {
		return nil, false
	}
	raw, found := body["mention_actor_id"]
	if !found {
		return nil, false
	}
	if string(raw) == "null" {
		var empty *string
		return empty, true
	}
	var mention string
	if json.Unmarshal(raw, &mention) != nil || mention == "" {
		return nil, false
	}
	return &mention, true
}

func reminderCadence(value httpapi.RoutineCadence) reminder.Cadence {
	cadence := reminder.Cadence{
		Kind: string(value.Kind), Timezone: value.Timezone, Hour: value.Hour,
		Minute: value.Minute, IntervalHours: value.IntervalHours, RunAt: value.RunAt,
	}
	if value.Weekdays != nil {
		cadence.Weekdays = make([]string, 0, len(*value.Weekdays))
		for _, day := range *value.Weekdays {
			cadence.Weekdays = append(cadence.Weekdays, string(day))
		}
	}
	return cadence
}

func reminderModel(value reminder.Reminder) httpapi.Routine {
	model := httpapi.Routine{
		Id: value.ID, RoomId: value.RoomID,
		CreatedByActorId: value.CreatedByActorID, Name: value.Name, Instruction: value.Instruction,
		Enabled: value.Enabled, Revision: value.Revision, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
	if value.Listener != nil {
		model.Listener = &httpapi.RoutineListener{App: httpapi.RoutineListenerApp(value.Listener.App)}
	} else {
		cadence := reminderCadenceModel(value.Cadence)
		model.Cadence = &cadence
	}
	if value.MentionActorID != nil {
		mention := *value.MentionActorID
		model.MentionActorId = &mention
	}
	if value.NextRunAt != nil {
		model.NextRunAt = value.NextRunAt
	}
	return model
}

func reminderCadenceModel(value reminder.Cadence) httpapi.RoutineCadence {
	model := httpapi.RoutineCadence{
		Kind: httpapi.RoutineCadenceKind(value.Kind), Timezone: value.Timezone,
		Hour: value.Hour, Minute: value.Minute, IntervalHours: value.IntervalHours, RunAt: value.RunAt,
	}
	if len(value.Weekdays) > 0 {
		days := make([]httpapi.RoutineWeekday, 0, len(value.Weekdays))
		for _, day := range value.Weekdays {
			days = append(days, httpapi.RoutineWeekday(day))
		}
		model.Weekdays = &days
	}
	return model
}

// writeReminderResult renders a replay from its stored Routine like the first
// response, so an app listener replays without a cadence.
func writeReminderResult(c *gin.Context, result reminder.Result) {
	c.JSON(result.Status, reminderModel(result.Value))
}

func (a *App) writeReminderError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, reminder.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reminder input is invalid")
	case errors.Is(err, reminder.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Reminder was not found")
	case errors.Is(err, reminder.ErrAppListener):
		a.writeError(c, http.StatusConflict, "ROUTINE_APP_LISTENER", "This Routine listens to a connected app and can only be paused or resumed; it goes away when you revoke your AnotherMe's access to the app")
	case errors.Is(err, reminder.ErrTemplateAgentUnavailable):
		a.writeError(c, http.StatusConflict, "ROUTINE_AGENT_UNAVAILABLE", "The Agent this Routine belongs to is not active; try again after it is back")
	case errors.Is(err, reminder.ErrConflict):
		a.writeError(c, http.StatusConflict, "CONFLICT", "Reminder was updated by another request")
	case errors.Is(err, reminder.ErrPendingOnceLimit):
		a.writeError(c, http.StatusConflict, "REMINDER_LIMIT_REACHED", "this Room already has the maximum number of one-shot Reminders waiting")
	case errors.Is(err, reminder.ErrLimitReached):
		a.writeError(c, http.StatusConflict, "REMINDER_LIMIT_REACHED", "this Room already has the maximum number of Reminders")
	default:
		a.internalError(c, action, err)
	}
	return true
}
