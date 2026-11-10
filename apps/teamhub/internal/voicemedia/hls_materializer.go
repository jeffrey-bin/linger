package voicemedia

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const maximumPlaylistBytes = 4 << 20

const maximumSegmentDownloads = 16

const maximumSegmentBytes = 8 << 20

// FFmpeg 6 defaults to one demuxed packet, causing excessive thread handoffs on long audio.
const voiceMediaPacketQueueSize = "1024"

const salvagedPlaylistSuffix = "#salvaged"

var segmentIndexPattern = regexp.MustCompile(`(?:^|[-_/])(\d+)\.(?:aac|ts)$`)

type stagingStore interface {
	Open(context.Context, string) (io.ReadCloser, error)
	List(context.Context, string, string) ([]string, error)
	DeletePrefix(context.Context, string) error
}

type HLSMaterializer struct {
	queries *store.Queries
	staging stagingStore
	objects artifactstore.ObjectStore
	ffmpeg  string
	ffprobe string
}

func NewHLSMaterializer(
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	staging *LocalStagingStore,
) (*HLSMaterializer, error) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, errors.New("ffmpeg is required for voice media materialization")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		return nil, errors.New("ffprobe is required for voice media validation")
	}
	return &HLSMaterializer{
		queries: store.New(pool), staging: staging, objects: objects,
		ffmpeg: ffmpeg, ffprobe: ffprobe,
	}, nil
}

// DeleteCaptureStaging removes every epoch the recorder wrote for the Capture.
func (m *HLSMaterializer) DeleteCaptureStaging(ctx context.Context, captureID string) error {
	return m.staging.DeletePrefix(ctx, captureStagingPrefix(captureID))
}

// Materialize builds one saved recording. The source purpose joins the
// recorder's archive once and trims it to the Capture range; the final purpose
// starts from that source object and only drops the in-media gaps, reusing the
// source object when there is nothing to drop.
func (m *HLSMaterializer) Materialize(ctx context.Context, request MaterializeRequest) (MaterializedAudio, error) {
	if request.CaptureSessionID == "" || request.ThroughMS <= request.FromMS {
		return MaterializedAudio{}, ErrCaptureConflict
	}
	switch request.Purpose {
	case "source":
		return m.materializeSource(ctx, request)
	case "final":
		return m.materializeFinal(ctx, request)
	}
	return MaterializedAudio{}, ErrCaptureConflict
}

func (m *HLSMaterializer) materializeSource(ctx context.Context, request MaterializeRequest) (MaterializedAudio, error) {
	epochs, err := m.queries.ListVoiceMediaEpochsForCapture(ctx, request.CaptureSessionID)
	if err != nil {
		return MaterializedAudio{}, err
	}
	// A recovery cancelled before the recorder started has no audio. Its zero-length
	// sealed epoch retains the lifecycle audit; the prior epochs hold the media.
	usable := epochs[:0]
	for _, epoch := range epochs {
		if epoch.ObservedState == "available" && epoch.FirstArchivedMs.Valid && epoch.FinalEndMs.Valid && epoch.FirstArchivedMs.Int64 == epoch.FinalEndMs.Int64 && !epoch.PlaylistObjectKey.Valid {
			continue
		}
		usable = append(usable, epoch)
	}
	epochs = usable
	if len(epochs) == 0 {
		return MaterializedAudio{}, ErrCaptureConflict
	}
	temporary, err := os.MkdirTemp("", ".teamhub-voice-media-*")
	if err != nil {
		return MaterializedAudio{}, err
	}
	defer os.RemoveAll(temporary)
	joinedPath := filepath.Join(temporary, "joined.m4a")
	segmentKeys := make([]string, 0)
	for _, epoch := range epochs {
		playlist, playlistErr := voiceMediaPlaylist(epoch)
		if playlistErr != nil {
			return MaterializedAudio{}, ErrCaptureConflict
		}
		segments, readErr := m.readPlaylist(ctx, playlist)
		if readErr != nil {
			return MaterializedAudio{}, readErr
		}
		segmentKeys = append(segmentKeys, segments...)
	}
	if err = m.joinSegments(ctx, segmentKeys, temporary, joinedPath); err != nil {
		return MaterializedAudio{}, err
	}
	ranges, err := m.queries.ListCaptureMediaRangesForCapture(ctx, request.CaptureSessionID)
	if err != nil {
		return MaterializedAudio{}, err
	}
	joinedDurationMS, err := m.probe(ctx, joinedPath)
	if err != nil {
		return MaterializedAudio{}, err
	}
	trimStartMS, trimDurationMS, err := voiceMediaTrimWindow(request, ranges, joinedDurationMS)
	if err != nil {
		return MaterializedAudio{}, err
	}
	// The source keeps archived filler audio so archive recovery offsets stay
	// on the joined timeline.
	outputPath, err := m.trimToRange(ctx, joinedPath, temporary, trimStartMS, trimDurationMS, joinedDurationMS)
	if err != nil {
		return MaterializedAudio{}, err
	}
	return m.storeOutput(ctx, request, outputPath)
}

func (m *HLSMaterializer) materializeFinal(ctx context.Context, request MaterializeRequest) (MaterializedAudio, error) {
	source, err := m.queries.GetCaptureMediaOutput(ctx, store.GetCaptureMediaOutputParams{
		CaptureSessionID: request.CaptureSessionID, Purpose: "source",
		RangeDigest: mediaRangeDigest(request.CaptureSessionID, "source", request.FromMS, request.ThroughMS),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return MaterializedAudio{}, ErrCaptureConflict
	}
	if err != nil {
		return MaterializedAudio{}, err
	}
	ranges, err := m.queries.ListCaptureMediaRangesForCapture(ctx, request.CaptureSessionID)
	if err != nil {
		return MaterializedAudio{}, err
	}
	temporary, err := os.MkdirTemp("", ".teamhub-voice-media-*")
	if err != nil {
		return MaterializedAudio{}, err
	}
	defer os.RemoveAll(temporary)
	sourcePath := filepath.Join(temporary, "source.m4a")
	if err = m.downloadOutput(ctx, source, sourcePath); err != nil {
		return MaterializedAudio{}, err
	}
	// Published audio is its own stored object even when it equals the source:
	// each saved output owns its object, so deleting one never orphans the other.
	outputPath := sourcePath
	if excluded := finalMediaExclusions(request, ranges, source.DurationMs); len(excluded) > 0 {
		if outputPath, err = m.excludeMediaRanges(ctx, sourcePath, temporary, excluded, source.DurationMs); err != nil {
			return MaterializedAudio{}, err
		}
	}
	return m.storeOutput(ctx, request, outputPath)
}

// finalMediaExclusions places on the source timeline the filler the recorder
// archived while no browser was publishing; published audio removes it. The
// source starts at the compacted range start.
func finalMediaExclusions(request MaterializeRequest, ranges []store.CaptureMediaRange, sourceDurationMS int64) []MediaTimeRange {
	gaps, inMediaGaps := splitVoiceMediaGaps(ranges)
	return shiftVoiceMediaExclusions(compactVoiceMediaExclusions(inMediaGaps, ranges),
		compactVoiceMediaOffset(request.FromMS, gaps), sourceDurationMS)
}

// downloadOutput copies a saved recording into path after checking its size
// and digest.
func (m *HLSMaterializer) downloadOutput(ctx context.Context, output store.CaptureMediaOutput, path string) error {
	body, err := m.objects.Open(ctx, output.ObjectKey)
	if err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		_ = body.Close()
		return err
	}
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(body, output.SizeBytes+1))
	if err = errors.Join(copyErr, body.Close(), file.Close()); err != nil {
		return err
	}
	if size != output.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != output.Sha256 {
		return errors.New("saved voice media integrity mismatch")
	}
	return nil
}

func (m *HLSMaterializer) storeOutput(ctx context.Context, request MaterializeRequest, outputPath string) (MaterializedAudio, error) {
	durationMS, err := m.probe(ctx, outputPath)
	if err != nil {
		return MaterializedAudio{}, err
	}
	file, err := os.Open(outputPath)
	if err != nil {
		return MaterializedAudio{}, err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return MaterializedAudio{}, err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return MaterializedAudio{}, err
	}
	var sum [sha256.Size]byte
	copy(sum[:], digest.Sum(nil))
	keyDigest := requestHash("voice-media-output-v1", request.CaptureSessionID, request.Purpose,
		fmt.Sprint(request.FromMS), fmt.Sprint(request.ThroughMS))
	objectKey := "object_" + hex.EncodeToString(keyDigest[:16])
	object, _, err := m.objects.PutIfAbsent(ctx, objectKey, file, size, sum)
	if err != nil {
		return MaterializedAudio{}, err
	}
	return MaterializedAudio{
		ObjectKey: object.Key, Filename: "source.m4a", MediaType: "audio/mp4",
		DurationMS: durationMS, SizeBytes: object.Size, SHA256: hex.EncodeToString(object.SHA256[:]),
	}, nil
}

func (m *HLSMaterializer) joinSegments(
	ctx context.Context,
	segmentKeys []string,
	temporary string,
	outputPath string,
) error {
	if len(segmentKeys) == 0 {
		return ErrCaptureConflict
	}
	inputFormat := "mpegts"
	extension := strings.ToLower(path.Ext(segmentKeys[0]))
	if extension == ".aac" {
		inputFormat = "aac"
	} else if extension != ".ts" {
		return ErrCaptureConflict
	}
	transportPath := filepath.Join(temporary, "joined"+extension)
	transport, err := os.Create(transportPath)
	if err != nil {
		return err
	}
	defer transport.Close()
	for _, key := range segmentKeys {
		if strings.ToLower(path.Ext(key)) != extension {
			return ErrCaptureConflict
		}
	}
	// Bound requests and buffered bytes independently of recording length, then append in playlist order.
	for start := 0; start < len(segmentKeys); start += maximumSegmentDownloads {
		batch := segmentKeys[start:min(start+maximumSegmentDownloads, len(segmentKeys))]
		batchCtx, cancel := context.WithCancel(ctx)
		failures := make(chan error, 1)
		data := make([][]byte, len(batch))
		var downloads sync.WaitGroup
		for index, key := range batch {
			downloads.Go(func() {
				body, err := m.readSegment(batchCtx, key)
				if err != nil {
					select {
					case failures <- err:
					default:
					}
					cancel()
					return
				}
				data[index] = body
			})
		}
		downloads.Wait()
		cancel()
		select {
		case err := <-failures:
			return err
		default:
		}
		for _, segment := range data {
			if _, err := transport.Write(segment); err != nil {
				return err
			}
		}
	}
	if err = transport.Close(); err != nil {
		return err
	}
	command := exec.CommandContext(ctx, m.ffmpeg,
		"-hide_banner", "-loglevel", "error", "-y",
		"-thread_queue_size", voiceMediaPacketQueueSize, "-f", inputFormat, "-i", transportPath,
		"-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart", outputPath,
	)
	if output, commandErr := command.CombinedOutput(); commandErr != nil {
		return fmt.Errorf("materialize LiveKit voice media: %w: %s", commandErr, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *HLSMaterializer) readSegment(ctx context.Context, key string) ([]byte, error) {
	segment, err := m.staging.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	body, readErr := io.ReadAll(io.LimitReader(segment, maximumSegmentBytes+1))
	if err := errors.Join(readErr, segment.Close()); err != nil {
		return nil, err
	}
	if len(body) == 0 || len(body) > maximumSegmentBytes {
		return nil, errors.New("voice media segment is empty or exceeds the size limit")
	}
	return body, nil
}

// Saved audio reads only sealed epochs.
func voiceMediaPlaylist(epoch store.VoiceMediaEpoch) (string, error) {
	if epoch.ObservedState == "available" && epoch.PlaylistObjectKey.Valid {
		return epoch.PlaylistObjectKey.String, nil
	}
	return "", ErrCaptureConflict
}

// excludeMediaRanges drops the AAC packets that overlap excluded ranges. The
// recorder writes AAC-LC packets of 1024 samples at 48 kHz, so every retained
// payload is kept as is and the output timeline is renumbered contiguously.
func (m *HLSMaterializer) excludeMediaRanges(ctx context.Context, inputPath, temporary string, excluded []MediaTimeRange, durationMS int64) (string, error) {
	excludedMS := int64(0)
	parts := []string{"lt(pts*tb\\,0)"}
	for _, current := range excluded {
		start := max(int64(0), min(current.StartMS, durationMS))
		end := max(start, min(current.EndMS, durationMS))
		excludedMS += end - start
		parts = append(parts, fmt.Sprintf("lt(pts*tb\\,%.3f)*gt((pts+duration)*tb\\,%.3f)", float64(current.EndMS)/1000, float64(current.StartMS)/1000))
	}
	if excludedMS >= durationMS {
		return "", ErrCaptureConflict
	}
	outputPath := filepath.Join(temporary, "excluded.m4a")
	bitstream := "noise=amount=0:drop=" + strings.Join(parts, "+") + ",setts=ts=N*1024"
	command := exec.CommandContext(ctx, m.ffmpeg,
		"-hide_banner", "-loglevel", "error", "-y",
		"-thread_queue_size", voiceMediaPacketQueueSize, "-i", inputPath, "-map", "0:a:0", "-c:a", "copy", "-bsf:a", bitstream,
		"-movflags", "+faststart", outputPath,
	)
	if output, commandErr := command.CombinedOutput(); commandErr != nil {
		return "", fmt.Errorf("exclude Voice media audio: %w: %s", commandErr, strings.TrimSpace(string(output)))
	}
	return outputPath, nil
}

func (m *HLSMaterializer) trimToRange(
	ctx context.Context,
	joinedPath string,
	temporary string,
	startMS int64,
	durationMS int64,
	joinedDurationMS int64,
) (string, error) {
	if startMS == 0 && durationMS >= joinedDurationMS {
		return joinedPath, nil
	}
	outputPath := filepath.Join(temporary, "trimmed.m4a")
	command := exec.CommandContext(ctx, m.ffmpeg,
		"-hide_banner", "-loglevel", "error", "-y",
		"-ss", fmt.Sprintf("%.3f", float64(startMS)/1000),
		"-thread_queue_size", voiceMediaPacketQueueSize, "-i", joinedPath, "-t", fmt.Sprintf("%.3f", float64(durationMS)/1000),
		"-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart", outputPath,
	)
	if output, commandErr := command.CombinedOutput(); commandErr != nil {
		return "", fmt.Errorf("trim LiveKit voice media: %w: %s", commandErr, strings.TrimSpace(string(output)))
	}
	return outputPath, nil
}

// A gap between media ranges has no archived audio: the joined archive already
// skips it, so Capture offsets compact across it. A gap inside a media range
// (no browser was publishing while the recorder archived filler silence) still
// occupies joined audio; it is excluded from published output instead.
func splitVoiceMediaGaps(ranges []store.CaptureMediaRange) ([]store.CaptureMediaRange, []MediaTimeRange) {
	var media []store.CaptureMediaRange
	for _, current := range ranges {
		if current.Kind == "media" && current.EndOffsetMs > current.StartOffsetMs {
			media = append(media, current)
		}
	}
	sort.SliceStable(media, func(i, j int) bool { return media[i].StartOffsetMs < media[j].StartOffsetMs })
	var compactable []store.CaptureMediaRange
	var inMedia []MediaTimeRange
	for _, gap := range ranges {
		if gap.Kind != "gap" || gap.EndOffsetMs <= gap.StartOffsetMs {
			continue
		}
		cursor := gap.StartOffsetMs
		for _, span := range media {
			if span.EndOffsetMs <= cursor {
				continue
			}
			if span.StartOffsetMs >= gap.EndOffsetMs {
				break
			}
			if span.StartOffsetMs > cursor {
				missing := gap
				missing.StartOffsetMs, missing.EndOffsetMs = cursor, span.StartOffsetMs
				compactable = append(compactable, missing)
			}
			inMedia = append(inMedia, MediaTimeRange{StartMS: max(cursor, span.StartOffsetMs), EndMS: min(gap.EndOffsetMs, span.EndOffsetMs)})
			cursor = min(gap.EndOffsetMs, span.EndOffsetMs)
		}
		if cursor < gap.EndOffsetMs {
			missing := gap
			missing.StartOffsetMs = cursor
			compactable = append(compactable, missing)
		}
	}
	return compactable, inMedia
}

func compactVoiceMediaOffset(offset int64, gaps []store.CaptureMediaRange) int64 {
	removed := int64(0)
	for _, current := range gaps {
		if offset <= current.StartOffsetMs {
			continue
		}
		removed += min(offset, current.EndOffsetMs) - current.StartOffsetMs
	}
	return max(int64(0), offset-removed)
}

func voiceMediaTrimWindow(
	request MaterializeRequest,
	ranges []store.CaptureMediaRange,
	joinedDurationMS int64,
) (int64, int64, error) {
	gaps, _ := splitVoiceMediaGaps(ranges)
	compact := func(offset int64) int64 { return compactVoiceMediaOffset(offset, gaps) }
	start := compact(request.FromMS)
	end := min(compact(request.ThroughMS), joinedDurationMS)
	if start < 0 || end <= start {
		return 0, 0, ErrCaptureConflict
	}
	return start, end - start, nil
}

func shiftVoiceMediaExclusions(
	excluded []MediaTimeRange,
	trimStartMS int64,
	trimDurationMS int64,
) []MediaTimeRange {
	result := make([]MediaTimeRange, 0, len(excluded))
	trimEndMS := trimStartMS + trimDurationMS
	for _, current := range excluded {
		start := max(current.StartMS, trimStartMS)
		end := min(current.EndMS, trimEndMS)
		if end > start {
			result = append(result, MediaTimeRange{
				StartMS: start - trimStartMS,
				EndMS:   end - trimStartMS,
			})
		}
	}
	return result
}

func compactVoiceMediaExclusions(
	excluded []MediaTimeRange,
	ranges []store.CaptureMediaRange,
) []MediaTimeRange {
	gaps, _ := splitVoiceMediaGaps(ranges)
	result := make([]MediaTimeRange, 0, len(excluded))
	for _, current := range excluded {
		start := compactVoiceMediaOffset(current.StartMS, gaps)
		end := compactVoiceMediaOffset(current.EndMS, gaps)
		if end > start {
			result = append(result, MediaTimeRange{StartMS: start, EndMS: end})
		}
	}
	return result
}

func (m *HLSMaterializer) InspectSalvagePrefix(ctx context.Context, prefix string) (int64, error) {
	segments, err := m.listContiguousSegments(ctx, prefix, 0)
	if err != nil {
		return 0, err
	}
	temporary, err := os.MkdirTemp("", ".teamhub-voice-salvage-*")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(temporary)
	outputPath := filepath.Join(temporary, "salvage.m4a")
	if err = m.joinSegments(ctx, segments, temporary, outputPath); err != nil {
		return 0, err
	}
	return m.probe(ctx, outputPath)
}

func (m *HLSMaterializer) SegmentCount(ctx context.Context, prefix string, confirmed int64) (int64, error) {
	segments, err := m.listContiguousSegments(ctx, prefix, confirmed)
	if errors.Is(err, ErrNoSalvageMedia) {
		return confirmed, nil
	}
	return confirmed + int64(len(segments)), err
}

func (m *HLSMaterializer) readPlaylist(ctx context.Context, key string) ([]string, error) {
	if strings.HasSuffix(key, salvagedPlaylistSuffix) {
		return m.listContiguousSegments(ctx, strings.TrimSuffix(key, salvagedPlaylistSuffix), 0)
	}
	reader, err := m.staging.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	limited := io.LimitReader(reader, maximumPlaylistBytes+1)
	content, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(content) > maximumPlaylistBytes {
		return nil, errors.New("voice media playlist exceeds the maximum size")
	}
	if !strings.Contains(string(content), "#EXT-X-ENDLIST") {
		return nil, errors.New("voice media playlist is not sealed")
	}
	base := path.Dir(key)
	segments := make([]string, 0)
	scanner := bufio.NewScanner(strings.NewReader(string(content)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.Contains(line, "://") || strings.HasPrefix(line, "/") || strings.Contains(line, "..") {
			return nil, errors.New("voice media playlist contains an unsafe segment reference")
		}
		resolved := path.Clean(path.Join(base, line))
		if !strings.HasPrefix(resolved, base+"/") {
			return nil, errors.New("voice media playlist segment escapes its epoch prefix")
		}
		segments = append(segments, resolved)
	}
	return segments, scanner.Err()
}

func (m *HLSMaterializer) listContiguousSegments(ctx context.Context, prefix string, confirmed int64) ([]string, error) {
	if confirmed < 0 {
		return nil, ErrCaptureConflict
	}
	after := ""
	// The recorder uses five-digit HLS indices. Fall back to a full listing across the digit rollover.
	if confirmed > 0 && confirmed < 100_000 {
		after = fmt.Sprintf("%s_%05d", prefix, confirmed-1)
	}
	keys, err := m.staging.List(ctx, prefix, after)
	if err != nil {
		return nil, err
	}
	type indexedKey struct {
		index int64
		key   string
	}
	indexed := make([]indexedKey, 0, len(keys))
	for _, key := range keys {
		match := segmentIndexPattern.FindStringSubmatch(key)
		if len(match) != 2 {
			continue
		}
		index, parseErr := strconv.ParseInt(match[1], 10, 64)
		if parseErr != nil {
			return nil, errors.New("voice media segment index is invalid")
		}
		if index >= confirmed {
			indexed = append(indexed, indexedKey{index: index, key: key})
		}
	}
	sort.Slice(indexed, func(left, right int) bool { return indexed[left].index < indexed[right].index })
	if len(indexed) == 0 {
		return nil, ErrNoSalvageMedia
	}
	segments := make([]string, len(indexed))
	for index, item := range indexed {
		if item.index != confirmed+int64(index) {
			return nil, errors.New("voice media salvage prefix is not contiguous")
		}
		segments[index] = item.key
	}
	return segments, nil
}

func (m *HLSMaterializer) probe(ctx context.Context, file string) (int64, error) {
	output, err := exec.CommandContext(ctx, m.ffprobe,
		"-v", "error", "-show_entries", "format=duration:stream=codec_type",
		"-of", "json", file,
	).Output()
	if err != nil {
		return 0, fmt.Errorf("probe materialized voice media: %w", err)
	}
	var result struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
	}
	if err = json.Unmarshal(output, &result); err != nil {
		return 0, err
	}
	audioStreams := 0
	for _, stream := range result.Streams {
		if stream.CodecType == "audio" {
			audioStreams++
		}
	}
	seconds, err := strconv.ParseFloat(result.Format.Duration, 64)
	if err != nil || seconds <= 0 || audioStreams != 1 {
		return 0, errors.New("materialized voice media must contain exactly one non-empty audio stream")
	}
	return int64(seconds * 1000), nil
}
