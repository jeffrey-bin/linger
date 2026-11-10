package voicemedia

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"reflect"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

type recoveryASRFunc func(context.Context, []byte) ([]voicetranscription.StreamingResult, error)

func (f recoveryASRFunc) TranscribeArchivePCM(ctx context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
	return f(ctx, pcm)
}

func TestRecoveryResegmentsExactAudioAndKeepsLastSentence(t *testing.T) {
	// Two full provider blocks force a three-block repair. Every sample carries
	// its absolute offset so the fake can reject missing/repeated input bytes.
	pcm := make([]byte, 110000*32)
	for i := 0; i < len(pcm); i += 4 {
		binary.LittleEndian.PutUint32(pcm[i:], uint32(i))
	}
	var calls int
	asr := recoveryASRFunc(func(_ context.Context, audio []byte) ([]voicetranscription.StreamingResult, error) {
		calls++
		startByte := int(binary.LittleEndian.Uint32(audio))
		if len(audio) > 57000*32 || !bytes.Equal(audio, pcm[startByte:startByte+len(audio)]) {
			t.Fatal("repair changed or exceeded source PCM")
		}
		start, end := int64(startByte/32), int64((startByte+len(audio))/32)
		// A short sentence every five seconds, including the very last second.
		var result []voicetranscription.StreamingResult
		for at := int64(4000); at < end; at += 5000 {
			if at < start || at+1000 > end {
				continue
			}
			text := "complete sentence"
			if at == 109000 {
				text = "last sentence"
			}
			result = append(result, archiveTestSegment(t, text, at-start, at+1000-start, archiveTestWord{text, at - start, at + 1000 - start}))
		}
		return result, nil
	})
	left, right := recoveryBlock{Start: 0, End: 55000}, recoveryBlock{Start: 55000, End: 110000, Read: 53000}
	blocks, err := repairRecoveryBoundary(t.Context(), bytes.NewReader(pcm), asr, nil, left, right, false)
	if err != nil || calls != 3 || len(blocks) != 3 {
		t.Fatalf("bounded repair failed: calls=%d err=%v", calls, err)
	}
	var cursor int64
	for _, b := range blocks {
		if b.Start != cursor || b.Read != max(int64(0), cursor-2000) {
			t.Fatal("repair lost source coverage")
		}
		cursor = b.End
	}
	merged, err := mergeRecoveryBlocks(nil, blocks)
	if err != nil || cursor != 110000 || len(merged) != 22 || merged[len(merged)-1].Text != "last sentence" || merged[len(merged)-1].EndMS != 110000 {
		t.Fatalf("lost/repeated sentences or tail: count=%d err=%v", len(merged), err)
	}
}

func TestRecoveryRepairRequiresAcknowledgedBlocksAndHasFiniteBudget(t *testing.T) {
	pcm := bytes.NewReader(make([]byte, 90000*32))
	left, right := recoveryBlock{End: 55000}, recoveryBlock{Start: 55000, End: 90000, Read: 53000}
	for _, failure := range []error{voicetranscription.ErrProviderTimeout, voicetranscription.ErrInvalidProviderResponse} {
		calls := 0
		asr := recoveryASRFunc(func(context.Context, []byte) ([]voicetranscription.StreamingResult, error) {
			calls++
			return nil, failure
		})
		blocks, err := repairRecoveryBoundary(t.Context(), pcm, asr, nil, left, right, false)
		if len(blocks) != 0 || !errors.Is(err, failure) || calls < 1 || calls > 5 {
			t.Fatalf("unacknowledged/invalid ASR accepted or unbounded retries: %d %v", calls, err)
		}
		if errors.Is(failure, voicetranscription.ErrProviderTimeout) && calls != 1 {
			t.Fatal("transport outage exhausted all segmentation candidates")
		}
	}
}

func TestRecoveryFailedCandidateDoesNotMutatePrefix(t *testing.T) {
	prefix := []voicetranscription.StreamingResult{{Text: "prefix", StartMS: 0, EndMS: 1000}}
	prefix = append(prefix, voicetranscription.StreamingResult{Text: "suffix", StartMS: 1000, EndMS: 2000})
	original := append([]voicetranscription.StreamingResult(nil), prefix...)
	_, err := mergeRecoveryBlocks(prefix[:1], []recoveryBlock{{Start: 1000, Segments: []voicetranscription.StreamingResult{{Text: "new", StartMS: 1000, EndMS: 1500}, {Text: "conflict", StartMS: 500, EndMS: 2000}}}})
	if err == nil || !reflect.DeepEqual(prefix, original) {
		t.Fatal("failed candidate changed the persisted prefix")
	}
}

func TestRecoveryShortensInconsistentProviderBlockWithoutSkippingAudio(t *testing.T) {
	pcm := make([]byte, 60000*32)
	for i := 0; i < len(pcm); i += 4 {
		binary.LittleEndian.PutUint32(pcm[i:], uint32(i))
	}
	var rejected, cursor int64
	asr := recoveryASRFunc(func(_ context.Context, audio []byte) ([]voicetranscription.StreamingResult, error) {
		start := int(binary.LittleEndian.Uint32(audio))
		if !bytes.Equal(audio, pcm[start:start+len(audio)]) {
			t.Fatal("short block changed PCM")
		}
		if len(audio) > 20000*32 {
			rejected++
			return nil, voicetranscription.ErrInvalidProviderResponse
		}
		return []voicetranscription.StreamingResult{archiveTestSegment(t, "complete text", 0, int64(len(audio)/32), archiveTestWord{"complete text", 0, int64(len(audio) / 32)})}, nil
	})
	for cursor < 60000 {
		block, err := transcribeNextRecoveryBlock(t.Context(), bytes.NewReader(pcm), asr, cursor, 60000)
		if err != nil || block.Start != cursor || block.Read != max(int64(0), cursor-2000) || block.End <= cursor {
			t.Fatalf("did not resume every source sample: %v", err)
		}
		cursor = block.End
	}
	if rejected == 0 || cursor != 60000 {
		t.Fatal("did not exercise invalid mapping or lost final audio")
	}
}

func TestRecoveryKeepsSplittingWhenProviderRejectsLongShortBlocks(t *testing.T) {
	pcm := make([]byte, 60000*32)
	for i := 0; i < len(pcm); i += 4 {
		binary.LittleEndian.PutUint32(pcm[i:], uint32(i))
	}
	var rejected int
	asr := recoveryASRFunc(func(_ context.Context, audio []byte) ([]voicetranscription.StreamingResult, error) {
		start := int(binary.LittleEndian.Uint32(audio))
		if !bytes.Equal(audio, pcm[start:start+len(audio)]) {
			t.Fatal("adaptive split changed PCM")
		}
		// Every block after the first carries the bounded two-second overlap.
		if len(audio) > 7500*32 {
			rejected++
			return nil, voicetranscription.ErrInvalidProviderResponse
		}
		return []voicetranscription.StreamingResult{archiveTestSegment(t, "short block confirmed", 0, int64(len(audio)/32), archiveTestWord{"short block confirmed", 0, int64(len(audio) / 32)})}, nil
	})
	var cursor int64
	for cursor < 60000 {
		block, err := transcribeNextRecoveryBlock(t.Context(), bytes.NewReader(pcm), asr, cursor, 60000)
		if err != nil || block.Start != cursor || block.End <= cursor || block.Read != max(int64(0), cursor-2000) {
			t.Fatalf("adaptive recovery stopped at %d: %v", cursor, err)
		}
		cursor = block.End
	}
	if cursor != 60000 || rejected == 0 {
		t.Fatalf("provider split was not exercised or audio was skipped: cursor=%d rejected=%d", cursor, rejected)
	}
}

func TestRecoverySkipsOnlyUnrecognizableTrailingWindows(t *testing.T) {
	pcm := make([]byte, 80000*32)
	asr := recoveryASRFunc(func(context.Context, []byte) ([]voicetranscription.StreamingResult, error) {
		return nil, voicetranscription.ErrInvalidProviderResponse
	})
	if _, err := transcribeNextRecoveryBlock(t.Context(), bytes.NewReader(pcm), asr, 0, 80000); !errors.Is(err, voicetranscription.ErrInvalidProviderResponse) {
		t.Fatalf("a block before the range end was skipped: %v", err)
	}
	cursor := int64(52000)
	for cursor < 80000 {
		block, err := transcribeNextRecoveryBlock(t.Context(), bytes.NewReader(pcm), asr, cursor, 80000)
		if err != nil || block.Start != cursor || block.End != min(80000, cursor+5000) || block.Read != cursor-2000 || len(block.Segments) != 0 {
			t.Fatalf("trailing window at %d did not advance as an empty block: %+v %v", cursor, block, err)
		}
		cursor = block.End
	}
}
