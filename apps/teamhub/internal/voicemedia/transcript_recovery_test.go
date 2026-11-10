package voicemedia

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestRecoveryBlocksPreserveInputAndBoundMemory(t *testing.T) {
	pcm := make([]byte, 125000*32)
	for i := 0; i < len(pcm); i += 2 {
		binary.LittleEndian.PutUint16(pcm[i:i+2], 1000)
	}
	clear(pcm[32000*32 : 33000*32])
	reader := bytes.NewReader(pcm)
	var cursor int64
	for cursor < 125000 {
		block, start, end, err := readRecoveryBlock(reader, cursor, 125000)
		if err != nil {
			t.Fatal(err)
		}
		if len(block) > 57*16000*2 || end <= cursor || start > cursor || !bytes.Equal(block, pcm[start*32:end*32]) {
			t.Fatal("block lost input or exceeded memory limit")
		}
		if cursor == 0 && (end < 32000 || end > 33000) {
			t.Fatalf("did not prefer silence: end=%d", end)
		}
		cursor = end
	}
	if cursor != 125000 {
		t.Fatalf("coverage=%d", cursor)
	}
}

func TestRecoveryMergesOverlapWithoutLosingContinuation(t *testing.T) {
	first := []voicetranscription.StreamingResult{{Text: "ヅテアィイゥ", StartMS: 53000, EndMS: 55000}}
	second := []voicetranscription.StreamingResult{{Text: "アィイゥウェヂデ。", StartMS: 53500, EndMS: 56500}, {Text: "ゲコゴ。", StartMS: 57000, EndMS: 58500}}
	result, err := mergeRecoverySegments(first, second, 55000)
	if err != nil || len(result) != 2 || result[0].Text != "ヅテアィイゥウェヂデ。" || result[0].EndMS != 56500 {
		t.Fatalf("unexpected overlap projection: %+v", result)
	}
}

func TestRecoveryCannotConcatenateAnUnconfirmedOverlap(t *testing.T) {
	old := []voicetranscription.StreamingResult{{Text: "ァアィイゥウェ，エォオカガ", StartMS: 93000, EndMS: 110000}}
	next := []voicetranscription.StreamingResult{{Text: "エォオカキギクグケゲコゴ", StartMS: 108000, EndMS: 115000}}
	if _, err := mergeRecoverySegments(old, next, 110000); !errors.Is(err, errRecoveryWordTimingRequired) {
		t.Fatal("unconfirmed archive overlap was concatenated instead of requesting reliable evidence")
	}
	if old[0].Text != "ァアィイゥウェ，エォオカガ" {
		t.Fatal("unpublished conflict changed existing text")
	}
}

func TestRecoveryOverlapPreservesUnmatchedSpeechAndDistantRepetition(t *testing.T) {
	for _, pair := range [][3]string{
		{"We ship THE release", "the release tomorrow.", "We ship the release tomorrow."},
		{"アィイゥ，ウェ", "イゥウェァトヂデ。", "アィイゥウェァトヂデ。"},
	} {
		if got, ok := trimRecoveryLegacyText(pair[0], pair[1]); !ok || got != pair[2] {
			t.Fatalf("merged=%q want=%q", got, pair[2])
		}
	}
	result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{{Text: "ドアィ", StartMS: 50000, EndMS: 51000}}, []voicetranscription.StreamingResult{{Text: "ドアィ", StartMS: 56000, EndMS: 57000}}, 55000)
	if err != nil || len(result) != 2 {
		t.Fatal("repeated speech outside the overlap was removed")
	}
}

func plannedRecoveryBlock(cursor, end int64) recoveryBlock {
	return recoveryBlock{Start: cursor, End: end, Read: max(int64(0), cursor-2000), Segments: []voicetranscription.StreamingResult{{Text: "block", StartMS: cursor + 100, EndMS: cursor + 200, Final: true}}}
}

func TestRecoveryBlockPipelineOverlapsProviderCallsAndCommitsInOrder(t *testing.T) {
	const total = 300_000
	reader := bytes.NewReader(make([]byte, total*32))
	var inFlight, peak atomic.Int32
	release := make(chan struct{})
	transcribe := func(ctx context.Context, cursor, end int64) (recoveryBlock, error) {
		current := inFlight.Add(1)
		for {
			previous := peak.Load()
			if current <= previous || peak.CompareAndSwap(previous, current) {
				break
			}
		}
		select {
		case <-release:
		case <-ctx.Done():
			return recoveryBlock{}, ctx.Err()
		}
		inFlight.Add(-1)
		return plannedRecoveryBlock(cursor, end), nil
	}
	var committed []int64
	commit := func(_ context.Context, block recoveryBlock) error {
		if len(committed) > 0 && committed[len(committed)-1] != block.Start {
			return fmt.Errorf("block %d committed after %d instead of contiguously", block.Start, committed[len(committed)-1])
		}
		if len(block.Segments) != 1 {
			return fmt.Errorf("block %d lost its provider result", block.Start)
		}
		committed = append(committed, block.End)
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- runRecoveryBlockPipeline(t.Context(), reader, 0, total, 3, transcribe, commit) }()
	deadline := time.Now().Add(5 * time.Second)
	for peak.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if peak.Load() != 3 {
		t.Fatalf("provider concurrency=%d want=3", peak.Load())
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(committed) == 0 || committed[len(committed)-1] != total {
		t.Fatalf("coverage=%v", committed)
	}
}

func TestRecoveryBlockPipelineStopsOnProviderFailure(t *testing.T) {
	reader := bytes.NewReader(make([]byte, 200_000*32))
	failure := errors.New("provider unavailable")
	// Every provider call fails, so whichever worker runs first the pipeline
	// must surface the failure for the head block and commit nothing.
	transcribe := func(context.Context, int64, int64) (recoveryBlock, error) {
		return recoveryBlock{}, failure
	}
	var committed atomic.Int32
	err := runRecoveryBlockPipeline(t.Context(), reader, 0, 200_000, 2, transcribe, func(context.Context, recoveryBlock) error {
		committed.Add(1)
		return nil
	})
	if !errors.Is(err, failure) || committed.Load() != 0 {
		t.Fatalf("err=%v committed=%d want provider failure without commits", err, committed.Load())
	}
}

func TestRecoveryBlockPipelineSerialStopsWithoutSpeculativeCall(t *testing.T) {
	reader := bytes.NewReader(make([]byte, 200_000*32))
	failure := errors.New("provider unavailable")
	var calls atomic.Int32
	err := runRecoveryBlockPipeline(t.Context(), reader, 0, 200_000, 1, func(_ context.Context, cursor, end int64) (recoveryBlock, error) {
		if calls.Add(1) == 2 {
			return recoveryBlock{}, failure
		}
		return plannedRecoveryBlock(cursor, end), nil
	}, func(context.Context, recoveryBlock) error { return nil })
	if !errors.Is(err, failure) || calls.Load() != 2 {
		t.Fatalf("err=%v calls=%d want provider failure after exactly two calls", err, calls.Load())
	}
}

func TestRecoveryBlockPipelineReplansAfterShortenedBlock(t *testing.T) {
	const total = 200_000
	reader := bytes.NewReader(make([]byte, total*32))
	var shortened atomic.Bool
	transcribe := func(_ context.Context, cursor, end int64) (recoveryBlock, error) {
		// The first provider window is inconsistent and accepted only as a
		// 10 second prefix, like the adaptive re-read does.
		if cursor == 0 && shortened.CompareAndSwap(false, true) {
			return plannedRecoveryBlock(cursor, 10_000), nil
		}
		return plannedRecoveryBlock(cursor, end), nil
	}
	var committed []recoveryBlock
	commit := func(_ context.Context, block recoveryBlock) error {
		if len(committed) > 0 && committed[len(committed)-1].End != block.Start {
			return fmt.Errorf("block %d-%d does not continue %d", block.Start, block.End, committed[len(committed)-1].End)
		}
		committed = append(committed, block)
		return nil
	}
	if err := runRecoveryBlockPipeline(t.Context(), reader, 0, total, 3, transcribe, commit); err != nil {
		t.Fatal(err)
	}
	if len(committed) < 2 || committed[0].End != 10_000 || committed[1].Start != 10_000 || committed[len(committed)-1].End != total {
		t.Fatalf("blocks planned before the shortened end were not replanned: %+v", committed)
	}
	// A block that does not continue the persisted cursor can never be committed.
	err := runRecoveryBlockPipeline(t.Context(), reader, 0, total, 1, func(_ context.Context, cursor, end int64) (recoveryBlock, error) {
		return plannedRecoveryBlock(cursor+1, end), nil
	}, commit)
	if !errors.Is(err, errRecoveryBlockDiscontinuous) {
		t.Fatalf("err=%v want discontinuous block rejection", err)
	}
}

func TestRecoveredPunctuationOnlyWindowsAreNotInsertable(t *testing.T) {
	t.Parallel()
	if !recoveredTranscriptInsertable("hey, hey", "heyhey", 1590, 3270) {
		t.Fatal("speech with remaining characters was dropped")
	}
	if recoveredTranscriptInsertable(".", "", 148264, 148324) {
		t.Fatal("punctuation-only archive window would fail normalized_text CHECK")
	}
	if recoveredTranscriptInsertable("  ", "", 100, 200) {
		t.Fatal("whitespace-only archive window was kept")
	}
	if recoveredTranscriptInsertable("uh", "uh", 100, 100) {
		t.Fatal("zero-length window was kept")
	}
}
