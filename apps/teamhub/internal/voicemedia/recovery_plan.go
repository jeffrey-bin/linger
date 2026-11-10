package voicemedia

import (
	"context"
	"errors"
	"slices"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// Source offsets omit media gaps; persisted transcript offsets use the voice
// clock. Each recovery run plans before its first provider call.
type recoveryRange struct {
	Start int64
	End   int64
}

var errRecoveryLocalizedBoundary = errors.New("localized recovery boundary needs full archive evidence")

func mergeRecoveryRanges(input []recoveryRange) []recoveryRange {
	ranges := slices.Clone(input)
	slices.SortFunc(ranges, func(a, b recoveryRange) int {
		if a.Start < b.Start {
			return -1
		}
		if a.Start > b.Start {
			return 1
		}
		return 0
	})
	out := make([]recoveryRange, 0, len(ranges))
	for _, span := range ranges {
		if span.End <= span.Start {
			continue
		}
		if len(out) > 0 && span.Start <= out[len(out)-1].End {
			out[len(out)-1].End = max(out[len(out)-1].End, span.End)
		} else {
			out = append(out, span)
		}
	}
	return out
}

func sourceRecoveryRanges(wall []recoveryRange, media []store.CaptureMediaRange, origin int64) []recoveryRange {
	var out []recoveryRange
	var offset int64
	for _, span := range media {
		if span.Kind != "media" {
			continue
		}
		for _, window := range wall {
			start, end := max(window.Start, origin+span.StartOffsetMs), min(window.End, origin+span.EndOffsetMs)
			if start < end {
				out = append(out, recoveryRange{offset + start - origin - span.StartOffsetMs, offset + end - origin - span.StartOffsetMs})
			}
		}
		offset += span.EndOffsetMs - span.StartOffsetMs
	}
	return mergeRecoveryRanges(out)
}

func planTranscriptRecovery(total, origin int64, media []store.CaptureMediaRange, coverage []store.CaptureTranscriptCoverage, uncertain []store.VoiceTranscriptUncertainty, speech []store.VoiceTranscriptSegment, full bool) []recoveryRange {
	if full || len(media) == 0 {
		return []recoveryRange{{0, total}}
	}
	var known, holes []recoveryRange
	for _, row := range coverage {
		known = append(known, recoveryRange{row.StartOffsetMs, row.EndOffsetMs})
	}
	known = mergeRecoveryRanges(known)
	for _, span := range media {
		if span.Kind != "media" {
			continue
		}
		cursor, end := origin+span.StartOffsetMs, origin+span.EndOffsetMs
		for _, good := range known {
			if good.End <= cursor || good.Start >= end {
				continue
			}
			if good.Start > cursor {
				holes = append(holes, recoveryRange{cursor, min(end, good.Start)})
			}
			cursor = max(cursor, min(end, good.End))
		}
		if cursor < end {
			holes = append(holes, recoveryRange{cursor, end})
		}
	}
	for _, row := range uncertain {
		if !row.RecoveredAt.Valid {
			holes = append(holes, recoveryRange{row.StartOffsetMs, row.EndOffsetMs})
		}
	}
	ranges := sourceRecoveryRanges(holes, media, origin)
	for i := range ranges {
		ranges[i].Start = max(int64(0), ranges[i].Start-2000)
		ranges[i].End = min(total, ranges[i].End+2000)
	}
	ranges = mergeRecoveryRanges(ranges)
	// Replace entire accepted utterances at a repair boundary. Never delete a
	// sentence merely because one word overlaps the uncertain interval.
	for {
		changed := false
		for _, segment := range speech {
			windows := sourceRecoveryRanges([]recoveryRange{{segment.StartOffsetMs, segment.EndOffsetMs}}, media, origin)
			for i := range ranges {
				for _, window := range windows {
					if window.Start < ranges[i].End && window.End > ranges[i].Start {
						start, end := max(int64(0), min(ranges[i].Start, window.Start)), min(total, max(ranges[i].End, window.End))
						if start != ranges[i].Start || end != ranges[i].End {
							ranges[i] = recoveryRange{start, end}
							changed = true
						}
					}
				}
			}
		}
		ranges = mergeRecoveryRanges(ranges)
		if !changed {
			return ranges
		}
	}
}

// planCaptureRecovery plans the source spans to transcribe again. The plan's
// inputs stop changing once the Capture recovers, so every run computes the
// same plan.
func (s *Service) planCaptureRecovery(ctx context.Context, capture store.CaptureSession, total int64) ([]recoveryRange, error) {
	media, err := s.queries.ListCaptureMediaRangesForCapture(ctx, capture.ID)
	if err != nil {
		return nil, err
	}
	coverage, err := s.queries.ListVoiceRecoveryCoverage(ctx, capture.ID)
	if err != nil {
		return nil, err
	}
	uncertain, err := s.queries.ListVoiceTranscriptUncertainties(ctx, capture.ID)
	if err != nil {
		return nil, err
	}
	speech, err := s.queries.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, EndOffsetMs: 1 << 62})
	if err != nil {
		return nil, err
	}
	full := capture.TranscriptIntegrityLost && len(uncertain) == 0
	plan := planTranscriptRecovery(total, capture.TranscriptStartOffsetMs.Int64, media, coverage, uncertain, speech, full)
	var end int64
	for _, span := range plan {
		if span.Start < end || span.End <= span.Start || span.End > total {
			return nil, errRecoveryBlockDiscontinuous
		}
		end = span.End
	}
	return plan, nil
}

// Clip only at real word boundaries. A crossing/untimed utterance requires
// the full archive fallback; fabricating word timings would silently lose text.
func clipLocalizedRecovery(segments []voicetranscription.StreamingResult, start int64) ([]voicetranscription.StreamingResult, error) {
	var out []voicetranscription.StreamingResult
	for _, segment := range segments {
		if segment.EndMS <= start {
			continue
		}
		if segment.StartMS >= start {
			out = append(out, segment)
			continue
		}
		if _, ok := recoveryWordCharacters(segment); !ok {
			return nil, errRecoveryLocalizedBoundary
		}
		first := 0
		for first < len(segment.Words) && segment.Words[first].EndMS <= start {
			first++
		}
		if first == len(segment.Words) {
			continue
		}
		if segment.Words[first].StartMS < start {
			return nil, errRecoveryLocalizedBoundary
		}
		words := slices.Clone(segment.Words[first:])
		textStart := words[0].TextStart
		segment.Text = segment.Text[textStart:]
		for i := range words {
			words[i].TextStart -= textStart
			words[i].TextEnd -= textStart
		}
		segment.Words = words
		segment.StartMS = words[0].StartMS
		out = append(out, segment)
	}
	return out, nil
}

func mergePlannedRecoveryBlocks(plan []recoveryRange, blocks []recoveryBlock, anchors []voicetranscription.StreamingResult) ([]voicetranscription.StreamingResult, error) {
	var out []voicetranscription.StreamingResult
	for _, span := range plan {
		var local []recoveryBlock
		for _, block := range blocks {
			if block.Start >= span.Start && block.End <= span.End {
				local = append(local, block)
			}
		}
		merged, err := mergeRecoveryBlocks(nil, local)
		if err != nil {
			return nil, err
		}
		if len(anchors) > 0 {
			merged = remapRecoverySpeakers(anchors, merged, span.Start)
		}
		if span.Start > 0 {
			merged, err = clipLocalizedRecovery(merged, span.Start)
			if err != nil {
				return nil, err
			}
		}
		out = append(out, merged...)
		anchors = append(anchors, merged...)
	}
	return out, nil
}

func validateRecoveryPlanBlocks(plan []recoveryRange, blocks []recoveryBlock, cursor int64) error {
	i := 0
	for _, span := range plan {
		at := span.Start
		for i < len(blocks) && blocks[i].Start < span.End {
			block := blocks[i]
			if block.Start != at || block.End > span.End {
				return errRecoveryBlockDiscontinuous
			}
			at = block.End
			i++
		}
		if at < min(span.End, cursor) {
			return errRecoveryBlockDiscontinuous
		}
	}
	if i != len(blocks) || (len(blocks) > 0 && blocks[len(blocks)-1].End > cursor) {
		return errRecoveryBlockDiscontinuous
	}
	return nil
}
