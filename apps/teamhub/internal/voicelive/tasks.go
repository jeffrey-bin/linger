package voicelive

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Task tools start and steer the Room Agent's work. Each task is its own
// delegated Task and the live voice is its coordinator during the
// call, as a Meta is: the Task only works and reports when its turn ends; the
// live voice reads the report, talks with the user and passes their answer
// back. The Human's spoken turns stay the Human's own words in the Room.
const (
	ToolStartTask   = "start_task"
	ToolReplyToTask = "reply_to_task"
	ToolCancelTask  = "cancel_task"
	ToolListTasks   = "list_tasks"
)

// Surfaces say where the Agent works.
const (
	SurfaceWorkspace = "workspace"
	SurfaceWeb       = "web"
	SurfaceDesktop   = "desktop"
	SurfaceApps      = "apps"
)

// Surfaces lists supported execution surfaces for delegated tasks.
var Surfaces = []string{SurfaceWorkspace, SurfaceWeb, SurfaceDesktop, SurfaceApps}

// Task states reported to Voice Runtime and the live model. A reported task
// ended its turn with a report: a result, or what it needs from the user.
const (
	TaskPending            = "pending"
	TaskWorking            = "working"
	TaskWaitingForApproval = "waiting_for_approval"
	TaskReported           = "reported"
	TaskFailed             = "failed"
	TaskCanceled           = "canceled"
)

// MaxTaskGoalRunes bounds the full request passed to a delegated task.
const MaxTaskGoalRunes = 4000

// StartTaskArguments holds a delegated request and any confirmation receipt.
type StartTaskArguments struct {
	Goal         string `json:"goal"`
	Surface      string `json:"surface"`
	Irreversible bool   `json:"irreversible"`
	// ConfirmationID names the needs_confirmation the user said yes to.
	ConfirmationID string `json:"confirmation_id"`
}

// ReplyToTaskArguments passes a user answer to an existing task.
type ReplyToTaskArguments struct {
	TaskID  string `json:"task_id"`
	Details string `json:"details"`
}

// CancelTaskArguments identifies the task the user wants to stop.
type CancelTaskArguments struct {
	TaskID string `json:"task_id"`
}

var taskIDPattern = regexp.MustCompile(`^t([1-9][0-9]{0,5})$`)

// TaskID is the short handle the live model uses for a task.
func TaskID(ordinal int32) string { return "t" + strconv.Itoa(int(ordinal)) }

// TaskOrdinal parses a task handle; false when it is not one.
func TaskOrdinal(id string) (int32, bool) {
	match := taskIDPattern.FindStringSubmatch(strings.TrimSpace(id))
	if match == nil {
		return 0, false
	}
	ordinal, err := strconv.ParseInt(match[1], 10, 32)
	return int32(ordinal), err == nil
}

var taskTools = []Tool{
	{
		Name: ToolStartTask,
		Description: "Start a piece of work that takes time or happens outside this call, and keep talking while it runs; the result is told to the user in your voice when it is done. " +
			"Use it to produce something (documents, reports, drafts), for research, for several steps in a row, and for anything on the web, the user's computer or their apps. " +
			"surface: web for websites and anything in a browser such as Chrome (search a site, order, fill a form, a company OA, GitHub, a site the user is logged in to); " +
			"desktop for apps and files on their computer (WeChat, the Feishu app, Excel, Downloads, a window on their screen); " +
			"apps for writing in their connected email or calendar (replying, booking or changing events), not for looking things up there; workspace for everything else inside this product. " +
			"goal is the full request in the user's language with every detail they gave, also earlier in the call; never add details they did not give (a city, dates, a budget, a recipient). " +
			"Work that itself sends, posts or deletes in the user's name, or pays with everything already decided, cannot be undone: set irreversible, and the call returns needs_confirmation with a confirmation_id. Restate exactly what and to whom (ask what is missing); only after the user says yes, call again with that confirmation_id, which does exactly what was confirmed. Being told beforehand to just do it does not count. " +
			"Searching, comparing, adding to a cart, or booking or buying that stops before paying are not irreversible: start them right away. " +
			"Several separate pieces of work are several calls. As you start it, confirm it like a person in one natural sentence that repeats the key details the user gave, never a clipped fragment, never that you cannot do it, and never mention an Agent, a backend or handing off. " +
			"no_computer or computer_offline means the user's computer is not connected: say so plainly and suggest connecting it. too_many_tasks: several tasks still run; offer to wait or stop one.",
		Parameters: objectSchema([]string{"goal", "surface", "irreversible"}, map[string]any{
			"goal":            stringProperty("The full request, with every detail needed"),
			"surface":         map[string]any{"type": "string", "enum": Surfaces, "description": "Where the work happens"},
			"irreversible":    map[string]any{"type": "boolean", "description": "Whether the work itself sends, posts or deletes something in the user's name, or pays without stopping to ask"},
			"confirmation_id": stringProperty("Only when confirming: the confirmation_id of the needs_confirmation the user just said yes to"),
		}),
	},
	{
		Name: ToolReplyToTask,
		Description: "Pass what the user just said to one of their tasks: an answer to what its report asked (such as having scanned a login code, a choice, a number), a confirmation, more detail, or a change of plan. " +
			"task_id comes from start_task or list_tasks. details restates in full what the user answered or changed. Say one short line; the task continues and its next report is told when it comes.",
		Parameters: objectSchema([]string{"task_id", "details"}, map[string]any{
			"task_id": stringProperty("The task, such as t1"),
			"details": stringProperty("What the user answered or changed, in full"),
		}),
	},
	{
		Name: ToolCancelTask,
		Description: "Stop a task the user no longer wants. Call it only when the user clearly says to stop or drop that work; the user talking over you or changing the subject never cancels anything. " +
			"Work already done, such as a message already sent, is not undone; say so if the result tells you.",
		Parameters: objectSchema([]string{"task_id"}, map[string]any{
			"task_id": stringProperty("The task, such as t1"),
		}),
	},
	{
		Name: ToolListTasks,
		Description: "See the user's tasks in this room: those of this call, and earlier ones still working or reported within the last day. Each task's goal, state (pending, working, waiting_for_approval, reported with its latest report, which may be a result or something it needs from the user, failed, canceled) and the latest steps. When asked how things are going, give the state of every task, canceled and finished ones included. Only pending and working mean something is being done right now; never say a task is still doing something in any other state. " +
			"Call it when the user asks how far along something is, whether it is done or what is being worked on, and to find a task_id; never answer progress from impression. " +
			"scope=room instead reports every Agent still working in this room, the last ones that finished and background Tasks; for another room, get its room_id with find_rooms and pass it. " +
			"The work is yours to the user: speak of it in the first person, picking the one or two lines that matter.",
		Parameters: objectSchema([]string{}, map[string]any{
			"scope": map[string]any{
				"type": "string", "enum": []string{ProgressScopeMyRequests, ProgressScopeRoom},
				"description": "Optional, defaults to my_requests: the user's tasks",
			},
			"room_id": stringProperty("Optional ID of another room to check, from find_rooms"),
		}),
	},
}

// RecentTasksSince is how far back list_tasks shows tasks that reported.
const RecentTasksSince = 24 * time.Hour

// RepeatedTaskWithin is how soon the same goal handed off again counts as
// the same task.
const RepeatedTaskWithin = 10 * time.Second

// ConfirmationValidFor is how long a needs_confirmation can be confirmed.
const ConfirmationValidFor = 10 * time.Minute

// TaskRecord is one voice task with the state of its delegated Task.
type TaskRecord struct {
	Ordinal int32
	// StartedHere is set for tasks this call started.
	StartedHere bool
	Goal        string
	Surface     string
	Canceled    bool
	// Execution is the Task's execution status (running,
	// waiting_for_approval, idle, failed, canceled).
	Execution string
	// Report is the Task's latest report to its coordinator, if any.
	Report *TaskReport
	// Steps are the latest step titles of the Run working on it now, and
	// RunningFor how long that Run has been at it.
	Steps      []string
	RunningFor string
	// Approvals are the cards it waits on that the user answers.
	Approvals []Approval
}

// TaskReport is one report a Task's turn ended with.
type TaskReport struct {
	ID, Body  string
	Delivered bool
}

// TaskView is what Voice Runtime and the live model learn about one task.
type TaskView struct {
	Ordinal     int32
	StartedHere bool
	Goal        string
	Surface     string
	State       string
	Report      *TaskReport
	Steps       []string
	RunningFor  string
	Approvals   []Approval
}

// View reports one task in the terms of its delegated Task.
func View(record TaskRecord) TaskView {
	view := TaskView{
		Ordinal: record.Ordinal, StartedHere: record.StartedHere, Goal: record.Goal, Surface: record.Surface,
		Report: record.Report, Steps: record.Steps, RunningFor: record.RunningFor, Approvals: record.Approvals,
	}
	switch {
	case record.Canceled || record.Execution == "canceled":
		view.State = TaskCanceled
	case record.Execution == "running":
		view.State = TaskWorking
	case record.Execution == "waiting_for_approval":
		view.State = TaskWaitingForApproval
	case record.Execution == "failed":
		view.State = TaskFailed
	case record.Execution == "idle" && record.Report != nil:
		view.State = TaskReported
	default:
		view.State = TaskPending
	}
	return view
}

// TaskListOutput is what list_tasks returns to the live model.
func TaskListOutput(views []TaskView) map[string]any {
	tasks := make([]map[string]any, 0, len(views))
	for _, view := range views {
		task := map[string]any{"task_id": TaskID(view.Ordinal), "goal": truncateRunes(view.Goal, 200), "state": view.State}
		if len(view.Steps) > 0 {
			task["recent_steps"] = view.Steps
		}
		if view.State == TaskWorking && view.RunningFor != "" {
			task["running_for"] = view.RunningFor
		}
		if view.Report != nil {
			task["latest_report"] = Snippet(view.Report.Body)
			task["report_id"] = view.Report.ID
			task["delivered"] = view.Report.Delivered
		}
		if len(view.Approvals) > 0 {
			approvals := make([]map[string]string, 0, len(view.Approvals))
			for _, approval := range view.Approvals {
				approvals = append(approvals, map[string]string{"approval_id": approval.ID, "title": approval.Title, "detail": approval.Detail})
			}
			task["approvals"] = approvals
		}
		tasks = append(tasks, task)
	}
	return map[string]any{"tasks": tasks}
}

var surfaceHints = map[string]string{
	SurfaceWorkspace: "Do it in the workspace (documents, tasks, messages, research).",
	SurfaceWeb:       "It needs websites.",
	SurfaceDesktop:   "It needs desktop apps or local files on the user's computer (such as WeChat, the Feishu app, Excel, the Downloads folder, a window on their screen).",
	SurfaceApps:      "It needs the user's connected apps (email, calendar, Slack and so on).",
}

// TaskRequirement is the brief of the Task one voice task starts.
func TaskRequirement(goal, surface string) string {
	return goal + "\n\n---\nHow: " + surfaceHints[surface] + " Choose your own tools.\n" +
		"The user asked for this by voice. Write your report in the user's language."
}

// TaskAnswer is what the user said about a task, given to its Task at any
// time: an answer to what it waits for, more detail, or a change of plan.
func TaskAnswer(details string) string {
	return "The user said this about your task by voice; take it into account and go on: " + details
}
