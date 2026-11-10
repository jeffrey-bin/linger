package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/livekit/protocol/livekit"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"google.golang.org/protobuf/proto"
)

// voiceRecorderRoom fakes the LiveKit RoomService that carries the recording
// directive and the Voice Runtime recorder that follows it. Naming a staging
// prefix in the Room metadata starts that epoch's recorder; the recorder then
// reports through the same staging store Voice Runtime uses.
type voiceRecorderRoom struct {
	t        *testing.T
	staging  *voicemedia.LocalStagingStore
	server   *httptest.Server
	mutex    sync.Mutex
	metadata map[string]string
	// start reports the recorder of a newly named epoch. Nil reports it
	// active at the current time.
	start func(ctx context.Context, prefix string)
	// stop runs after the directive for prefix is withdrawn. Nil leaves the
	// recorder sealing until the test reports it.
	stop func(ctx context.Context, prefix string)
	// refuse runs before a directive naming an epoch is stored; it returns
	// true after writing a failed response, as an unavailable LiveKit does.
	refuse func(http.ResponseWriter) bool
	// handle serves other RoomService calls; it returns nil for an
	// unexpected call.
	handle func(path string, body []byte) proto.Message
	// stops counts directive withdrawals.
	stops atomic.Int32
}

func newVoiceRecorderRoom(t *testing.T, pool *pgxpool.Pool) *voiceRecorderRoom {
	t.Helper()
	room := &voiceRecorderRoom{t: t, staging: voicemedia.NewLocalStagingStore(pool, t.TempDir()), metadata: map[string]string{}}
	room.server = httptest.NewServer(http.HandlerFunc(room.serve))
	registerIntegrationServerCleanup(t, room.server)
	return room
}

func (r *voiceRecorderRoom) provider(cfg voicemedia.LiveKitConfig, pool *pgxpool.Pool) *voicemedia.LiveKitProvider {
	r.t.Helper()
	cfg.APIURL, cfg.PublicURL, cfg.APIKey, cfg.APISecret = r.server.URL, r.server.URL, "test", "test"
	provider, err := voicemedia.NewLiveKitProvider(cfg, pool)
	if err != nil {
		r.t.Fatal(err)
	}
	return provider
}

// direct names prefix in the Room metadata without starting a recorder, as a
// directive TeamHub wrote before the test began.
func (r *voiceRecorderRoom) direct(room, prefix string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.metadata[room] = `{"recording":{"staging_prefix":"` + prefix + `","segment_seconds":2}}`
}

func recordingDirectivePrefix(metadata string) string {
	var directive struct {
		Recording *struct {
			StagingPrefix string `json:"staging_prefix"`
		} `json:"recording"`
	}
	if metadata == "" || json.Unmarshal([]byte(metadata), &directive) != nil || directive.Recording == nil {
		return ""
	}
	return directive.Recording.StagingPrefix
}

func (r *voiceRecorderRoom) serve(w http.ResponseWriter, request *http.Request) {
	// LiveKit RPCs use POST; host port probes must not reach the fixture.
	if request.Method != http.MethodPost {
		http.NotFound(w, request)
		return
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		r.t.Error(err)
		return
	}
	var result proto.Message
	switch {
	case strings.HasSuffix(request.URL.Path, "/ListRooms"):
		var list livekit.ListRoomsRequest
		if err = proto.Unmarshal(body, &list); err != nil || len(list.Names) != 1 {
			r.t.Errorf("unexpected ListRooms request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		r.mutex.Lock()
		result = &livekit.ListRoomsResponse{Rooms: []*livekit.Room{{Name: list.Names[0], Metadata: r.metadata[list.Names[0]]}}}
		r.mutex.Unlock()
	case strings.HasSuffix(request.URL.Path, "/UpdateRoomMetadata"):
		var update livekit.UpdateRoomMetadataRequest
		if err = proto.Unmarshal(body, &update); err != nil {
			r.t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		next := recordingDirectivePrefix(update.Metadata)
		if next != "" && r.refuse != nil && r.refuse(w) {
			return
		}
		r.mutex.Lock()
		previous := recordingDirectivePrefix(r.metadata[update.Room])
		r.metadata[update.Room] = update.Metadata
		r.mutex.Unlock()
		if previous != "" && previous != next {
			r.stops.Add(1)
			if r.stop != nil {
				r.stop(request.Context(), previous)
			}
		}
		if next != "" && next != previous {
			if r.start != nil {
				r.start(request.Context(), next)
			} else {
				r.report(request.Context(), next, "active", time.Now(), 0)
			}
		}
		result = &livekit.Room{Name: update.Room, Metadata: update.Metadata}
	default:
		if r.handle != nil {
			result = r.handle(request.URL.Path, body)
		}
		if result == nil {
			r.t.Errorf("unexpected provider request %s", request.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
	}
	encoded, err := proto.Marshal(result)
	if err != nil {
		r.t.Error(err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/protobuf")
	_, _ = w.Write(encoded)
}

// report stores one recorder state change, as Voice Runtime reports it.
func (r *voiceRecorderRoom) report(ctx context.Context, prefix, state string, startedAt time.Time, archivedMS int64) {
	r.t.Helper()
	report := voicemedia.RecordingReport{StagingPrefix: prefix, State: state, ArchivedThroughMS: archivedMS}
	if !startedAt.IsZero() {
		report.StartedAt = &startedAt
	}
	if state == "failed" {
		report.FailureCode = "recorder_failed"
	}
	if err := r.staging.ReportRecording(ctx, report); err != nil {
		r.t.Errorf("report %s %s: %v", prefix, state, err)
	}
}

// record uploads input as the HLS segments and sealed playlist the recorder
// writes for prefix. An unsealed recording has segments but no playlist, as
// a recorder that failed before sealing leaves it.
func (r *voiceRecorderRoom) record(prefix, input string, sealed bool) {
	r.t.Helper()
	directory := r.t.TempDir()
	name := path.Base(prefix)
	if output, err := exec.CommandContext(r.t.Context(), "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", input,
		"-map", "0:a:0", "-c:a", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "vod",
		"-hls_segment_filename", filepath.Join(directory, name+"_%05d.ts"), filepath.Join(directory, name+".m3u8"),
	).CombinedOutput(); err != nil {
		r.t.Fatalf("HLS fixture: %v %s", err, output)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		r.t.Fatal(err)
	}
	for _, entry := range entries {
		if !sealed && strings.HasSuffix(entry.Name(), ".m3u8") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			r.t.Fatal(err)
		}
		if err = r.staging.Put(r.t.Context(), path.Dir(prefix)+"/"+entry.Name(), body); err != nil {
			r.t.Fatalf("stage %s: %v", entry.Name(), err)
		}
	}
}
