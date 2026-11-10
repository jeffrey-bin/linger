package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func TestPermissionReviewInputKeepsTheDesktopTargets(t *testing.T) {
	var input teamhubinternal.CreateRuntimePermissionReviewRequest
	if err := json.Unmarshal([]byte(`{"context_key":"c","execution_run_ref":"r","operation_id":"o","request_id":"q",
		"action":{"runtime":"claude","surface":"computer","tool":"mcp__computer__click","input":"{}"},
		"evidence":{"desktop":{"app":"Mail","window_title":"Inbox","targets":[{"token":"s1:3","role":"AXButton","name":"Send"},{"token":"s1:4","role":"AXRow"}]}}}`), &input); err != nil {
		t.Fatal(err)
	}
	want := &permissionreview.DesktopEvidence{App: "Mail", WindowTitle: "Inbox", Targets: []permissionreview.DesktopTarget{
		{Token: "s1:3", Role: "AXButton", Name: "Send"}, {Token: "s1:4", Role: "AXRow"},
	}}
	if got := permissionReviewInput(input).Evidence.Desktop; !reflect.DeepEqual(got, want) {
		t.Fatalf("desktop = %+v", got)
	}
}
