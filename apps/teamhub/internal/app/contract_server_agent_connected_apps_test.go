package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
)

func TestConnectedAppsResponsesKeepWireShape(t *testing.T) {
	for _, test := range []struct {
		name, want string
		response   any
	}{
		{"empty connections", `{"connections":[]}`, agentListConnectedAppsResponse(nil)},
		{"empty tools", `{"tools":[]}`, agentSearchAppToolsResponse(nil)},
		{"tool schemas",
			`{"tools":[{"tool_slug":"NOTION_READ","tool_version":"20260911_00","name":"Read","description":"Read a page","app_key":"notion","input_schema":{"type":"object","required":["page_id"]},"output_schema":{},"available_connections":[{"connection_id":"connection_1","app_key":"notion","display_name":"Notion","identity_label":"Alice"}]}]}`,
			agentSearchAppToolsResponse([]agentconnectedapps.AppTool{{ToolSlug: "NOTION_READ", ToolVersion: "20260911_00", Name: "Read", Description: "Read a page", AppKey: "notion", InputSchema: map[string]any{"type": "object", "required": []string{"page_id"}}, AvailableConnections: []agentconnectedapps.ConnectedApp{{ConnectionID: "connection_1", AppKey: "notion", DisplayName: "Notion", Identity: "Alice"}}}})},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(test.response)
			if err != nil {
				t.Fatal(err)
			}
			var got, want map[string]any
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(test.want), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("response=%s want=%s", encoded, test.want)
			}
		})
	}
}

// The CLI shows the Agent issues, never messages, so a domain error's issues
// reach the response.
func TestConnectedAppsErrorsCarryTheirIssues(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	issue := agentconnectedapps.Issue{Path: "tool_version", Code: "tool_version_unavailable", Message: "The pinned version is gone"}
	(&App{}).writeAgentConnectedAppsError(c, "bind connector tools", &agentconnectedapps.Error{Code: "tool_not_found", Message: issue.Message, Issues: []agentconnectedapps.Issue{issue}})
	var envelope struct {
		Error struct {
			Code   string
			Issues []map[string]string
		}
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	want := []map[string]string{{"path": issue.Path, "code": issue.Code, "message": issue.Message}}
	if recorder.Code != http.StatusNotFound || envelope.Error.Code != "tool_not_found" || !reflect.DeepEqual(envelope.Error.Issues, want) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body)
	}
}
