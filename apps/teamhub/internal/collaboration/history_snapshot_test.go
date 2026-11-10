package collaboration

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHistoryCardPresentationDoesNotPublishActionSecrets(t *testing.T) {
	raw := json.RawMessage(`{"intent":"connection_requested","title":"Connect","description":"Public description","status":"pending","authorization_url":"https://provider.example?secret=private","provider_state":"private","run_input":"private","task_input":"private"}`)
	card := historyCardPresentation(raw)
	encoded, err := json.Marshal(card)
	if err != nil {
		t.Fatal(err)
	}
	if card.Title != "Connect" || card.Description != "Public description" || strings.Contains(string(encoded), "private") {
		t.Fatalf("unsafe presentation: %s", encoded)
	}
	if safeHistoryImage("image/svg+xml") || safeHistoryImage("text/html") || !safeHistoryImage("image/png") {
		t.Fatal("active content must not be published as an image")
	}
}
