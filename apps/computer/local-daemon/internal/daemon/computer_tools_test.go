package daemon

import (
	"encoding/json"
	"testing"
)

func TestLiveBrowserResultIsDeliveredAsOk(t *testing.T) {
	for _, data := range []string{
		`{"content":[{"type":"text","text":"Opened https://www.google.com"}]}`,
		`{"content":[{"type":"text","text":"BROWSER_BUSY: another task is using the user's Chrome"}],"isError":true}`,
	} {
		result, err := liveBrowserResult(json.RawMessage(data))
		if err != nil || result["status"] != "ok" || result["content"] == nil {
			t.Fatalf("%s: result=%v err=%v", data, result, err)
		}
	}
	if _, err := liveBrowserResult(json.RawMessage(`not json`)); err == nil {
		t.Fatal("an unreadable result was delivered")
	}
}
