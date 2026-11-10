package voicemedia

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// The timing/word correspondence comes from 18 failed archive splices. Speech
// is replaced by arbitrary characters; neither user text nor audio is stored.
func TestRecoveryRealBoundaryEvidence(t *testing.T) {
	paths, err := filepath.Glob("testdata/recovery-boundaries/*.json")
	if err != nil || len(paths) != 18 {
		t.Fatal("missing regression fixtures")
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			body, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Boundary    int64 `json:"boundary"`
				WordGap     int64 `json:"word_gap_ms"`
				Left, Right voicetranscription.StreamingResult
			}
			if err := json.Unmarshal(body, &fixture); err != nil {
				t.Fatal(err)
			}
			result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{fixture.Left}, []voicetranscription.StreamingResult{fixture.Right}, fixture.Boundary)
			if fixture.WordGap > 0 {
				if err != nil || len(result) != 2 || result[0].Text != fixture.Left.Text || result[1].Text != fixture.Right.Text {
					t.Fatalf("disjoint complete words were rejected or changed: %v", err)
				}
			} else if err == nil {
				t.Fatal("unresolved overlap must request resegmentation, not discard speech")
			}
		})
	}
}

type replayRecoveryAudio struct{ read int64 }

func (r *replayRecoveryAudio) ReadAt(p []byte, offset int64) (int, error) {
	r.read = offset / 32
	clear(p)
	return len(p), nil
}

func TestRecoveryRealConflictsConvergeAfterLocalResegmentation(t *testing.T) {
	paths, err := filepath.Glob("testdata/recovery-repairs/*.json")
	if err != nil || len(paths) != 10 {
		t.Fatal("missing real repair replays")
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			body, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Left, Right recoveryBlock
				Calls       []struct {
					Read, End int64
					Rejected  bool
					Segments  []voicetranscription.StreamingResult
				}
				Replacement []recoveryBlock
			}
			if json.Unmarshal(body, &fixture) != nil {
				t.Fatal("invalid repair fixture")
			}
			if _, err := mergeRecoveryBlocks(nil, []recoveryBlock{fixture.Left, fixture.Right}); err == nil {
				t.Fatal("fixture no longer exercises a real conflict")
			}
			reader := &replayRecoveryAudio{}
			calls := 0
			asr := recoveryASRFunc(func(_ context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
				if calls >= len(fixture.Calls) {
					t.Fatal("repair exceeded recorded request budget")
				}
				call := fixture.Calls[calls]
				calls++
				if reader.read != call.Read || int64(len(pcm)/32) != call.End-call.Read {
					t.Fatal("repair read a different audio range")
				}
				if call.Rejected {
					return nil, voicetranscription.ErrInvalidProviderResponse
				}
				return call.Segments, nil
			})
			blocks, err := repairRecoveryBoundary(t.Context(), reader, asr, nil, fixture.Left, fixture.Right, false)
			if err != nil || calls != len(fixture.Calls) || !reflect.DeepEqual(blocks, fixture.Replacement) {
				t.Fatalf("actual repair no longer converges: calls=%d err=%v", calls, err)
			}
			if _, err := mergeRecoveryBlocks(nil, blocks); err != nil {
				t.Fatal("replacement still conflicts")
			}
		})
	}
}
