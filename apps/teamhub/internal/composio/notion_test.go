package composio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNotionListsSharedResourcesAndRendersPageWithoutChildPages(t *testing.T) {
	var requests []proxyRequest
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var proxy proxyRequest
		if err := json.NewDecoder(request.Body).Decode(&proxy); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, proxy)
		var data json.RawMessage
		switch proxy.Endpoint {
		case "/v1/users/me":
			data = json.RawMessage(`{"object":"user","id":"bot-11111111-1111-1111-1111-111111111111","name":"Linger","type":"bot","bot":{"workspace_name":"Acme Labs"}}`)
		case "/v1/search":
			data = json.RawMessage(`{"object":"list","results":[
				{"object":"page","id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","url":"https://www.notion.so/About-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","properties":{"title":{"type":"title","title":[{"plain_text":"About me"}]}}},
				{"object":"database","id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","url":"https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","title":[{"plain_text":"Projects"}]}
			],"has_more":false}`)
		case "/v1/blocks/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/children":
			data = json.RawMessage(`{"object":"list","results":[
				{"object":"block","id":"p1","type":"paragraph","has_children":false,"paragraph":{"rich_text":[{"plain_text":"I build agents."}]}},
				{"object":"block","id":"child1","type":"child_page","has_children":true,"child_page":{"title":"Secret child"}}
			],"has_more":false}`)
		default:
			t.Fatalf("unexpected endpoint %s", proxy.Endpoint)
		}
		_ = json.NewEncoder(response).Encode(proxyResponse{Status: http.StatusOK, Data: data})
	}))
	defer server.Close()

	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := client.IdentifyNotion(context.Background(), "notion-account")
	if err != nil || identity.BotID != "bot-11111111-1111-1111-1111-111111111111" || identity.WorkspaceName != "Acme Labs" {
		t.Fatalf("identity=%+v err=%v", identity, err)
	}
	page, err := client.ListNotionResources(context.Background(), "notion-account", "", 50)
	if err != nil || len(page.Resources) != 2 || page.Resources[0].Kind != "notion_page" || page.Resources[1].Kind != "notion_database" {
		t.Fatalf("resources=%+v err=%v", page, err)
	}
	snapshot, err := client.GetNotionPage(context.Background(), "notion-account", page.Resources[0])
	if err != nil || snapshot.Title != "About me" || !strings.Contains(snapshot.Markdown, "I build agents.") || strings.Contains(snapshot.Markdown, "Secret child") {
		t.Fatalf("page=%+v err=%v", snapshot, err)
	}
	documents, err := RenderNotionDocumentsWithLimits(identity, []NotionSnapshot{snapshot}, DefaultAppImportLimits())
	if err != nil || len(documents) != 1 || !strings.Contains(string(documents[0].Markdown), "Provenance: notion_page") {
		t.Fatalf("documents=%+v err=%v", documents, err)
	}
	if !notionProxySendsVersion(requests, "/v1/search") || !notionProxySendsVersion(requests, "/v1/users/me") {
		t.Fatalf("Notion-Version missing: %+v", requests)
	}
}

func TestNotionRendersSelectedDatabaseRows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var proxy proxyRequest
		if err := json.NewDecoder(request.Body).Decode(&proxy); err != nil {
			t.Fatal(err)
		}
		var data json.RawMessage
		switch proxy.Endpoint {
		case "/v1/databases/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/query":
			data = json.RawMessage(`{"results":[{"id":"row1","properties":{"Name":{"type":"title","title":[{"plain_text":"Linger"}]},"Role":{"type":"rich_text","rich_text":[{"plain_text":"Founder"}]}}}],"has_more":false}`)
		default:
			t.Fatalf("unexpected endpoint %s", proxy.Endpoint)
		}
		_ = json.NewEncoder(response).Encode(proxyResponse{Status: http.StatusOK, Data: data})
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	resource := NotionResource{ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", Title: "Projects", Kind: "notion_database", URL: "https://www.notion.so/projects"}
	snapshot, err := client.GetNotionDatabase(context.Background(), "notion-account", resource)
	if err != nil || !strings.Contains(snapshot.Markdown, "Linger") || !strings.Contains(snapshot.Markdown, "Founder") {
		t.Fatalf("database=%+v err=%v", snapshot, err)
	}
	documents, err := RenderNotionDocumentsWithLimits(NotionIdentity{BotID: "bot-1", WorkspaceName: "Acme"}, []NotionSnapshot{snapshot}, DefaultAppImportLimits())
	if err != nil || !strings.Contains(string(documents[0].Markdown), "Provenance: notion_database") {
		t.Fatalf("documents=%+v err=%v", documents, err)
	}
}

func notionProxySendsVersion(requests []proxyRequest, endpoint string) bool {
	for _, request := range requests {
		if request.Endpoint != endpoint {
			continue
		}
		for _, parameter := range request.Parameters {
			if parameter.Name == "Notion-Version" && parameter.Type == "header" && parameter.Value == "2022-06-28" {
				return true
			}
		}
	}
	return false
}
