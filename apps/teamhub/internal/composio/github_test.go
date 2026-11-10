package composio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubUsesOfficialRESTAndKeepsMetadataWhenReadmeIsMissing(t *testing.T) {
	var requests []proxyRequest
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var proxy proxyRequest
		if err := json.NewDecoder(request.Body).Decode(&proxy); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, proxy)
		var status = http.StatusOK
		var data json.RawMessage
		switch proxy.Endpoint {
		case "/user":
			data = json.RawMessage(`{"id":42,"login":"alice","name":"Alice","bio":"Builder","location":"Shanghai","blog":"https://alice.example","html_url":"https://github.com/alice"}`)
		case "/user/repos":
			data = json.RawMessage(`[
				{"id":101,"name":"project","full_name":"alice/project","private":false,"fork":false,"archived":false,"html_url":"https://github.com/alice/project","description":"Public project","homepage":"https://project.example","language":"Go","topics":["agents"],"stargazers_count":7,"forks_count":2,"default_branch":"main","owner":{"id":42,"login":"alice"}},
				{"id":102,"name":"private","full_name":"alice/private","private":true,"fork":false,"archived":false,"owner":{"id":42,"login":"alice"}},
				{"id":103,"name":"fork","full_name":"alice/fork","private":false,"fork":true,"archived":false,"owner":{"id":42,"login":"alice"}},
				{"id":104,"name":"archived","full_name":"alice/archived","private":false,"fork":false,"archived":true,"owner":{"id":42,"login":"alice"}},
				{"id":105,"name":"collab","full_name":"other/collab","private":false,"fork":false,"archived":false,"owner":{"id":99,"login":"other"}}
			]`)
		case "/repos/alice/project/readme":
			status = http.StatusNotFound
			data = json.RawMessage(`{}`)
		default:
			t.Fatalf("unexpected endpoint %s", proxy.Endpoint)
		}
		_ = json.NewEncoder(response).Encode(proxyResponse{Status: status, Data: data})
	}))
	defer server.Close()

	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := client.IdentifyGitHub(context.Background(), "github-account")
	if err != nil || identity.UserID != "42" || identity.Login != "alice" {
		t.Fatalf("identity=%+v err=%v", identity, err)
	}
	page, err := client.ListGitHubRepositories(context.Background(), "github-account", identity, "", 100)
	if err != nil || len(page.Repositories) != 1 || page.Repositories[0].RepositoryID != "101" {
		t.Fatalf("repositories=%+v err=%v", page, err)
	}
	readme, err := client.GetGitHubReadme(context.Background(), "github-account", page.Repositories[0])
	if err != nil || readme != nil {
		t.Fatalf("readme=%+v err=%v", readme, err)
	}
	documents, err := RenderGitHubDocumentsWithLimits(identity, []GitHubRepositorySnapshot{{Repository: page.Repositories[0], Readme: readme}}, DefaultAppImportLimits())
	if err != nil || len(documents) != 2 || !strings.Contains(string(documents[1].Markdown), "README: unavailable") {
		t.Fatalf("documents=%+v err=%v", documents, err)
	}
	assertProxyParameter(t, requests, "/user/repos", "visibility", "public")
	assertProxyParameter(t, requests, "/user/repos", "affiliation", "owner")
}

func TestGitHubRepositoryPaginationUsesStablePageCursor(t *testing.T) {
	var requests []proxyRequest
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var proxy proxyRequest
		if err := json.NewDecoder(request.Body).Decode(&proxy); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, proxy)
		data := json.RawMessage(`[]`)
		if len(requests) == 1 {
			data = json.RawMessage(`[{
				"id":101,"name":"project","full_name":"alice/project","private":false,"fork":false,"archived":false,
				"html_url":"https://github.com/alice/project","default_branch":"main","owner":{"id":42,"login":"alice"}
			}]`)
		}
		_ = json.NewEncoder(response).Encode(proxyResponse{Status: http.StatusOK, Data: data})
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	identity := GitHubIdentity{UserID: "42", Login: "alice"}
	first, err := client.ListGitHubRepositories(context.Background(), "github-account", identity, "", 1)
	if err != nil || first.NextCursor != "2" || len(first.Repositories) != 1 {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	second, err := client.ListGitHubRepositories(context.Background(), "github-account", identity, first.NextCursor, 1)
	if err != nil || second.NextCursor != "" || len(second.Repositories) != 0 {
		t.Fatalf("second page=%+v err=%v", second, err)
	}
	assertProxyParameter(t, requests, "/user/repos", "page", "2")
}

func TestGitHubReadmeRejectsOversizeAndSurfacesRateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var proxy proxyRequest
		if err := json.NewDecoder(request.Body).Decode(&proxy); err != nil {
			t.Fatal(err)
		}
		result := proxyResponse{Status: http.StatusOK, Data: json.RawMessage(`{"path":"README.md","sha":"abc","encoding":"base64","content":"aGVsbG8=","size":5}`)}
		if proxy.ConnectedAccountID == "rate-limited" {
			result = proxyResponse{Status: http.StatusTooManyRequests, Headers: map[string]string{"retry-after": "1"}, Data: json.RawMessage(`{}`)}
		}
		_ = json.NewEncoder(response).Encode(result)
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1, MaxThreadBytes: 4})
	if err != nil {
		t.Fatal(err)
	}
	repository := GitHubRepository{OwnerLogin: "alice", Name: "project", DefaultBranch: "main"}
	if _, err = client.GetGitHubReadme(context.Background(), "github-account", repository); err == nil {
		t.Fatal("oversize README must fail")
	}
	var rateLimit *RateLimitError
	if _, err = client.GetGitHubReadme(context.Background(), "rate-limited", repository); !errors.As(err, &rateLimit) {
		t.Fatalf("rate limit error=%v", err)
	}
}
