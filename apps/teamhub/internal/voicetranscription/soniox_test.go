package voicetranscription

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"

	"testing"
)

func TestSonioxTranscriberSendsLanguageHintsWhenConfigured(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/files" {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "file-1"})
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/v1/transcriptions" {
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			hints, _ := request["language_hints"].([]any)
			if len(hints) != 2 || hints[0] != "zh" || hints[1] != "en" {
				t.Fatalf("unexpected language hints %#v", request["language_hints"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "completed"})
			return
		}
		if r.URL.Path == "/v1/transcriptions/tx-1/transcript" {
			_ = json.NewEncoder(w).Encode(map[string]any{"text": "hello", "tokens": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "completed"})
	}))
	defer server.Close()
	adapter, err := NewSonioxTranscriber(SonioxConfig{
		APIKey: "voice-secret", BaseURL: server.URL, HTTPClient: server.Client(),
		LanguageHints: []string{"zh", "en", ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.TranscribeArchivePCM(context.Background(), make([]byte, 16000*2)); err != nil {
		t.Fatal(err)
	}
}

func TestSonioxTranscriberMapsArchiveTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/files":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			payload, err := io.ReadAll(file)
			if err != nil {
				t.Fatal(err)
			}
			if len(payload) != 44+16000*2 {
				t.Fatalf("archive PCM must be wrapped as wav: %d", len(payload))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "file-1"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/transcriptions":
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if request["enable_speaker_diarization"] != true {
				t.Fatalf("recordings must request diarization: %#v", request)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "queued"})
		case r.URL.Path == "/v1/transcriptions/tx-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "completed"})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"text": "Hello world",
				"tokens": []any{
					map[string]any{"text": "Hello", "start_ms": 80, "end_ms": 320},
					map[string]any{"text": " ", "start_ms": 320, "end_ms": 360},
					map[string]any{"text": "world", "start_ms": 360, "end_ms": 720},
				},
			})
		}
	}))
	defer server.Close()
	adapter, err := NewSonioxTranscriber(SonioxConfig{
		APIKey: "voice-secret", BaseURL: server.URL, HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	segments, err := adapter.TranscribeArchivePCM(context.Background(), make([]byte, 16000*2))
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].Text != "Hello world" || segments[0].StartMS != 80 || segments[0].EndMS != 720 {
		t.Fatalf("unexpected segments %+v", segments)
	}
	if len(segments[0].Words) != 2 || segments[0].Words[0].TextStart != 0 || segments[0].Words[1].TextStart != 6 {
		t.Fatalf("unexpected words %+v", segments[0].Words)
	}
}

func TestSonioxTranscriberAcceptsSilentArchiveBlock(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/files":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "file-1"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/transcriptions":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "queued"})
		case r.URL.Path == "/v1/transcriptions/tx-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "completed"})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"text": "", "tokens": []any{}})
		}
	}))
	defer server.Close()
	adapter, err := NewSonioxTranscriber(SonioxConfig{
		APIKey: "voice-secret", BaseURL: server.URL, HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	segments, err := adapter.TranscribeArchivePCM(context.Background(), make([]byte, 16000*2))
	if err != nil || len(segments) != 0 {
		t.Fatalf("silent archive must return empty segments: %v %+v", err, segments)
	}
}

func TestSonioxTranscriberMapsProviderFailures(t *testing.T) {
	tests := []struct {
		name   string
		status int
		want   error
	}{
		{name: "rate limited", status: http.StatusTooManyRequests, want: ErrProviderRateLimited},
		{name: "rejected", status: http.StatusBadRequest, want: ErrProviderRejected},
		{name: "unauthorized", status: http.StatusUnauthorized, want: ErrProviderRejected},
		{name: "upstream", status: http.StatusInternalServerError, want: ErrProviderFailure},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
			}))
			defer server.Close()
			adapter, err := NewSonioxTranscriber(SonioxConfig{
				APIKey: "voice-secret", BaseURL: server.URL, HTTPClient: server.Client(),
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := adapter.TranscribeArchivePCM(context.Background(), make([]byte, 16000*2)); !errors.Is(err, test.want) {
				t.Fatalf("expected %v, got %v", test.want, err)
			}
		})
	}
}

func TestNewSonioxTranscriberValidatesConfig(t *testing.T) {
	if _, err := NewSonioxTranscriber(SonioxConfig{}); err == nil {
		t.Fatal("accepted empty config")
	}
}

func TestGroupSonioxTokensSplitsOnSpeaker(t *testing.T) {
	t.Parallel()
	groups := groupSonioxTokens([]sonioxToken{
		{Text: "hello", StartMS: 0, EndMS: 400, Speaker: 1},
		{Text: "there", StartMS: 400, EndMS: 800, Speaker: "2"},
	})
	if len(groups) != 2 || sonioxGroupSpeakerID(groups[0]) != "spk_1" || sonioxGroupSpeakerID(groups[1]) != "spk_2" {
		t.Fatalf("groups=%#v", groups)
	}
}
