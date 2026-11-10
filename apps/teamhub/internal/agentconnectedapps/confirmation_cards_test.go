package agentconnectedapps

import (
	"encoding/base64"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

func TestDescribeConfirmationBuildsCardFromTheCall(t *testing.T) {
	connection := externalsource.AgentToolConnection{AppKey: "slack", IdentityLabel: "Acme"}
	card := describeConfirmation(connection, confirmationAction{ToolSlug: "SLACK_SEND_MESSAGE", Arguments: map[string]any{
		"channel": "C123", "markdown_text": "**Ship it**", "thread_ts": "1700.1",
	}})
	if card.Kind != "message" || card.Title != "Send a Slack message" || card.Message.Format != "markdown" ||
		card.Message.Body != "**Ship it**" ||
		card.Message.Destination != "Slack C123, thread 1700.1" || card.Account != "Acme" {
		t.Fatalf("slack card %+v message %+v", card, card.Message)
	}

	github := externalsource.AgentToolConnection{AppKey: "github", IdentityLabel: "@alice"}
	card = describeConfirmation(github, confirmationAction{ToolSlug: "GITHUB_CREATE_AN_ISSUE_COMMENT", Arguments: map[string]any{
		"owner": "acme", "repo": "api", "issue_number": float64(42), "body": "Looks good",
	}})
	if card.Kind != "message" || card.Title != "Comment on acme/api#42" || card.Message.Destination != "GitHub acme/api#42" ||
		card.Message.Body != "Looks good" || card.Message.Format != "markdown" {
		t.Fatalf("github comment card %+v message %+v", card, card.Message)
	}
	card = describeConfirmation(github, confirmationAction{ToolSlug: "GITHUB_CREATE_AN_ISSUE", Arguments: map[string]any{
		"owner": "acme", "repo": "api", "title": "Login fails", "body": "Steps",
	}})
	if card.Kind != "message" || card.Title != "Create an issue in acme/api" || card.Message.Subject != "Login fails" ||
		card.Message.Destination != "GitHub acme/api" || card.Message.Body != "Steps" {
		t.Fatalf("github issue card %+v message %+v", card, card.Message)
	}
}

func TestGmailDraftMessagePrefersHTMLAndListsAttachments(t *testing.T) {
	encode := func(text string) string { return base64.RawURLEncoding.EncodeToString([]byte(text)) }
	message, err := gmailDraftMessage(map[string]any{"payload": map[string]any{
		"mimeType": "multipart/mixed",
		"headers": []any{
			map[string]any{"name": "To", "value": "Bob <bob@example.test>, carol@example.test"},
			map[string]any{"name": "Subject", "value": "Plan"},
		},
		"parts": []any{
			map[string]any{"mimeType": "text/plain", "body": map[string]any{"data": encode("Hello")}},
			map[string]any{"mimeType": "text/html", "body": map[string]any{"data": encode("<p>Hello</p>")}},
			map[string]any{"mimeType": "application/pdf", "filename": "plan.pdf", "body": map[string]any{"attachmentId": "a1"}},
		},
	}})
	if err != nil || message.Body != "<p>Hello</p>" || message.Format != "html" || len(message.To) != 2 ||
		message.Subject != "Plan" || len(message.Attachments) != 1 || message.Attachments[0] != "plan.pdf" {
		t.Fatalf("draft %+v err=%v", message, err)
	}
}
