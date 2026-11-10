package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestVoiceDictationCommitRequestIDMatchesPublicContract(t *testing.T) {
	for _, test := range []struct {
		name, id string
		valid    bool
	}{
		{"empty", "", false},
		{"spaces", "   ", false},
		{"leading space", " request", false},
		{"trailing space", "request ", false},
		{"embedded space", "request id", false},
		{"trailing newline", "request\n", false},
		{"dot", "request.id", false},
		{"colon", "request:id", false},
		{"slash", "request/id", false},
		{"unicode", "requestCafé", false},
		{"leading underscore", "_request", false},
		{"leading hyphen", "-request", false},
		{"65 characters", strings.Repeat("a", 65), false},
		{"64 characters", strings.Repeat("a", 64), true},
		{"single digit", "0", true},
		{"mixed case and separators", "Turn_Ab9-01", true},
		{"UUID", "123e4567-e89b-12d3-a456-426614174000", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := voice.VoiceDictationRequestIDPattern.MatchString(test.id); got != test.valid {
				t.Fatalf("valid=%t want=%t", got, test.valid)
			}
			if test.valid {
				return
			}
			// Invalid IDs must stop at HTTP validation, before any authenticated
			// media request or Runtime side effect is attempted.
			body, err := json.Marshal(httpapi.VoiceDictationCommitRequest{RequestId: test.id})
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(response)
			ctx.Set("request_id", "request-test")
			ctx.Request = httptest.NewRequest(http.MethodPost, "/v0/voice-sessions/voice-1/dictation-commit", strings.NewReader(string(body)))
			ctx.Request.Header.Set("Content-Type", "application/json")
			application := &App{voiceMedia: voicemedia.New(nil, nil, nil)}
			application.commitVoiceDictationTurn(ctx)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid ID status=%d want=400", response.Code)
			}
		})
	}
}

func TestGetActiveVoiceSessionRequiresAuthentication(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodGet, "/v0/rooms/room-1/voice-sessions", nil)
	context.Set("request_id", "request-test")

	newPublicContractTestEngine(&App{}).ServeHTTP(response, context.Request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want=%d body=%s", response.Code, http.StatusUnauthorized, response.Body.String())
	}
}

func TestListVoiceTranscriptEventsRequiresAuthentication(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodGet, "/v0/voice-sessions/voice-1/transcript-events", nil)
	context.Set("request_id", "request-test")

	newPublicContractTestEngine(&App{}).ServeHTTP(response, context.Request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want=%d body=%s", response.Code, http.StatusUnauthorized, response.Body.String())
	}
}

func TestVoiceCaptureModelIncludesGapEvidence(t *testing.T) {
	model := voice.VoiceCaptureModel(voicemedia.Capture{
		ID: "capture-1", VoiceSessionID: "voice-1", RoomID: "room-1",
		Status:   "finalized",
		GapCount: 2, GapDurationMS: 12_300,
	})

	if model.GapCount != 2 || model.GapDurationMs != 12_300 {
		t.Fatalf("gap evidence=(%d,%d) want=(2,12300)", model.GapCount, model.GapDurationMs)
	}
}

func TestVoiceCaptureModelIncludesRequestedStartOffset(t *testing.T) {
	for _, offset := range []int64{0, 2000} {
		model := voice.VoiceCaptureModel(voicemedia.Capture{RequestedStartOffsetMS: offset})
		encoded, err := json.Marshal(model)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		value, present := fields["requested_start_offset_ms"]
		var actual int64
		if !present || json.Unmarshal(value, &actual) != nil || actual != offset {
			t.Fatal("requested start offset was not projected through the public API")
		}
	}
}
