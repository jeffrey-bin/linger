package voicelive

import (
	"encoding/json"
	"strings"
)

// ToolDecideApproval answers an approval card one of the user's tasks waits
// on, in their name, after they said yes to exactly that answer. It is the
// spoken counterpart of the card's Approve and Deny buttons.
const ToolDecideApproval = "decide_approval"

var approvalTool = Tool{
	Name: ToolDecideApproval,
	Description: "Approve or deny, in the user's name, an approval card one of their tasks waits on: the spoken Approve and Deny buttons. " +
		"list_tasks lists each waiting task's approvals with approval_id, title and detail; tell the user what it would do and ask. " +
		"Answering cannot be undone: first call without confirmed; it returns needs_confirmation with what the answer does: say it and ask. Only after the user says yes in their own next turn, call again with the same arguments and confirmed=true. " +
		"Being told beforehand to approve everything does not count. approval_not_found means it was already answered or expired; approval_changed means the card changed: list_tasks again and ask again.",
	Parameters: objectSchema([]string{"approval_id", "decision", "confirmed"}, map[string]any{
		"approval_id": stringProperty("The approval, from list_tasks"),
		"decision":    map[string]any{"type": "string", "enum": []string{"approve", "deny"}},
		"comment":     stringProperty("Optional reason told to the task, for deny"),
		"confirmed":   map[string]any{"type": "boolean", "description": "Whether the user said yes to this answer, in their own next turn"},
	}),
}

// ApprovalArguments answers one approval card.
type ApprovalArguments struct {
	ApprovalID string    `json:"approval_id"`
	Decision   string    `json:"decision"`
	Comment    string    `json:"comment"`
	Confirmed  LooseBool `json:"confirmed"`
}

// Approval is one card a task waits on, in the words the user hears.
type Approval struct {
	ID, Title, Detail string
	// Version is the card version an answer names.
	Version int64
}

// ApprovalFromView reads what a card shows: its title and what it would do.
func ApprovalFromView(id, kind string, view []byte, version int64) Approval {
	approval := Approval{ID: id, Version: version}
	var card struct {
		Title     string `json:"title"`
		App       string `json:"app"`
		Account   string `json:"account"`
		Input     string `json:"input"`
		Rationale string `json:"rationale"`
		Message   *struct {
			To          []string `json:"to"`
			Destination string   `json:"destination"`
			Subject     string   `json:"subject"`
			Body        string   `json:"body"`
			Attachments []string `json:"attachments"`
		} `json:"message"`
		Action    string `json:"action"`
		AgentName string `json:"agent_name"`
	}
	if json.Unmarshal(view, &card) != nil {
		return approval
	}
	switch kind {
	case "connector_write":
		approval.Title = strings.TrimSpace(strings.Join(nonEmpty(card.Title, card.App, card.Account), " · "))
		if message := card.Message; message != nil {
			to := message.Destination
			if to == "" {
				to = strings.Join(message.To, ", ")
			}
			detail := strings.Join(nonEmpty(to, message.Subject, message.Body), ": ")
			if len(message.Attachments) > 0 {
				detail += " (attachments: " + strings.Join(message.Attachments, ", ") + ")"
			}
			approval.Detail = Snippet(detail)
		} else {
			approval.Detail = Snippet(card.Input)
		}
	case "runtime_permission":
		approval.Title, approval.Detail = card.Title, Snippet(card.Rationale)
	case "agent_change":
		approval.Title = strings.TrimSpace(card.Action + " Agent " + card.AgentName)
	}
	return approval
}

// ApprovalSummary is what the user says yes to before an answer is given.
func ApprovalSummary(taskID string, approval Approval, decision string) string {
	verb := "Approve"
	if decision == "deny" {
		verb = "Deny"
	}
	summary := verb + " for task " + taskID + ": " + approval.Title
	if approval.Detail != "" {
		summary += " — " + approval.Detail
	}
	return summary + "."
}

func nonEmpty(values ...string) []string {
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			kept = append(kept, value)
		}
	}
	return kept
}
