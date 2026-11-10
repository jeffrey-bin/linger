package app

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/retention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// registeredKinds reads the job kinds registered in workers. River keeps its
// worker map unexported, so the test reads the field directly.
func registeredKinds(workers *river.Workers) []string {
	kinds := reflect.ValueOf(workers).Elem().FieldByName("workersMap").MapKeys()
	names := make([]string, 0, len(kinds))
	for _, kind := range kinds {
		names = append(names, kind.String())
	}
	slices.Sort(names)
	return names
}

func retentionTables(rules []retention.Rule) []string {
	tables := make([]string, 0, len(rules))
	for _, rule := range rules {
		tables = append(tables, rule.Table)
	}
	return tables
}

// Every deployment registers the connected app jobs, because a Composio key
// can be saved at run time; each job checks for the key when it runs.
var externalAppKinds = []string{
	"external.connection_cleanup", "external.connection_reconcile", "external.connection_reconcile_sweep",
	"external.mail_connection", "external.mail_import", "external.mail_sync", "external.mail_sync_sweep",
	"external.reauthorization",
	"listener.poll", "listener.sweep", "maintenance.proactive_listener_sweep",
	"typedcard.connection_auth_reconcile", "typedcard.connection_auth_settle",
}

var voiceRetentionTables = []string{
	"voice_transcript_segments",
	"voice_sessions", "voice_transcript_uncertainties",
}

// The optional features a configuration turns on register their River kinds,
// periodic jobs, retention rules, routes and loops; a feature whose startup
// configuration is missing registers none of them.
func TestOptionalFeaturesRegisterFromConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name      string
		judge     bool
		voice     bool
		kinds     []string
		retention []string
		periodic  int
		resume    int
	}{
		{
			// The injected plane has no LiveKit provider, materializer or archive
			// ASR, so only the recording completion job is registered.
			name: "full configuration", judge: true, voice: true,
			kinds:     slices.Concat(externalAppKinds, []string{"voice_capture_completion"}),
			retention: voiceRetentionTables, periodic: 5, resume: 1,
		},
		{
			// .env.example: a judge model, no Soniox or Composio key.
			name: "default deployment", judge: true,
			kinds: externalAppKinds, periodic: 5,
		},
		{name: "nothing configured", kinds: externalAppKinds, periodic: 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{cfg: config.ForTest()}
			features := newFeatureSet()
			var plane voicemedia.Plane
			if tc.voice {
				plane = voicemedia.New(nil, nil, nil)
			}
			if err := a.registerVoice(config.VoiceConfig{}, plane, nil, ""); err != nil {
				t.Fatal(err)
			}
			a.addVoiceJobs(features)
			var judge permissionreview.Judge
			if tc.judge {
				judge = allowingJudge{}
			}
			a.registerPermissionReview(config.PermissionReviewConfig{}, nil, judge)
			a.addExternalAppJobs(features, true)

			want := slices.Clone(tc.kinds)
			slices.Sort(want)
			if got := registeredKinds(features.workers); !slices.Equal(got, want) {
				t.Fatalf("River kinds:\n got %v\nwant %v", got, want)
			}
			if len(features.periodic) != tc.periodic {
				t.Fatalf("periodic jobs = %d, want %d", len(features.periodic), tc.periodic)
			}
			wantRetention := slices.Concat(retentionTables(retention.Core), tc.retention)
			if got := retentionTables(a.retentionRules()); !slices.Equal(got, wantRetention) {
				t.Fatalf("retention rules = %v, want %v", got, wantRetention)
			}
			if len(features.resume) != tc.resume {
				t.Fatalf("resume steps = %d, want %d", len(features.resume), tc.resume)
			}
			if (a.voiceMedia != nil) != tc.voice || a.permissionReviewEnabled() != tc.judge {
				t.Fatalf("voice=%v judge=%v", a.voiceMedia != nil, a.permissionReviewEnabled())
			}
		})
	}
}

// Without app listeners (Reminder jobs skipped) the listener jobs stay out.
func TestExternalAppJobsWithoutListeners(t *testing.T) {
	features := newFeatureSet()
	(&App{cfg: config.ForTest()}).addExternalAppJobs(features, false)
	got := registeredKinds(features.workers)
	for _, kind := range []string{"listener.poll", "listener.sweep", "maintenance.proactive_listener_sweep"} {
		if slices.Contains(got, kind) {
			t.Fatalf("%s registered without app listeners", kind)
		}
	}
	if len(features.periodic) != 3 {
		t.Fatalf("periodic jobs = %d, want the 3 connected app sweeps", len(features.periodic))
	}
}

// The Voice Runtime callbacks answer only with voice media on.
func TestVoiceRuntimeCallbacksNeedVoiceMedia(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name  string
		media voicemedia.Plane
		want  int
	}{
		{"voice off", nil, http.StatusNotFound},
		{"voice on", voicemedia.New(nil, nil, nil), http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{}
			a.cfg.Voice.RuntimeToken = "voice-token"
			if err := a.registerVoice(config.VoiceConfig{}, tc.media, nil, ""); err != nil {
				t.Fatal(err)
			}
			engine := gin.New()
			engine.POST("/internal/v1/voice/observations", a.requireVoiceRuntime(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/voice/observations", nil)
			request.Header.Set("Authorization", "Bearer voice-token")
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d", response.Code, tc.want)
			}
		})
	}
}

// Live runs on xAI alone; dictation and Recording transcribe with Soniox.
func TestVoiceSessionPurposeNeedsItsProvider(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, purpose, xai string
		transcription      bool
	}{
		{"dictation without Soniox", "chat_dictation", "xai-key", false},
		{"recording without Soniox", "hardware_control", "xai-key", false},
		{"live without xAI", "chat_live", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{voiceMedia: voicemedia.New(nil, nil, nil), voiceTranscription: tc.transcription}
			a.cfg.Voice.XaiAPIKey = tc.xai
			engine := gin.New()
			engine.POST("/v0/rooms/:roomId/voice-sessions", func(c *gin.Context) {
				c.Set("request_id", "request")
				a.createVoiceSession(c)
			})
			request := httptest.NewRequest(http.MethodPost, "/v0/rooms/room/voice-sessions", strings.NewReader(`{"purpose":"`+tc.purpose+`"}`))
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusServiceUnavailable, response.Body)
			}
		})
	}
}
