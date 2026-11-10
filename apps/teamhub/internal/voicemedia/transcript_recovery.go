package voicemedia

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// A recovery keeps its provider blocks in memory until it publishes, so an
// attempt that runs out of time or stops starts over from the source audio.
// Each attempt may take the base plus the source duration; after the failure
// budget the recovery fails and waits for the account to retry it.
const (
	transcriptRecoveryBaseTimeout     = 10 * time.Minute
	transcriptRecoveryFailureBudget   = 8
	transcriptRecoveryUnavailableCode = "asr_recovery_unavailable"
)

func transcriptRecoveryTimeout(sourceDurationMS int64) time.Duration {
	return transcriptRecoveryBaseTimeout + time.Duration(sourceDurationMS)*time.Millisecond
}

var errRecoveryWordTimingRequired = errors.New("archive overlap needs word timing")
var errRecoveryBlockDiscontinuous = errors.New("recovery block does not continue the source cursor")
var errRecoverySpliceConflict = errors.New("archive overlap cannot be aligned")

func (s *Service) queueTranscriptRecovery(ctx context.Context, job store.GetVoiceMediaMaterializationContextRow, duration int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if _, err = q.QueueVoiceTranscriptRecovery(ctx, store.QueueVoiceTranscriptRecoveryParams{CaptureSessionID: job.CaptureSessionID, SourceDurationMs: duration}); err != nil {
		return err
	}
	if err = roomevent.AppendCaptureSessionChanged(ctx, q, job.TenantID, job.RoomID, job.CreatedByActorID, job.CaptureSessionID, "recovering"); err != nil {
		return err
	}
	if err = enqueue(ctx, tx, TranscriptRecoveryArgs{CaptureSessionID: job.CaptureSessionID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// recoverTranscriptStep transcribes the Capture's archive again while its
// recovery is due. A provider rejection fails the recovery until the account
// retries it; other failures retry with backoff.
func (s *Service) recoverTranscriptStep(ctx context.Context, captureID string) (time.Duration, error) {
	audioProvider := s.materializer.(recoveryAudioProvider)
	job, err := s.queries.ClaimVoiceTranscriptRecovery(ctx, captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		seconds, dueErr := s.queries.VoiceTranscriptRecoveryDueIn(ctx, captureID)
		return dueWait(seconds), dueErr
	}
	if err != nil {
		return jobErrorWait, err
	}
	total := job.TranscriptRecoveryTotalMs.Int64
	ctx, cancel := context.WithTimeout(ctx, transcriptRecoveryTimeout(total))
	defer cancel()
	err = s.recoverTranscript(ctx, audioProvider, job.ID, total, nil)
	if errors.Is(err, errRecoveryLocalizedBoundary) {
		// A targeted plan whose boundary cannot be clipped falls back to the
		// whole archive; the cursor restarts at the beginning.
		if _, err = s.queries.ClaimVoiceTranscriptRecovery(ctx, captureID); err == nil {
			err = s.recoverTranscript(ctx, audioProvider, job.ID, total, []recoveryRange{{0, total}})
		}
	}
	if err == nil {
		return JobDone, nil
	}
	status, code := "pending", transcriptRecoveryUnavailableCode
	var constraint *pgconn.PgError
	if errors.Is(err, voicetranscription.ErrProviderRejected) || errors.Is(err, voicetranscription.ErrInvalidInput) || errors.Is(err, voicetranscription.ErrInvalidProviderResponse) || errors.Is(err, pgx.ErrNoRows) || (errors.As(err, &constraint) && constraint.Code == "23505") {
		status, code = "failed", "asr_recovery_rejected"
	}
	if errors.Is(err, errRecoverySpliceConflict) {
		status, code = "failed", "asr_recovery_splice_conflict"
	} else if errors.Is(err, voicetranscription.ErrProviderRejected) {
		status, code = "failed", "asr_recovery_provider_rejected"
	} else if errors.Is(err, voicetranscription.ErrInvalidProviderResponse) {
		status, code = "failed", "asr_recovery_invalid_timing"
	}
	if status == "pending" && job.TranscriptRecoveryFailures+1 >= transcriptRecoveryFailureBudget {
		status = "failed"
	}
	delay := min(5*time.Minute, 5*time.Second*time.Duration(1<<min(job.TranscriptRecoveryFailures, 6)))
	cleanupCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	if releaseErr := s.queries.ReleaseVoiceTranscriptRecovery(cleanupCtx, store.ReleaseVoiceTranscriptRecoveryParams{CaptureSessionID: job.ID, Status: status, FailureCode: code, RetryDelay: durationInterval(delay)}); releaseErr != nil {
		return jobErrorWait, releaseErr
	}
	next := delay
	if status == "failed" {
		next = JobDone
	}
	// Expose a stable class rather than provider response bodies or transcript text.
	return next, errors.New(code)
}

// recoverTranscript transcribes the planned spans of the Capture's source
// audio from its beginning and publishes them. A nil plan is computed from
// the Capture's recording and transcript.
func (s *Service) recoverTranscript(ctx context.Context, provider recoveryAudioProvider, captureID string, total int64, plan []recoveryRange) error {
	source, err := s.queries.GetVoiceSourceAudio(ctx, captureID)
	if err != nil {
		return err
	}
	var accountID string
	if err = s.pool.QueryRow(ctx, "SELECT actor.account_id FROM capture_sessions capture JOIN actors actor ON actor.id=capture.created_by_actor_id WHERE capture.id=$1", captureID).Scan(&accountID); err != nil {
		return err
	}
	capture, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: pgtype.Text{String: accountID, Valid: true}})
	if err != nil {
		return err
	}
	if plan == nil {
		if plan, err = s.planCaptureRecovery(ctx, capture, total); err != nil {
			return err
		}
	}
	audio, err := provider.openRecoveryAudio(ctx, source)
	if err != nil {
		return err
	}
	defer audio.close()
	var blocks []recoveryBlock
	var cursor int64
	// Skipping audio outside the plan moves the progress the Capture shows;
	// the skipped interval must not reach into a planned span.
	skip := func(end int64) error {
		if end <= cursor {
			return nil
		}
		for _, span := range plan {
			if span.Start < end && span.End > cursor {
				return errRecoveryBlockDiscontinuous
			}
		}
		err := s.advanceRecoveryCursor(ctx, captureID, cursor, end)
		if err == nil {
			cursor = end
		}
		return err
	}
	for _, span := range plan {
		if span.End <= cursor {
			continue
		}
		if err := skip(span.Start); err != nil {
			return err
		}
		local, err := s.transcribeRecoveryBlocks(ctx, audio.file, captureID, cursor, span.End, accountID)
		if err != nil {
			return err
		}
		blocks = append(blocks, local...)
		cursor = span.End
	}
	if err := skip(total); err != nil {
		return err
	}
	return s.publishRecoveredTranscript(ctx, captureID, accountID, plan, blocks)
}

// Provider round trips dominate recovery time: the remaining source audio is
// planned in bounded blocks and up to the configured number of provider calls
// run at once, while blocks are accepted strictly in order so the recovery
// cursor stays contiguous. Source PCM in memory stays bounded to about one
// block per worker; accepted blocks keep only their words. Every candidate is checked against the merged projection before
// commitment; a splice conflict repairs only the two neighbouring blocks instead of
// re-reading the whole recording.
func (s *Service) transcribeRecoveryBlocks(ctx context.Context, audio io.ReaderAt, captureID string, start, end int64, accountID string) ([]recoveryBlock, error) {
	var blocks []recoveryBlock
	var merged []voicetranscription.StreamingResult
	transcribe := func(ctx context.Context, cursor, _ int64) (recoveryBlock, error) {
		if _, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: pgtype.Text{String: accountID, Valid: true}}); err != nil {
			return recoveryBlock{}, err
		}
		// The worker re-reads its planned block from the source file; an
		// inconsistent provider response shortens only this block and the
		// pipeline replans the remaining audio from the actual end.
		return transcribeNextRecoveryBlock(ctx, audio, s.archiveASR, cursor, end)
	}
	commit := func(ctx context.Context, block recoveryBlock) error {
		next, err := mergeRecoveryBlocks(merged, []recoveryBlock{block})
		if err != nil {
			if len(blocks) == 0 || blocks[len(blocks)-1].End != block.Start {
				return err
			}
			prefix, prefixErr := mergeRecoveryBlocks(nil, blocks[:len(blocks)-1])
			if prefixErr != nil {
				return prefixErr
			}
			left := blocks[len(blocks)-1]
			replacement, repairErr := repairRecoveryBoundary(ctx, audio, s.archiveASR, prefix, left, block, errors.Is(err, errRecoveryWordTimingRequired))
			if repairErr != nil {
				return repairErr
			}
			if err := s.advanceRecoveryCursor(ctx, captureID, block.Start, replacement[len(replacement)-1].End); err != nil {
				return err
			}
			blocks = append(blocks[:len(blocks)-1], replacement...)
			merged, err = mergeRecoveryBlocks(nil, blocks)
			return err
		}
		if err := s.advanceRecoveryCursor(ctx, captureID, block.Start, block.End); err != nil {
			return err
		}
		blocks = append(blocks, block)
		merged = next
		return nil
	}
	err := runRecoveryBlockPipeline(ctx, audio, start, end, s.archiveRecoveryConcurrency, transcribe, commit)
	return blocks, err
}

// advanceRecoveryCursor moves the progress the Capture shows from start to
// end of the source audio.
func (s *Service) advanceRecoveryCursor(ctx context.Context, captureID string, start, end int64) error {
	_, err := s.queries.AdvanceVoiceTranscriptRecoveryProgress(ctx, store.AdvanceVoiceTranscriptRecoveryProgressParams{
		CaptureSessionID: captureID, StartOffsetMs: start, EndOffsetMs: end,
	})
	return err
}

// A block planned ahead of its provider call. The planner only needs the quiet
// boundary; the worker reads the PCM itself so memory stays with the workers.
type pipelineBlock struct {
	cursor, end int64
	result      recoveryBlock
	err         error
	done        chan struct{}
}

func runRecoveryBlockPipeline(
	ctx context.Context,
	audio io.ReaderAt,
	cursor, total int64,
	concurrency int,
	transcribe func(ctx context.Context, cursor, end int64) (recoveryBlock, error),
	commit func(context.Context, recoveryBlock) error,
) error {
	for cursor < total {
		next, err := runRecoveryBlockPass(ctx, audio, cursor, total, concurrency, transcribe, commit)
		if err != nil {
			return err
		}
		cursor = next
	}
	return nil
}

// One pass plans blocks ahead from cursor and commits them in planning order.
// It ends when the source is exhausted or when a committed block ends before
// its planned boundary: the blocks planned after it no longer start at the
// persisted cursor, so they are discarded and planning resumes from the
// shortened end.
func runRecoveryBlockPass(
	ctx context.Context,
	audio io.ReaderAt,
	cursor, total int64,
	concurrency int,
	transcribe func(ctx context.Context, cursor, end int64) (recoveryBlock, error),
	commit func(context.Context, recoveryBlock) error,
) (int64, error) {
	limit := max(1, concurrency)
	// Serial recovery has no overlap to gain from dispatching ahead. Keeping it
	// synchronous also prevents a failed block from starting another provider call.
	if limit == 1 {
		_, _, end, err := readRecoveryBlock(audio, cursor, total)
		if err != nil {
			return cursor, err
		}
		block, err := transcribe(ctx, cursor, end)
		if err != nil {
			return cursor, err
		}
		if block.Start != cursor || block.End <= cursor || block.End > end {
			return cursor, errRecoveryBlockDiscontinuous
		}
		if err := commit(ctx, block); err != nil {
			return cursor, err
		}
		return block.End, nil
	}
	ctx, cancel := context.WithCancel(ctx)
	ordered := make(chan *pipelineBlock, limit+1)
	work := make(chan *pipelineBlock)
	var workers sync.WaitGroup
	defer func() {
		cancel()
		workers.Wait()
	}()
	for range limit {
		workers.Go(func() {
			for block := range work {
				block.result, block.err = transcribe(ctx, block.cursor, block.end)
				close(block.done)
			}
		})
	}
	planned := make(chan error, 1)
	go func() {
		defer close(work)
		defer close(ordered)
		for at := cursor; at < total && ctx.Err() == nil; {
			_, _, end, err := readRecoveryBlock(audio, at, total)
			if err != nil {
				planned <- err
				return
			}
			block := &pipelineBlock{cursor: at, end: end, done: make(chan struct{})}
			select {
			case ordered <- block:
			case <-ctx.Done():
				return
			}
			select {
			case work <- block:
			case <-ctx.Done():
				return
			}
			at = end
		}
		planned <- nil
	}()
	for block := range ordered {
		select {
		case <-block.done:
		case <-ctx.Done():
			return cursor, ctx.Err()
		}
		if block.err != nil {
			return cursor, block.err
		}
		if block.result.Start != block.cursor || block.result.End <= block.cursor || block.result.End > block.end {
			return cursor, errRecoveryBlockDiscontinuous
		}
		if err := commit(ctx, block.result); err != nil {
			return cursor, err
		}
		cursor = block.result.End
		if cursor != block.end {
			return cursor, nil
		}
	}
	select {
	case err := <-planned:
		return cursor, err
	case <-ctx.Done():
		return cursor, ctx.Err()
	}
}

// At most 57 seconds of PCM is resident, including two seconds of overlap.
// Prefer a sustained quiet interval so an utterance is not cut in the middle.
func readRecoveryBlock(reader io.ReaderAt, cursor, total int64) ([]byte, int64, int64, error) {
	readStart := max(int64(0), cursor-2000)
	end := min(total, cursor+55000)
	pcm := make([]byte, (end-readStart)*32)
	n, err := reader.ReadAt(pcm, readStart*32)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, 0, 0, err
	}
	if n == 0 || n%2 != 0 || int64(n)+64*32 < int64(len(pcm)) {
		return nil, 0, 0, errors.New("recovery audio duration mismatch")
	}
	pcm = pcm[:n]
	if end < total {
		quiet := 0
		for offset := int((cursor + 30000 - readStart) * 32); offset+1 < len(pcm); offset += 2 {
			sample := int16(binary.LittleEndian.Uint16(pcm[offset : offset+2]))
			if sample >= -192 && sample <= 192 {
				quiet++
			} else {
				quiet = 0
			}
			if quiet >= 4800 {
				end = readStart + int64(offset+2)/32
				pcm = pcm[:(end-readStart)*32]
				break
			}
		}
	}
	return pcm, readStart, end, nil
}

func (s *Service) publishRecoveredTranscript(ctx context.Context, captureID, accountID string, plan []recoveryRange, blocks []recoveryBlock) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	capture, err := q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: pgtype.Text{String: accountID, Valid: true}})
	if err != nil {
		return err
	}
	if _, err = q.LockVoiceSession(ctx, capture.VoiceSessionID.String); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", captureID); err != nil {
		return err
	}
	// MarkVoiceTranscriptRecovered below requires the progress to have reached
	// the source duration, which is fixed once the recovery is queued.
	total := capture.TranscriptRecoveryTotalMs.Int64
	cursor := total
	if err := validateRecoveryPlanBlocks(plan, blocks, cursor); err != nil {
		return err
	}
	ranges, err := q.ListCaptureMediaRangesForCapture(ctx, captureID)
	if err != nil {
		return err
	}

	old, err := q.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: captureID, StartOffsetMs: 0, EndOffsetMs: 1 << 62})
	if err != nil {
		return err
	}
	var anchors []voicetranscription.StreamingResult
	if !(len(plan) == 1 && plan[0].Start == 0 && plan[0].End == total) {
		for _, segment := range old {
			for _, window := range sourceRecoveryRanges([]recoveryRange{{segment.StartOffsetMs, segment.EndOffsetMs}}, ranges, capture.TranscriptStartOffsetMs.Int64) {
				anchors = append(anchors, voicetranscription.StreamingResult{Text: segment.Text, StartMS: window.Start, EndMS: window.End, SpeakerID: segment.SpeakerID.String})
			}
		}
	}
	recovered, err := mergePlannedRecoveryBlocks(plan, blocks, anchors)
	if err != nil {
		return err
	}
	// Touched segments are superseded by the recovered ones; the rest stay.
	var preservedSpeech []string
	for _, segment := range old {
		windows := sourceRecoveryRanges([]recoveryRange{{segment.StartOffsetMs, segment.EndOffsetMs}}, ranges, capture.TranscriptStartOffsetMs.Int64)
		touched := false
		for _, window := range windows {
			for _, span := range plan {
				if window.Start < span.End && window.End > span.Start {
					touched = true
				}
			}
		}
		if !touched {
			preservedSpeech = append(preservedSpeech, segment.ID)
		}
	}
	if err = q.SupersedeVoiceRecoverySpeech(ctx, store.SupersedeVoiceRecoverySpeechParams{CaptureSessionID: captureID, PreservedIds: preservedSpeech}); err != nil {
		return err
	}
	for index, segment := range recovered {
		start := recoveryWallOffset(ranges, capture.TranscriptStartOffsetMs.Int64, segment.StartMS, true)
		end := recoveryWallOffset(ranges, capture.TranscriptStartOffsetMs.Int64, segment.EndMS, false)
		normalized := s.normalizeTranscript(segment.Text)
		if !recoveredTranscriptInsertable(segment.Text, normalized, start, end) {
			continue
		}
		id := stableID("recovered_voice", captureID, fmt.Sprint(index))
		if err = q.InsertRecoveredVoiceTranscriptSegment(ctx, store.InsertRecoveredVoiceTranscriptSegmentParams{ID: id, CaptureSessionID: captureID, StartOffsetMs: start, EndOffsetMs: end, Text: segment.Text, NormalizedText: normalized, SpeakerID: pgtype.Text{String: segment.SpeakerID, Valid: strings.TrimSpace(segment.SpeakerID) != ""}}); err != nil {
			return err
		}
	}
	end := recoveryWallOffset(ranges, capture.TranscriptStartOffsetMs.Int64, cursor, false)
	// A stopped recovery may end with missing media. Keep accepted speech in
	// that disclosed gap visible even though archive audio ends before it.
	for _, span := range ranges {
		if span.Kind == "gap" {
			end = max(end, capture.TranscriptStartOffsetMs.Int64+span.EndOffsetMs)
		}
	}
	if _, err = q.MarkVoiceTranscriptRecovered(ctx, store.MarkVoiceTranscriptRecoveredParams{CaptureSessionID: captureID, EndOffsetMs: end}); err != nil {
		return err
	}
	if err = q.SetVoiceRecoveredCoverage(ctx, store.SetVoiceRecoveredCoverageParams{SessionID: captureID, StartOffsetMs: capture.TranscriptStartOffsetMs.Int64, EndOffsetMs: end}); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE voice_transcript_uncertainties SET recovered_at=clock_timestamp() WHERE capture_session_id=$1 AND recovered_at IS NULL", captureID); err != nil {
		return err
	}
	if err = roomevent.AppendCaptureSessionChanged(ctx, q, capture.TenantID, capture.RoomID, capture.CreatedByActorID, captureID, "recovering"); err != nil {
		return err
	}
	// The recovered capture can materialize.
	if err = enqueue(ctx, tx, CaptureMaterializeArgs{CaptureSessionID: captureID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Live ingest also refuses punctuation-only windows. Inserting them fails the
// CHECK on normalized_text and rolls the whole recovered publish back.
func recoveredTranscriptInsertable(text, normalized string, start, end int64) bool {
	return end > start && strings.TrimSpace(text) != "" && normalized != ""
}

// Archive audio omits media gaps. At a splice, a start belongs to the next
// media range while an end belongs to the previous range. Using the same side
// for both moves post-gap speech ahead of speech accepted inside the gap.
func recoveryWallOffset(ranges []store.CaptureMediaRange, origin, offset int64, isStart bool) int64 {
	remaining, last := offset, int64(0)
	for _, span := range ranges {
		if span.Kind != "media" {
			continue
		}
		length := span.EndOffsetMs - span.StartOffsetMs
		last = span.EndOffsetMs
		if remaining < length || (!isStart && remaining == length) {
			return origin + span.StartOffsetMs + remaining
		}
		remaining -= length
	}
	return origin + last
}

func mergeRecoverySegments(existing, incoming []voicetranscription.StreamingResult, boundary int64) ([]voicetranscription.StreamingResult, error) {
	existing = slices.Clone(existing)
	incoming = remapRecoverySpeakers(existing, incoming, boundary)
	for _, next := range incoming {
		if len(next.Words) > 0 {
			if _, valid := recoveryWordCharacters(next); !valid {
				return nil, voicetranscription.ErrInvalidProviderResponse
			}
		}
		nextStart, nextEnd := recoverySegmentBounds(next)
		if nextEnd <= boundary {
			continue
		}
		if len(existing) > 0 && nextStart < boundary {
			first := len(existing)
			for first > 0 {
				_, previousEnd := recoverySegmentBounds(existing[first-1])
				if previousEnd <= nextStart {
					break
				}
				first--
			}
			if first < len(existing) {
				if recoveryOverlapHasSpeakerConflict(existing[first:], next.SpeakerID) {
					last := existing[len(existing)-1]
					_, lastEnd := recoverySegmentBounds(last)
					if nextStart < lastEnd && recoverySpeakerConflict(last.SpeakerID, next.SpeakerID) {
						clipped, ok := clipRecoverySegmentStart(next, lastEnd)
						if !ok {
							continue
						}
						next = clipped
					}
					existing = append(existing, next)
					continue
				}
				prior := joinRecoverySegments(existing[first:])
				if len(prior.Words) > 0 && len(next.Words) > 0 {
					// Sentence envelopes include trailing/leading silence. Complete,
					// strictly disjoint word ranges need no shared speech anchor.
					if _, valid := recoveryWordCharacters(prior); valid && prior.Words[len(prior.Words)-1].EndMS < next.Words[0].StartMS {
						existing[len(existing)-1].EndMS = prior.Words[len(prior.Words)-1].EndMS
						next.StartMS = next.Words[0].StartMS
						existing = append(existing, next)
						continue
					}
					merged, ok := mergeRecoveryWords(prior, next, boundary)
					if !ok {
						return nil, errors.Join(voicetranscription.ErrInvalidProviderResponse, errRecoverySpliceConflict)
					}
					existing = append(existing[:first], merged)
					continue
				}
				text, ok := trimRecoveryLegacyText(prior.Text, next.Text)
				if !ok {
					return nil, errors.Join(voicetranscription.ErrInvalidProviderResponse, errRecoveryWordTimingRequired, errRecoverySpliceConflict)
				}
				prior.Text, prior.EndMS, prior.Words = text, max(prior.EndMS, next.EndMS), nil
				prior.SpeakerID = coalesceRecoverySpeaker(prior.SpeakerID, next.SpeakerID)
				existing = append(existing[:first], prior)
				continue
			}
		}
		existing = append(existing, next)
	}
	return existing, nil
}

func recoverySegmentBounds(segment voicetranscription.StreamingResult) (int64, int64) {
	start, end := segment.StartMS, segment.EndMS
	if len(segment.Words) > 0 {
		start = min(start, segment.Words[0].StartMS)
		end = max(end, segment.Words[len(segment.Words)-1].EndMS)
	}
	return start, end
}

func offsetRecoverySegments(segments []voicetranscription.StreamingResult, readStart, end int64) {
	for i := range segments {
		segments[i].StartMS += readStart
		segments[i].EndMS = min(end, segments[i].EndMS+readStart)
		for j := range segments[i].Words {
			segments[i].Words[j].StartMS += readStart
			segments[i].Words[j].EndMS += readStart
		}
	}
}
