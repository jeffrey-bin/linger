package voicemedia

import (
	"context"
	"errors"
	"io"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// recoveryBlock is one provider read of the source audio. A recovery keeps
// its blocks in memory until it publishes; a run that stops starts over. The
// JSON names are the shape of the recorded repair fixtures.
type recoveryBlock struct {
	Start    int64                                `json:"start_offset_ms"`
	End      int64                                `json:"end_offset_ms"`
	Read     int64                                `json:"read_start_ms"`
	Segments []voicetranscription.StreamingResult `json:"segments"`
}

func mergeRecoveryBlocks(prefix []voicetranscription.StreamingResult, blocks []recoveryBlock) ([]voicetranscription.StreamingResult, error) {
	result := prefix
	for _, block := range blocks {
		var err error
		result, err = mergeRecoverySegments(result, block.Segments, block.Start)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func transcribeRecoveryRange(ctx context.Context, reader io.ReaderAt, asr voicetranscription.ArchiveTranscriber, start, end int64) (recoveryBlock, error) {
	pcm, read, actualEnd, err := readRecoveryBlock(reader, start, end)
	if err != nil {
		return recoveryBlock{}, err
	}
	if actualEnd != end {
		return recoveryBlock{}, voicetranscription.ErrInvalidInput
	}
	segments, err := asr.TranscribeArchivePCM(ctx, pcm)
	if err != nil {
		return recoveryBlock{}, err
	}
	offsetRecoverySegments(segments, read, end)
	if segments == nil {
		segments = []voicetranscription.StreamingResult{}
	}
	return recoveryBlock{Start: start, End: end, Read: read, Segments: segments}, nil
}

// transcribeRecoveryShortBlock deliberately accepts a quiet-point end chosen
// by readRecoveryBlock. A provider can reject the requested window after the
// full block was already shortened at a quiet boundary; rejecting that useful
// prefix would strand recovery at the same cursor forever.
func transcribeRecoveryShortBlock(ctx context.Context, reader io.ReaderAt, asr voicetranscription.ArchiveTranscriber, start, requestedEnd, total int64) (recoveryBlock, error) {
	pcm, read, actualEnd, err := readRecoveryBlock(reader, start, min(requestedEnd, total))
	if err != nil {
		return recoveryBlock{}, err
	}
	if actualEnd <= start {
		return recoveryBlock{}, voicetranscription.ErrInvalidInput
	}
	segments, err := asr.TranscribeArchivePCM(ctx, pcm)
	if err != nil {
		return recoveryBlock{}, err
	}
	offsetRecoverySegments(segments, read, actualEnd)
	if segments == nil {
		segments = []voicetranscription.StreamingResult{}
	}
	return recoveryBlock{Start: start, End: actualEnd, Read: read, Segments: segments}, nil
}

// An utterance can contain inconsistent provider text/word normalization even
// before stitching. Shorten only this uncommitted block; the next iteration
// still reads all remaining source audio with the normal overlap.
func transcribeNextRecoveryBlock(ctx context.Context, reader io.ReaderAt, asr voicetranscription.ArchiveTranscriber, cursor, total int64) (recoveryBlock, error) {
	pcm, read, end, err := readRecoveryBlock(reader, cursor, total)
	if err != nil {
		return recoveryBlock{}, err
	}
	segments, err := asr.TranscribeArchivePCM(ctx, pcm)
	if err == nil {
		offsetRecoverySegments(segments, read, end)
		if segments == nil {
			segments = []voicetranscription.StreamingResult{}
		}
		return recoveryBlock{Start: cursor, End: end, Read: read, Segments: segments}, nil
	}
	if !errors.Is(err, voicetranscription.ErrInvalidProviderResponse) {
		return recoveryBlock{}, err
	}
	// Keep halving until the provider's minimum useful window. The previous
	// fixed 2/4/8 candidates stopped at roughly 6.8 seconds and could still
	// strand a real recording when one provider response was malformed in that
	// interval. Each accepted prefix is committed and the next iteration keeps
	// the source cursor contiguous.
	previousEnd := end
	for window := (end - cursor) / 2; ; window /= 2 {
		if window < 5000 {
			window = 5000
		}
		shortEnd := cursor + window
		if shortEnd >= previousEnd {
			if window == 5000 {
				break
			}
			continue
		}
		block, err := transcribeRecoveryShortBlock(ctx, reader, asr, cursor, shortEnd, total)
		if err == nil {
			return block, nil
		}
		if !errors.Is(err, voicetranscription.ErrInvalidProviderResponse) {
			return recoveryBlock{}, err
		}
		previousEnd = shortEnd
		if window == 5000 {
			break
		}
	}
	// The trailing audio of a range, often silence after the last utterance, can
	// keep failing the provider's timing evidence at every window. Leave its
	// first window without text instead of pausing the whole recording on it;
	// the next iteration still tries the rest. Earlier windows stay strict.
	if end == total {
		return recoveryBlock{Start: cursor, End: min(total, cursor+5000), Read: max(int64(0), cursor-2000), Segments: []voicetranscription.StreamingResult{}}, nil
	}
	return recoveryBlock{}, voicetranscription.ErrInvalidProviderResponse
}

// Re-read only the two conflicting blocks. Each candidate preserves the outer
// audio boundaries and must pass the same strict word evidence rules.
// No character timing interpolation, text clipping, or whole-recording reset.
func repairRecoveryBoundary(ctx context.Context, reader io.ReaderAt, asr voicetranscription.ArchiveTranscriber, prefix []voicetranscription.StreamingResult, left, right recoveryBlock, legacy bool) ([]recoveryBlock, error) {
	for _, ends := range recoveryRepairPlans(left.Start, left.End, right.End, legacy) {
		var blocks []recoveryBlock
		start := left.Start
		for _, end := range ends {
			block, err := transcribeRecoveryRange(ctx, reader, asr, start, end)
			if err != nil {
				if errors.Is(err, voicetranscription.ErrInvalidProviderResponse) {
					break
				}
				return nil, err
			}
			blocks = append(blocks, block)
			start = end
		}
		if len(blocks) != len(ends) {
			continue
		}
		if _, err := mergeRecoveryBlocks(prefix, blocks); err == nil {
			return blocks, nil
		}
	}
	return nil, errors.Join(voicetranscription.ErrInvalidProviderResponse, errRecoverySpliceConflict)
}

func recoveryRepairPlans(start, boundary, end int64, legacy bool) [][]int64 {
	var plans [][]int64
	if legacy {
		plans = append(plans, []int64{boundary, end})
	}
	for _, delta := range []int64{5000, -5000, 10000, -10000} {
		cut := boundary + delta
		if cut-start >= 15000 && end-cut >= 15000 && cut-start <= 55000 && end-cut <= 55000 {
			plans = append(plans, []int64{cut, end})
		}
	}
	// Two full blocks cannot move their shared boundary without exceeding the
	// provider limit. Three smaller blocks keep all audio and leave room to move.
	if end-start >= 45000 {
		plans = append(plans, []int64{start + (end-start)/3, start + 2*(end-start)/3, end})
	}
	return plans
}
