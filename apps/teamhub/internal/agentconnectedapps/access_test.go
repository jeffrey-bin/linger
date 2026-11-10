package agentconnectedapps

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
)

// recordingProvider serves one tool and records every execution.
type recordingProvider struct {
	fakeToolProvider
	tool     composio.Tool
	executed []string
}

func (provider *recordingProvider) GetTool(context.Context, string, string) (composio.Tool, error) {
	return provider.tool, nil
}

func (provider *recordingProvider) ExecuteTool(_ context.Context, _, _, slug, _ string, _ map[string]any) (composio.ToolExecution, error) {
	provider.executed = append(provider.executed, slug)
	return composio.ToolExecution{Successful: true, Data: map[string]any{"id": "sent"}}, nil
}

func executeForTest(t *testing.T, slug, toolkit string, arguments map[string]any) (*recordingProvider, Result, error) {
	t.Helper()
	provider := &recordingProvider{tool: tool(slug, toolkit)}
	connection := externalsource.AgentToolConnection{
		ID: "connection-1", AppKey: toolkit, ToolkitSlug: toolkit, DisplayName: "Work",
		IdentityLabel: "alice@example.test", UpstreamConnectionID: "ca-1", UserID: "owner",
	}
	result, err := (&Service{provider: provider}).execute(t.Context(), ExecuteInput{
		ConnectionID: connection.ID, ToolSlug: slug, ToolVersion: provider.tool.Version, Arguments: arguments,
	}, func(context.Context) (externalsource.AgentToolConnection, error) { return connection, nil })
	return provider, result, err
}

// The host hook judges `teamhub apps execute` before the call reaches
// TeamHub. With the permission reviewer configured (as in .env.example) its
// model may allow a send; without one the hook allows every call. In both
// configurations the generic execute used to send the mail at once, without
// the card `teamhub gmail send` needs, so Execute must hold it either way.
func TestExecuteHoldsAGenericSendWhateverTheHostReviewerAllowed(t *testing.T) {
	configurations := map[string]func() (permissionreview.Outcome, error){
		// A stand-in for the judge model's verdict; the real review needs a
		// live Context in the database.
		"reviewer allows": func() (permissionreview.Outcome, error) {
			return permissionreview.Outcome{Decision: permissionreview.DecisionAllow}, nil
		},
		"no reviewer": func() (permissionreview.Outcome, error) {
			return (&permissionreview.Service{}).Review(t.Context(), permissionreview.ReviewInput{
				Action: permissionreview.Action{Tool: "Bash", Command: "teamhub apps execute --toolSlug GMAIL_SEND_EMAIL"},
			})
		},
	}
	for name, review := range configurations {
		outcome, err := review()
		if err != nil || outcome.Decision != permissionreview.DecisionAllow {
			t.Fatalf("%s: host review=%+v err=%v", name, outcome, err)
		}
		provider, held, err := executeForTest(t, "GMAIL_SEND_EMAIL", "gmail", map[string]any{
			"recipient_email": "bob@example.test", "subject": "Hi", "body": "Hello",
		})
		if err != nil || held.Confirmation == nil || len(provider.executed) != 0 {
			t.Fatalf("%s: GMAIL_SEND_EMAIL ran without confirmation: result=%+v err=%v executed=%v", name, held, err, provider.executed)
		}
	}
}

func TestExecuteHoldsAWriteForTheSponsorsCard(t *testing.T) {
	provider, held, err := executeForTest(t, "GMAIL_SEND_EMAIL", "gmail", map[string]any{
		"recipient_email": "bob@example.test", "subject": "Hi", "body": "Hello",
	})
	if err != nil || held.Confirmation == nil || held.Data != nil {
		t.Fatalf("result=%+v err=%v", held, err)
	}
	if card := held.Confirmation.Card; card.Title != "Send an email to bob@example.test" || card.Account != "alice@example.test" ||
		card.Message == nil || card.Message.Subject != "Hi" {
		t.Fatalf("card=%+v", card)
	}
	if held.Confirmation.Connection.ID != "connection-1" || len(held.Confirmation.Action) == 0 || held.Confirmation.Digest == "" {
		t.Fatalf("confirmation=%+v", held.Confirmation)
	}
	if len(provider.executed) != 0 {
		t.Fatalf("executed=%v", provider.executed)
	}
}

func TestExecuteRunsReadsAndDirectWritesAtOnce(t *testing.T) {
	for _, slug := range []string{"GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"} {
		provider, ran, err := executeForTest(t, slug, "gmail", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 || provider.executed[0] != slug {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
		if data, _ := ran.Data.(map[string]any); data["id"] != "sent" {
			t.Fatalf("%s: data=%+v", slug, ran.Data)
		}
	}
}

// Finding recent direct messages has no wrapped command; the generic execute
// lists them without a card for each read.
func TestExecuteRunsSlackDirectMessageReadsAtOnce(t *testing.T) {
	for _, slug := range []string{
		"SLACK_LIST_CONVERSATIONS", "SLACK_LIST_ALL_USERS", "SLACK_FIND_USERS",
		"SLACK_GET_UNREAD_MESSAGES_FROM_USER", "SLACK_LIST_UNREAD_CHANNEL_MESSAGES",
	} {
		provider, ran, err := executeForTest(t, slug, "slack", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
}

func TestExecuteHoldsAToolTeamHubDoesNotKnow(t *testing.T) {
	provider, held, err := executeForTest(t, "GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER", "github", map[string]any{"owner": "acme", "repo": "api"})
	if err != nil || held.Confirmation == nil || len(provider.executed) != 0 {
		t.Fatalf("result=%+v err=%v executed=%v", held, err, provider.executed)
	}
	if card := held.Confirmation.Card; card.Title != "Run GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER" || card.Kind != "change" || card.Input == "" {
		t.Fatalf("card=%+v", card)
	}
}

// The reads `teamhub github` makes run at once; before they were listed, a
// profile Task reading the delegated account got a card for every read.
func TestExecuteRunsGitHubReadsAtOnce(t *testing.T) {
	for _, slug := range []string{
		"GITHUB_GET_THE_AUTHENTICATED_USER", "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
		"GITHUB_GET_A_REPOSITORY", "GITHUB_GET_A_REPOSITORY_README", "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
		"GITHUB_GET_AN_ISSUE", "GITHUB_LIST_ISSUE_COMMENTS", "GITHUB_GET_A_PULL_REQUEST", "GITHUB_LIST_PULL_REQUESTS_FILES",
	} {
		provider, ran, err := executeForTest(t, slug, "github", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
}

// cardTools are the final writes of the CLI's "confirm" commands. The
// generic execute and the wrapped commands must both hold them.
var cardTools = []string{
	"GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "GMAIL_REPLY_TO_THREAD",
	"OUTLOOK_SEND_EMAIL", "OUTLOOK_SEND_DRAFT",
	"SLACK_SEND_MESSAGE", "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
	"NOTION_CREATE_NOTION_PAGE", "NOTION_ADD_MULTIPLE_PAGE_CONTENT", "NOTION_UPDATE_PAGE_MARKDOWN",
	"GITHUB_CREATE_AN_ISSUE", "GITHUB_CREATE_AN_ISSUE_COMMENT",
}

func TestAccessListsKeepConfirmedWritesHeld(t *testing.T) {
	for _, slug := range cardTools {
		if accessOf(slug) != accessConfirm {
			t.Errorf("%s must wait for confirmation", slug)
		}
	}
	for slug := range readTools {
		if directWriteTools[slug] {
			t.Errorf("%s is both a read and a direct write", slug)
		}
	}
	for _, slug := range []string{"GMAIL_GET_DRAFT", "OUTLOOK_GET_MESSAGE", "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS"} {
		if accessOf(slug) != accessRead {
			t.Errorf("%s reads a draft for its card and must run at once", slug)
		}
	}
}

func TestExecuteRefusesAnUnknownCallTooLargeForItsCard(t *testing.T) {
	provider, held, err := executeForTest(t, "GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER", "github", map[string]any{"repo": strings.Repeat("x", maxCardInput)})
	var domain *Error
	if !errors.As(err, &domain) || domain.Code != "invalid_input" || held.Confirmation != nil || len(provider.executed) != 0 {
		t.Fatalf("result=%+v err=%v executed=%v", held, err, provider.executed)
	}
}
