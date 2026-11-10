package voicemedia

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
	"golang.org/x/text/unicode/norm"
)

type recoveryCharacter struct {
	value       rune
	word        int
	first, last bool
}

func recoveryNormalized(text string) []rune {
	var result []rune
	for _, r := range norm.NFKC.String(text) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			result = append(result, unicode.ToLower(r))
		}
	}
	return result
}

func recoveryWordCharacters(segment voicetranscription.StreamingResult) ([]recoveryCharacter, bool) {
	// One sentence can span many bounded archive blocks. Keep the accumulated
	// mapping bounded without imposing a single-block limit on long speech.
	if len(segment.Words) == 0 || len(segment.Words) > 64*1024 || len(segment.Text) > 1<<20 || !utf8.ValidString(segment.Text) {
		return nil, false
	}
	expected := recoveryNormalized(segment.Text)
	if len(expected) > 256*1024 {
		return nil, false
	}
	var result []recoveryCharacter
	previousText, previousTime := 0, int64(0)
	for i, word := range segment.Words {
		if word.TextStart < previousText || word.TextEnd <= word.TextStart || word.TextEnd > len(segment.Text) ||
			word.StartMS < previousTime || word.EndMS < word.StartMS || !utf8.ValidString(segment.Text[word.TextStart:word.TextEnd]) {
			return nil, false
		}
		part := recoveryNormalized(segment.Text[word.TextStart:word.TextEnd])
		for j, r := range part {
			result = append(result, recoveryCharacter{r, i, j == 0, j == len(part)-1})
		}
		previousText, previousTime = word.TextEnd, word.EndMS
	}
	if len(result) != len(expected) {
		return nil, false
	}
	for i := range result {
		if result[i].value != expected[i] {
			return nil, false
		}
	}
	return result, true
}

// Only uncommitted archive blocks are stitched here. A reliable word anchor
// selects one complete side of the overlapping audio; no character-time guess.
func mergeRecoveryWords(left, right voicetranscription.StreamingResult, boundary int64) (voicetranscription.StreamingResult, bool) {
	a, ok := recoveryWordCharacters(left)
	if !ok {
		return voicetranscription.StreamingResult{}, false
	}
	b, ok := recoveryWordCharacters(right)
	if !ok {
		return voicetranscription.StreamingResult{}, false
	}
	readStart := max(int64(0), boundary-2000)
	type anchor struct{ left, right int }
	var anchors []anchor
	rightRepeatsLeftSuffix := false
	for i, x := range a {
		lw := left.Words[x.word]
		if !x.first || lw.EndMS <= readStart || lw.StartMS >= boundary {
			continue
		}
		for j, y := range b {
			rw := right.Words[y.word]
			if !y.first || rw.EndMS <= readStart || rw.StartMS >= boundary || lw.StartMS >= rw.EndMS || rw.StartMS >= lw.EndMS {
				continue
			}
			length, complete := 0, 0
			for i+length < len(a) && j+length < len(b) {
				ac, bc := a[i+length], b[j+length]
				aw, bw := left.Words[ac.word], right.Words[bc.word]
				if ac.value != bc.value || aw.EndMS <= aw.StartMS || bw.EndMS <= bw.StartMS || aw.StartMS >= bw.EndMS || bw.StartMS >= aw.EndMS {
					break
				}
				length++
				if ac.last && bc.last {
					complete = length
				}
			}
			if complete < 2 {
				continue
			}
			// An anchor may not discard an incoming prefix outside the prior
			// block's evidence or introduce overlapping word times at the splice.
			if x.word > 0 && rw.StartMS < left.Words[x.word-1].EndMS {
				continue
			}
			if right.Words[0].StartMS < left.Words[0].StartMS && y.word > 0 {
				continue
			}
			for _, prior := range anchors {
				if (prior.left == i && prior.right != j) || (prior.right == j && prior.left != i) || (prior.left < i && prior.right > j) {
					return voicetranscription.StreamingResult{}, false
				}
			}
			anchors = append(anchors, anchor{i, j})
			if j == 0 && complete == len(b) && i+complete == len(a) && right.Words[len(right.Words)-1].EndMS <= boundary {
				rightRepeatsLeftSuffix = true
			}
		}
	}
	// Sentence envelopes can cross the block boundary even when all words are
	// a proven duplicate before it. Preserve the prior evidence despite word
	// end jitter, but only after every anchor has passed ambiguity checks.
	if rightRepeatsLeftSuffix {
		return left, true
	}
	if len(anchors) == 0 || right.Words[len(right.Words)-1].EndMS < left.Words[len(left.Words)-1].EndMS {
		return voicetranscription.StreamingResult{}, false
	}
	selected := anchors[0]
	lw, rw := a[selected.left].word, b[selected.right].word
	prefix, cut := left.Text[:left.Words[lw].TextStart], right.Words[rw].TextStart
	merged := right
	merged.Text, merged.StartMS = prefix+right.Text[cut:], min(left.StartMS, right.StartMS)
	merged.EndMS = max(left.EndMS, right.EndMS)
	merged.SpeakerID = coalesceRecoverySpeaker(left.SpeakerID, right.SpeakerID)
	merged.Words = append([]voicetranscription.TimedWord(nil), left.Words[:lw]...)
	for _, word := range right.Words[rw:] {
		word.TextStart += len(prefix) - cut
		word.TextEnd += len(prefix) - cut
		merged.Words = append(merged.Words, word)
	}
	if _, valid := recoveryWordCharacters(merged); !valid {
		return voicetranscription.StreamingResult{}, false
	}
	return merged, true
}

func joinRecoverySegments(segments []voicetranscription.StreamingResult) voicetranscription.StreamingResult {
	result := segments[0]
	result.Words = append([]voicetranscription.TimedWord(nil), result.Words...)
	for _, segment := range segments[1:] {
		offset := len(result.Text) + 1
		result.Text += " " + segment.Text
		result.EndMS = max(result.EndMS, segment.EndMS)
		result.SpeakerID = coalesceRecoverySpeaker(result.SpeakerID, segment.SpeakerID)
		if len(result.Words) == 0 || len(segment.Words) == 0 {
			result.Words = nil
			continue
		}
		for _, word := range segment.Words {
			word.TextStart += offset
			word.TextEnd += offset
			result.Words = append(result.Words, word)
		}
	}
	return result
}

func trimRecoveryLegacyText(left, right string) (string, bool) {
	type letter struct {
		value rune
		start int
	}
	index := func(text string) []letter {
		var out []letter
		for i, r := range text {
			if unicode.IsLetter(r) || unicode.IsNumber(r) {
				out = append(out, letter{unicode.ToLower(r), i})
			}
		}
		return out
	}
	a, b := index(left), index(right)
	for n := min(len(a), len(b)); n >= 2; n-- {
		same := true
		for i := range n {
			if a[len(a)-n+i].value != b[i].value {
				same = false
				break
			}
		}
		if same {
			return strings.TrimSpace(left[:a[len(a)-n].start] + right), true
		}
	}
	return "", false
}
