package voicelive

import (
	"fmt"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
)

// Routine tools: the live voice lists, sets up and changes this Room's
// Routines as the call's Agent, the way the Agent's routine commands do.
const (
	ToolListRoutines  = "list_routines"
	ToolCreateRoutine = "create_routine"
	ToolChangeRoutine = "change_routine"
)

// RoutineTools are offered with or without connected apps: Routines are the
// Room's own.
var RoutineTools = []Tool{
	{
		Name: ToolListRoutines,
		Description: "List the routines (scheduled reminders and recurring work) set up in this room: routine_id, name, what they do, their schedule, when they run next and whether they are paused. " +
			"Use it when the user asks which scheduled reminders or recurring jobs they have, or before changing one; their own to-dos and things waiting on them are check_reminders. " +
			"Add one with create_routine; pause, resume, run or delete one with change_routine.",
		Parameters: objectSchema([]string{}, map[string]any{}),
	},
	{
		Name: ToolCreateRoutine,
		Description: "Set up a routine in this room: a reminder at a set time, or work the Agent does on a schedule, such as “remind me at 8 tonight to call mom” or “every weekday at 9 tell me my schedule”. " +
			"kind once fires one time at run_at, RFC 3339 with the offset of the current local time; daily and weekly fire at time (HH:MM) in timezone, the zone the current local time names, weekly on weekdays; every_n_hours repeats every interval_hours from now. " +
			"instruction is what it says or does, in the user's language: for a reminder, the reminder itself; with agent_does_it=true it wakes the Agent to do the work, so write the work to do. " +
			"When it fires it posts in this chat; there is no phone or desktop notification, so never promise one. " +
			"This is a write: first call without confirmed; it returns needs_confirmation with when and what: say that and ask. Only after the user says yes in their next turn, call again with the same arguments and confirmed=true. " +
			"invalid_schedule: a time is missing, past or malformed; ask or fix it. routine_limit or once_limit: too many routines here; offer to delete one.",
		Parameters: objectSchema([]string{"name", "instruction", "kind", "confirmed"}, map[string]any{
			"name":           stringProperty("Short name, one line"),
			"instruction":    stringProperty("What it says or does when it fires"),
			"kind":           map[string]any{"type": "string", "enum": []string{"once", "daily", "weekly", "every_n_hours"}, "description": "How often it fires"},
			"run_at":         stringProperty("once: RFC 3339 time with offset"),
			"time":           stringProperty("daily and weekly: local HH:MM"),
			"timezone":       stringProperty("daily and weekly: IANA zone of the current local time"),
			"weekdays":       map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": routineWeekdays}, "description": "weekly: the days"},
			"interval_hours": map[string]any{"type": "integer", "description": "every_n_hours: 1 to 168"},
			"agent_does_it":  map[string]any{"type": "boolean", "description": "Wake the Agent to do instruction, instead of posting it as a reminder"},
			"confirmed":      map[string]any{"type": "boolean", "description": "Whether the user said yes to it, in their own next turn"},
		}),
	},
	{
		Name: ToolChangeRoutine,
		Description: "Pause, resume, run now or delete a routine in this room, by the routine_id list_routines gave. " +
			"pause and resume take effect at once; run fires it once now and keeps its schedule. " +
			"delete cannot be undone: first call without confirmed, say which routine will be deleted and ask; only after the user says yes in their next turn call again with confirmed=true. " +
			"listener_routine means it watches a connected app and can only be paused or resumed. Then say what changed in a few words.",
		Parameters: objectSchema([]string{"routine_id", "action"}, map[string]any{
			"routine_id": stringProperty("From list_routines"),
			"action":     map[string]any{"type": "string", "enum": []string{"pause", "resume", "run", "delete"}, "description": "What to do"},
			"confirmed":  map[string]any{"type": "boolean", "description": "delete: whether the user said yes to it, in their own next turn"},
		}),
	},
}

var routineWeekdays = []string{"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}

// RoutineArguments holds the arguments of the routine tools.
type RoutineArguments struct {
	RoutineID     string    `json:"routine_id"`
	Action        string    `json:"action"`
	Name          string    `json:"name"`
	Instruction   string    `json:"instruction"`
	Kind          string    `json:"kind"`
	RunAt         string    `json:"run_at"`
	Time          string    `json:"time"`
	Timezone      string    `json:"timezone"`
	Weekdays      []string  `json:"weekdays"`
	IntervalHours int       `json:"interval_hours"`
	AgentDoesIt   LooseBool `json:"agent_does_it"`
	Confirmed     LooseBool `json:"confirmed"`
}

// RoutineCadence is the schedule the live model gave, validated by the rules
// the Agent's routine commands use; false when it is not one. A once time
// without an offset is read in timezone.
func RoutineCadence(args RoutineArguments) (reminder.Cadence, bool) {
	schedule := reminder.Schedule{Kind: strings.TrimSpace(args.Kind)}
	switch schedule.Kind {
	case "once":
		schedule.Timezone = strings.TrimSpace(args.Timezone)
		runAt, ok := routineRunAt(strings.TrimSpace(args.RunAt), schedule.Timezone)
		if !ok {
			return reminder.Cadence{}, false
		}
		schedule.RunAt = &runAt
	case "daily", "weekly":
		schedule.Time, schedule.Timezone = strings.TrimSpace(args.Time), strings.TrimSpace(args.Timezone)
		if schedule.Kind == "weekly" {
			schedule.Weekdays = args.Weekdays
		}
	case "every_n_hours":
		hours := args.IntervalHours
		schedule.IntervalHours = &hours
	}
	cadence, err := reminder.ParseSchedule(schedule)
	return cadence, err == nil
}

func routineRunAt(value, timezone string) (time.Time, bool) {
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed, true
	}
	location, err := time.LoadLocation(timezone)
	if timezone == "" || err != nil {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02T15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, value, location); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// RoutineWhen says when a Routine fires, for the model to read back.
func RoutineWhen(cadence reminder.Cadence) string {
	clock := func() string {
		if cadence.Hour == nil || cadence.Minute == nil {
			return ""
		}
		return fmt.Sprintf("%02d:%02d (%s)", *cadence.Hour, *cadence.Minute, cadence.Timezone)
	}
	switch cadence.Kind {
	case "once":
		if cadence.RunAt == nil {
			return "once"
		}
		at := cadence.RunAt.Local()
		if location, err := time.LoadLocation(cadence.Timezone); err == nil && cadence.Timezone != "UTC" {
			at = cadence.RunAt.In(location)
		}
		return "once at " + at.Format("2006-01-02 15:04 (MST)")
	case "daily":
		return "every day at " + clock()
	case "weekly":
		return "every " + strings.Join(cadence.Weekdays, ", ") + " at " + clock()
	case "every_n_hours":
		if cadence.IntervalHours != nil {
			return fmt.Sprintf("every %d hours", *cadence.IntervalHours)
		}
	}
	return cadence.Kind
}

// RoutineSummary is what the user confirms before a Routine is set up.
func RoutineSummary(name, instruction string, cadence reminder.Cadence, agentDoesIt bool) string {
	what := "post this reminder in this chat: "
	if agentDoesIt {
		what = "wake the Agent to do this: "
	}
	return "Will set up the routine “" + name + "”, " + RoutineWhen(cadence) + ", to " + what + Snippet(instruction)
}
