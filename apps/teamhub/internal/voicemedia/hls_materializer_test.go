package voicemedia

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestMediaExclusionPreservesAACPacketsAndCompactsTheirTimeline(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is unavailable")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is unavailable")
	}
	if !supportsAACPacketDrop(t.Context(), ffmpeg) {
		t.Skip("ffmpeg noise bitstream filter does not support expression-based packet dropping")
	}
	temporary := t.TempDir()
	input := filepath.Join(temporary, "input.m4a")
	if output, err := exec.CommandContext(t.Context(), ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:a", "aac", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	type packet struct {
		PTS      string `json:"pts_time"`
		Duration string `json:"duration_time"`
		Hash     string `json:"data_hash"`
	}
	packets := func(file string) []packet {
		t.Helper()
		output, err := exec.CommandContext(t.Context(), ffprobe, "-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts_time,duration_time,data_hash", "-of", "json", file).Output()
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Packets []packet `json:"packets"`
		}
		if err = json.Unmarshal(output, &result); err != nil {
			t.Fatal(err)
		}
		return result.Packets
	}
	var want []string
	for _, p := range packets(input) {
		start, _ := strconv.ParseFloat(p.PTS, 64)
		duration, _ := strconv.ParseFloat(p.Duration, 64)
		if start < 0.25 || start+duration > 2.75 || (start < 2 && start+duration > 1) {
			continue
		}
		want = append(want, p.Hash)
	}
	m := &HLSMaterializer{ffmpeg: ffmpeg, ffprobe: ffprobe}
	output, err := m.excludeMediaRanges(t.Context(), input, temporary, []MediaTimeRange{{StartMS: 0, EndMS: 250}, {StartMS: 1000, EndMS: 2000}, {StartMS: 2750, EndMS: 3000}}, 3000)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for index, p := range packets(output) {
		got = append(got, p.Hash)
		pts, _ := strconv.ParseFloat(p.PTS, 64)
		if difference := pts - float64(index)*1024/48000; difference < -0.00001 || difference > 0.00001 {
			t.Fatalf("packet %d has discontinuous timestamp %f", index, pts)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("media exclusion changed or retained incorrect AAC packets: got=%d want=%d", len(got), len(want))
	}
	duration, err := m.probe(t.Context(), output)
	if err != nil || duration < 1400 || duration > 1550 {
		t.Fatalf("duration=%d err=%v", duration, err)
	}
}

func supportsAACPacketDrop(ctx context.Context, ffmpeg string) bool {
	output, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-h", "bsf=noise").CombinedOutput()
	return err == nil && strings.Contains(string(output), "\n  -drop ")
}

func TestTrimToRangeLimitsStreamCopiedAudio(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is unavailable")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is unavailable")
	}
	temporary := t.TempDir()
	input := filepath.Join(temporary, "joined.m4a")
	if output, commandErr := exec.CommandContext(t.Context(), ffmpeg,
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
		"-c:a", "aac", input,
	).CombinedOutput(); commandErr != nil {
		t.Fatalf("create fixture: %v: %s", commandErr, output)
	}
	materializer := &HLSMaterializer{ffmpeg: ffmpeg, ffprobe: ffprobe}
	trimmed, err := materializer.trimToRange(t.Context(), input, temporary, 0, 1_000, 3_000)
	if err != nil {
		t.Fatal(err)
	}
	duration, err := materializer.probe(t.Context(), trimmed)
	if err != nil {
		t.Fatal(err)
	}
	if duration < 900 || duration > 1_100 {
		t.Fatalf("trimmed duration=%dms want approximately 1000ms", duration)
	}
}

func TestJoinSegmentsKeepsTinyFinalTransportStreamSegment(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is unavailable")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is unavailable")
	}
	temporary := t.TempDir()
	playlist := filepath.Join(temporary, "fixture.m3u8")
	if output, commandErr := exec.CommandContext(t.Context(), ffmpeg,
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.05",
		"-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", playlist,
	).CombinedOutput(); commandErr != nil {
		t.Fatalf("create HLS fixture: %v: %s", commandErr, output)
	}
	segments, err := filepath.Glob(filepath.Join(temporary, "fixture*.ts"))
	if err != nil || len(segments) < 2 {
		t.Fatalf("fixture segments=%v err=%v", segments, err)
	}
	objects := make(map[string]string, len(segments))
	keys := make([]string, 0, len(segments))
	for index, segment := range segments {
		content, readErr := os.ReadFile(segment)
		if readErr != nil {
			t.Fatal(readErr)
		}
		key := fmt.Sprintf("fixture_%05d.ts", index)
		keys = append(keys, key)
		objects[key] = string(content)
	}
	materializer := &HLSMaterializer{
		staging: memoryStaging{objects: objects}, ffmpeg: ffmpeg, ffprobe: ffprobe,
	}
	joined := filepath.Join(temporary, "joined.m4a")
	if err = materializer.joinSegments(t.Context(), keys, temporary, joined); err != nil {
		t.Fatal(err)
	}
	duration, err := materializer.probe(t.Context(), joined)
	if err != nil {
		t.Fatal(err)
	}
	if duration < 2_000 || duration > 2_150 {
		t.Fatalf("joined duration=%dms want approximately 2050ms", duration)
	}
	inspected, err := materializer.InspectSalvagePrefix(t.Context(), "fixture")
	if err != nil || inspected != duration {
		t.Fatalf("salvage inspection lost the final segment: duration=%d want=%d err=%v", inspected, duration, err)
	}
}

type memoryStaging struct {
	objects map[string]string
}

func TestJoinSegmentsPrefetchesInOrderWithBoundedReaders(t *testing.T) {
	command, err := exec.LookPath("true")
	if err != nil {
		t.Fatal(err)
	}
	staging := &coordinatedStaging{ready: make(chan struct{})}
	keys := make([]string, 41)
	for index := range keys {
		keys[index] = fmt.Sprintf("segment-%03d.ts", index)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	temporary := t.TempDir()
	m := &HLSMaterializer{staging: staging, ffmpeg: command}
	if err := m.joinSegments(ctx, keys, temporary, filepath.Join(temporary, "output.m4a")); err != nil {
		t.Fatalf("a slow first segment must allow later downloads to proceed: %v", err)
	}
	joined, err := os.ReadFile(filepath.Join(temporary, "joined.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if string(joined) != strings.Join(keys, "") {
		t.Fatal("concurrent segment downloads changed the media order")
	}
	if staging.maximum < 2 || staging.maximum > 16 || staging.active != 0 || staging.closed != len(keys) {
		t.Fatalf("unbounded or leaked readers: maximum=%d active=%d closed=%d", staging.maximum, staging.active, staging.closed)
	}
}

func TestReadSegmentRejectsOversizedOrEmptyMedia(t *testing.T) {
	for _, size := range []int{0, maximumSegmentBytes + 1} {
		staging := &singleSegmentStaging{body: &trackedSegment{Reader: strings.NewReader(strings.Repeat("x", size))}}
		m := &HLSMaterializer{staging: staging}
		if _, err := m.readSegment(t.Context(), "segment.ts"); err == nil {
			t.Fatalf("accepted invalid segment size %d", size)
		}
		if !staging.body.closed {
			t.Fatal("invalid segment reader was not closed")
		}
	}
}

func TestReadSegmentClosesFailedBody(t *testing.T) {
	failure := errors.New("interrupted staging read")
	staging := &singleSegmentStaging{body: &trackedSegment{Reader: errorSegmentReader{err: failure}}}
	m := &HLSMaterializer{staging: staging}
	if _, err := m.readSegment(t.Context(), "segment.ts"); !errors.Is(err, failure) || !staging.body.closed {
		t.Fatalf("read failure=%v closed=%t", err, staging.body.closed)
	}
}

type singleSegmentStaging struct {
	stagingStore
	body *trackedSegment
}

func (s *singleSegmentStaging) Open(context.Context, string) (io.ReadCloser, error) {
	return s.body, nil
}

type trackedSegment struct {
	io.Reader
	closed bool
}

func (s *trackedSegment) Close() error { s.closed = true; return nil }

type errorSegmentReader struct{ err error }

func (r errorSegmentReader) Read([]byte) (int, error) { return 0, r.err }

type coordinatedStaging struct {
	stagingStore
	mu      sync.Mutex
	ready   chan struct{}
	opened  int
	active  int
	maximum int
	closed  int
}

func (s *coordinatedStaging) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	s.opened++
	s.active++
	s.maximum = max(s.maximum, s.active)
	if s.opened == 2 {
		close(s.ready)
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		s.mu.Lock()
		s.active--
		s.mu.Unlock()
		return nil, ctx.Err()
	case <-s.ready:
	}
	return &coordinatedSegment{Reader: strings.NewReader(key), staging: s}, nil
}

type coordinatedSegment struct {
	io.Reader
	staging *coordinatedStaging
}

func (s *coordinatedSegment) Close() error {
	s.staging.mu.Lock()
	defer s.staging.mu.Unlock()
	s.staging.active--
	s.staging.closed++
	return nil
}

func TestCompactVoiceMediaExclusionsRemovesExplicitGaps(t *testing.T) {
	got := compactVoiceMediaExclusions(
		[]MediaTimeRange{{StartMS: 4_000, EndMS: 8_000}, {StartMS: 10_000, EndMS: 12_000}},
		[]store.CaptureMediaRange{{Kind: "gap", StartOffsetMs: 5_000, EndOffsetMs: 9_000}},
	)
	want := []MediaTimeRange{{StartMS: 4_000, EndMS: 5_000}, {StartMS: 6_000, EndMS: 8_000}}
	if len(got) != len(want) {
		t.Fatalf("compact exclusions=%v want=%v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("compact exclusions=%v want=%v", got, want)
		}
	}
}

func TestVoiceMediaTrimWindowHonorsFinalBoundaryAndGaps(t *testing.T) {
	start, duration, err := voiceMediaTrimWindow(
		MaterializeRequest{FromMS: 2_000, ThroughMS: 12_000},
		[]store.CaptureMediaRange{{Kind: "gap", StartOffsetMs: 5_000, EndOffsetMs: 8_000}},
		30_000,
	)
	if err != nil {
		t.Fatal(err)
	}
	if start != 2_000 || duration != 7_000 {
		t.Fatalf("trim window=%d+%d want=2000+7000", start, duration)
	}
}

func TestMediaExclusionRejectsRemovingAllAudio(t *testing.T) {
	m := &HLSMaterializer{ffmpeg: "/nonexistent/ffmpeg"}
	if _, err := m.excludeMediaRanges(t.Context(), "input.m4a", t.TempDir(),
		[]MediaTimeRange{{StartMS: 0, EndMS: 8_000}}, 8_000); !errors.Is(err, ErrCaptureConflict) {
		t.Fatalf("full exclusion error=%v want=%v", err, ErrCaptureConflict)
	}
}

func TestFinalMediaExclusionsFollowTheSourceTimeline(t *testing.T) {
	ranges := []store.CaptureMediaRange{
		{Kind: "media", StartOffsetMs: 0, EndOffsetMs: 10_000, Reason: "egress_archived"},
		{Kind: "gap", StartOffsetMs: 4_000, EndOffsetMs: 5_000, Reason: "publisher_absent"},
		{Kind: "gap", StartOffsetMs: 10_000, EndOffsetMs: 12_000, Reason: "egress_restart"},
		{Kind: "media", StartOffsetMs: 12_000, EndOffsetMs: 20_000, Reason: "egress_archived"},
		{Kind: "gap", StartOffsetMs: 14_000, EndOffsetMs: 15_000, Reason: "publisher_absent"},
	}
	// The source starts at Capture offset 2000 and spans 16 seconds of the joined archive.
	got := finalMediaExclusions(MaterializeRequest{FromMS: 2_000, ThroughMS: 20_000}, ranges, 16_000)
	want := []MediaTimeRange{{StartMS: 2_000, EndMS: 3_000}, {StartMS: 10_000, EndMS: 11_000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("final exclusions=%v want=%v", got, want)
	}
	if got := finalMediaExclusions(MaterializeRequest{FromMS: 0, ThroughMS: 4_000}, ranges, 4_000); len(got) != 0 {
		t.Fatalf("a source without in-media gaps must be reused, exclusions=%v", got)
	}
}

func (s memoryStaging) Open(_ context.Context, key string) (io.ReadCloser, error) {
	body, exists := s.objects[key]
	if !exists {
		return nil, os.ErrNotExist
	}
	return io.NopCloser(strings.NewReader(body)), nil
}

func (s memoryStaging) DeletePrefix(_ context.Context, prefix string) error {
	for key := range s.objects {
		if strings.HasPrefix(key, prefix) {
			delete(s.objects, key)
		}
	}
	return nil
}

func (s memoryStaging) List(_ context.Context, prefix, after string) ([]string, error) {
	keys := make([]string, 0)
	for key := range s.objects {
		if strings.HasPrefix(key, prefix) && key > after {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func TestSegmentProgressReadsOnlyTheUnconfirmedTail(t *testing.T) {
	staging := &trackedListStaging{memoryStaging: memoryStaging{objects: map[string]string{
		"capture/epoch-0_09998.ts": "old",
		"capture/epoch-0_09999.ts": "old",
		"capture/epoch-0_10000.ts": "new",
		"capture/epoch-0_10001.ts": "new",
	}}}
	m := &HLSMaterializer{staging: staging}
	count, err := m.SegmentCount(t.Context(), "capture/epoch-0", 10_000)
	if err != nil || count != 10_002 || staging.after != "capture/epoch-0_09999" {
		t.Fatalf("progress count=%d after=%q err=%v; must reuse the durable confirmed watermark", count, staging.after, err)
	}
	if count, err = m.SegmentCount(t.Context(), "capture/epoch-0", count); err != nil || count != 10_002 {
		t.Fatalf("an unchanged tail reset the watermark: count=%d err=%v", count, err)
	}
	delete(staging.objects, "capture/epoch-0_10000.ts")
	if _, err = m.SegmentCount(t.Context(), "capture/epoch-0", 10_000); err == nil {
		t.Fatal("progress skipped an unconfirmed missing segment")
	}
}

type trackedListStaging struct {
	memoryStaging
	after string
}

func (s *trackedListStaging) List(ctx context.Context, prefix, after string) ([]string, error) {
	s.after = after
	return s.memoryStaging.List(ctx, prefix, after)
}

func TestReadPlaylistRequiresSealedSafeRelativeSegments(t *testing.T) {
	materializer := &HLSMaterializer{staging: memoryStaging{objects: map[string]string{
		"capture/epoch-0.m3u8": "#EXTM3U\n#EXTINF:2.0,\nepoch-0_00000.ts\n#EXT-X-ENDLIST\n",
	}}}
	segments, err := materializer.readPlaylist(t.Context(), "capture/epoch-0.m3u8")
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0] != "capture/epoch-0_00000.ts" {
		t.Fatalf("unexpected playlist segments: %v", segments)
	}
}

func TestReadPlaylistRejectsUnsealedOrEscapingSegments(t *testing.T) {
	for name, playlist := range map[string]string{
		"unsealed": "#EXTM3U\n#EXTINF:2.0,\nepoch-0_00000.ts\n",
		"escaping": "#EXTM3U\n#EXTINF:2.0,\n../other.ts\n#EXT-X-ENDLIST\n",
	} {
		t.Run(name, func(t *testing.T) {
			materializer := &HLSMaterializer{staging: memoryStaging{objects: map[string]string{
				"capture/epoch-0.m3u8": playlist,
			}}}
			if _, err := materializer.readPlaylist(t.Context(), "capture/epoch-0.m3u8"); err == nil {
				t.Fatal("expected playlist validation to fail")
			}
		})
	}
}

func TestReadSalvagedPlaylistUsesOnlyContiguousSegments(t *testing.T) {
	materializer := &HLSMaterializer{staging: memoryStaging{objects: map[string]string{
		"capture/epoch-0_00002.ts":  "two",
		"capture/epoch-0_00000.ts":  "zero",
		"capture/epoch-0_00001.ts":  "one",
		"capture/epoch-0-live.m3u8": "ignored",
	}}}
	segments, err := materializer.readPlaylist(t.Context(), "capture/epoch-0#salvaged")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"capture/epoch-0_00000.ts",
		"capture/epoch-0_00001.ts",
		"capture/epoch-0_00002.ts",
	}
	if len(segments) != len(want) {
		t.Fatalf("segments=%v, want %v", segments, want)
	}
	for index := range want {
		if segments[index] != want[index] {
			t.Fatalf("segments=%v, want %v", segments, want)
		}
	}
}

func TestVoiceMediaPlaylistReadsOnlySealedEpochs(t *testing.T) {
	active := store.VoiceMediaEpoch{ObservedState: "active", StagingPrefix: "capture/epoch-0"}
	if _, err := voiceMediaPlaylist(active); !errors.Is(err, ErrCaptureConflict) {
		t.Fatalf("active epoch error=%v want=%v", err, ErrCaptureConflict)
	}
	sealed := store.VoiceMediaEpoch{
		ObservedState:     "available",
		PlaylistObjectKey: pgtype.Text{String: "capture/epoch-0.m3u8", Valid: true},
	}
	if got, err := voiceMediaPlaylist(sealed); err != nil || got != "capture/epoch-0.m3u8" {
		t.Fatalf("sealed playlist=%q err=%v", got, err)
	}
}

func TestReadSalvagedPlaylistRejectsSegmentGap(t *testing.T) {
	materializer := &HLSMaterializer{staging: memoryStaging{objects: map[string]string{
		"capture/epoch-0_00000.ts": "zero",
		"capture/epoch-0_00002.ts": "two",
	}}}
	if _, err := materializer.readPlaylist(t.Context(), "capture/epoch-0#salvaged"); err == nil {
		t.Fatal("expected a non-contiguous salvage prefix to fail")
	}
}

func TestStableVoiceMediaIDsIncludeOperationInputs(t *testing.T) {
	one := stableID("voice_media_operation", "capture-1", "end", "key-1")
	two := stableID("voice_media_operation", "capture-1", "end", "key-2")
	if one == two || one != stableID("voice_media_operation", "capture-1", "end", "key-1") {
		t.Fatalf("stable IDs are not deterministic and input-sensitive: %q %q", one, two)
	}
}

func TestPublisherAbsenceGapInsideMediaIsExcludedNotCompacted(t *testing.T) {
	ranges := []store.CaptureMediaRange{
		{Kind: "media", StartOffsetMs: 0, EndOffsetMs: 10_000, Reason: "egress_archived"},
		{Kind: "gap", StartOffsetMs: 4_000, EndOffsetMs: 5_000, Reason: "publisher_absent"},
		{Kind: "gap", StartOffsetMs: 10_000, EndOffsetMs: 12_000, Reason: "egress_restart"},
		{Kind: "media", StartOffsetMs: 12_000, EndOffsetMs: 20_000, Reason: "egress_archived"},
		{Kind: "gap", StartOffsetMs: 19_000, EndOffsetMs: 21_000, Reason: "media_ended_before_stop"},
	}
	compactable, inMedia := splitVoiceMediaGaps(ranges)
	if len(compactable) != 2 || compactable[0].StartOffsetMs != 10_000 || compactable[0].EndOffsetMs != 12_000 || compactable[1].StartOffsetMs != 20_000 || compactable[1].EndOffsetMs != 21_000 {
		t.Fatalf("compactable gaps=%+v", compactable)
	}
	want := []MediaTimeRange{{StartMS: 4_000, EndMS: 5_000}, {StartMS: 19_000, EndMS: 20_000}}
	if len(inMedia) != len(want) || inMedia[0] != want[0] || inMedia[1] != want[1] {
		t.Fatalf("in-media gaps=%v want=%v", inMedia, want)
	}
	// The archive still holds the silent minute, so only the missing recorder
	// interval shortens the trim window.
	start, duration, err := voiceMediaTrimWindow(MaterializeRequest{FromMS: 0, ThroughMS: 20_000}, ranges, 18_000)
	if err != nil || start != 0 || duration != 18_000 {
		t.Fatalf("trim window=%d+%d err=%v want=0+18000", start, duration, err)
	}
	excluded := compactVoiceMediaExclusions(inMedia, ranges)
	if len(excluded) != 2 || excluded[0] != (MediaTimeRange{StartMS: 4_000, EndMS: 5_000}) || excluded[1] != (MediaTimeRange{StartMS: 17_000, EndMS: 18_000}) {
		t.Fatalf("joined-timeline exclusions=%v", excluded)
	}
}
