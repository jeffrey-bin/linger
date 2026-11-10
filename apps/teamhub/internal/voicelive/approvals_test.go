package voicelive

import (
	"strings"
	"testing"
)

func TestApprovalsSayWhatTheCardWouldDo(t *testing.T) {
	send := ApprovalFromView("decision_1", "connector_write", []byte(`{"kind":"message","app":"Slack","title":"Send a Slack message","account":"Lev8.com","tool":"SLACK_SEND_MESSAGE","input":"{}","message":{"destination":"D_SELF","body":"Warriors brief","format":"mrkdwn","attachments":["report.md"]}}`), 3)
	if send.ID != "decision_1" || send.Version != 3 || send.Title != "Send a Slack message · Slack · Lev8.com" || !strings.Contains(send.Detail, "D_SELF: Warriors brief") || !strings.Contains(send.Detail, "report.md") {
		t.Fatalf("connector write=%+v", send)
	}
	change := ApprovalFromView("decision_2", "connector_write", []byte(`{"kind":"change","app":"Slack","title":"Run SLACK_FIND_USERS","account":"Lev8.com","input":"{\"query\":\"tony\"}"}`), 1)
	if !strings.Contains(change.Detail, "tony") {
		t.Fatalf("change=%+v", change)
	}
	permission := ApprovalFromView("decision_3", "runtime_permission", []byte(`{"title":"Delete old logs","rationale":"Free disk space"}`), 1)
	if permission.Title != "Delete old logs" || permission.Detail != "Free disk space" {
		t.Fatalf("permission=%+v", permission)
	}
	agent := ApprovalFromView("decision_4", "agent_change", []byte(`{"action":"update","agent_name":"Weekly Report Helper","changes":[]}`), 1)
	if agent.Title != "update Agent Weekly Report Helper" {
		t.Fatalf("agent=%+v", agent)
	}
	if summary := ApprovalSummary("t2", send, "deny"); !strings.HasPrefix(summary, "Deny for task t2: Send a Slack message") {
		t.Fatalf("summary=%q", summary)
	}
}

func TestListTasksShowsWhatAWaitingTaskNeedsApproved(t *testing.T) {
	output := TaskListOutput([]TaskView{View(TaskRecord{
		Ordinal: 2, Goal: "Send the report to my Slack self-DM", Execution: "waiting_for_approval",
		Approvals: []Approval{{ID: "decision_1", Title: "Send a Slack message", Detail: "D_SELF: report", Version: 3}},
	})})
	task := output["tasks"].([]map[string]any)[0]
	approvals, _ := task["approvals"].([]map[string]string)
	if task["state"] != TaskWaitingForApproval || len(approvals) != 1 || approvals[0]["approval_id"] != "decision_1" || approvals[0]["detail"] != "D_SELF: report" {
		t.Fatalf("task=%v", task)
	}
}
