package integration_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// retryingTransientSlackProvider rate-limits its first document fetch.
type retryingTransientSlackProvider struct {
	fakeSlackProvider
	retryMu    sync.Mutex
	fetchCalls int
}

type boundedTransientGitHubProvider struct {
	// Provider panics on the apps this fake does not serve.
	externalsource.Provider
	mu          sync.Mutex
	listCalls   int
	readmeCalls int
}

func (*boundedTransientGitHubProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}

func (*boundedTransientGitHubProvider) IdentifyGitHub(context.Context, string) (composio.GitHubIdentity, error) {
	return composio.GitHubIdentity{UserID: "github-user", Login: "alice"}, nil
}

func (p *boundedTransientGitHubProvider) ListGitHubRepositories(context.Context, string, composio.GitHubIdentity, string, int) (composio.GitHubRepositoryPage, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.listCalls++
	return composio.GitHubRepositoryPage{Repositories: []composio.GitHubRepository{{RepositoryID: "repo-selected", FullName: "alice/selected", OwnerID: "github-user"}}, NextCursor: "unneeded-next-page"}, nil
}

func (p *boundedTransientGitHubProvider) GetGitHubReadme(context.Context, string, composio.GitHubRepository) (*composio.GitHubReadme, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.readmeCalls++
	return &composio.GitHubReadme{Content: []byte("# Selected")}, nil
}

func (p *boundedTransientGitHubProvider) Calls() (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.listCalls, p.readmeCalls
}

func (p *retryingTransientSlackProvider) FetchSlackDocuments(context.Context, string, composio.SlackIdentity, []composio.SlackConversation, composio.SlackImportOptions) ([]composio.SlackDocument, int, error) {
	p.retryMu.Lock()
	defer p.retryMu.Unlock()
	p.fetchCalls++
	if p.fetchCalls == 1 {
		return nil, 1, &composio.RateLimitError{Operation: "fetch Slack documents", RetryAfter: 10 * time.Millisecond}
	}
	return []composio.SlackDocument{{RemoteID: "C1", Filename: "slack-retry.md", Markdown: []byte("retry source body")}}, 1, nil
}

func TestTransientImportRefetchesWithoutPersistingContent(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountID := aliceAccountID(t, ctx, pool)
	seedExternalConnection(t, ctx, pool, "connection_transient_retry", accountID, "slack", "active")
	slack := &retryingTransientSlackProvider{fakeSlackProvider: fakeSlackProvider{status: composio.ConnectionActive}}
	service := newFakeComposio(t).externalSources(t, pool, slack)
	request := externalsource.SlackImportRequest{ConversationIDs: []string{"C1"}, Days: 7, MaxMessagesPerConversation: 10}
	first, err := service.ImportSlack(ctx, accountID, "tenant_acme", "connection_transient_retry", request, 30)
	if err != nil || first.Status != "retry_wait" || len(first.Documents) != 0 {
		t.Fatalf("first transient result=%+v err=%v", first, err)
	}
	time.Sleep(20 * time.Millisecond)
	second, err := service.ImportSlack(ctx, accountID, "tenant_acme", "connection_transient_retry", request, 30)
	if err != nil || second.Status != "completed" || len(second.Documents) != 1 || string(second.Documents[0].Markdown) != "retry source body" {
		t.Fatalf("second transient result=%+v err=%v", second, err)
	}
	// Each run refetches; nothing of the first run is stored.
	slack.retryMu.Lock()
	defer slack.retryMu.Unlock()
	if slack.fetchCalls != 2 {
		t.Fatalf("fetch calls=%d", slack.fetchCalls)
	}
}

func TestTransientGitHubImportStopsAfterSelectionsAreFound(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountID := aliceAccountID(t, ctx, pool)
	seedExternalConnection(t, ctx, pool, "connection_transient_github", accountID, "github", "active")
	if _, err = pool.Exec(ctx, `UPDATE external_connections SET remote_principal_key='github:github-user' WHERE id='connection_transient_github'`); err != nil {
		t.Fatal(err)
	}
	provider := &boundedTransientGitHubProvider{}
	service := newFakeComposio(t).externalSources(t, pool, provider)
	result, err := service.ImportGitHub(ctx, accountID, "tenant_acme", "connection_transient_github", externalsource.GitHubImportRequest{Repositories: []externalsource.GitHubRepositorySelection{{RepositoryID: "repo-selected", FullName: "alice/selected"}}}, 100)
	if err != nil || result.Status != "completed" || len(result.Documents) != 2 {
		t.Fatalf("selected result=%+v err=%v", result, err)
	}
	result, err = service.ImportGitHub(ctx, accountID, "tenant_acme", "connection_transient_github", externalsource.GitHubImportRequest{}, 100)
	listCalls, readmeCalls := provider.Calls()
	if err != nil || result.Status != "completed" || len(result.Documents) != 1 || listCalls != 1 || readmeCalls != 1 {
		t.Fatalf("profile result=%+v list_calls=%d readme_calls=%d err=%v", result, listCalls, readmeCalls, err)
	}
}
