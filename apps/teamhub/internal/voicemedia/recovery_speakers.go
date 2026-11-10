package voicemedia

import (
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

const recoverySpeakerOverlapMS int64 = 2000

func remapRecoverySpeakers(prefix, incoming []voicetranscription.StreamingResult, boundary int64) []voicetranscription.StreamingResult {
	if len(incoming) == 0 {
		return incoming
	}
	overlapStart := max(int64(0), boundary-recoverySpeakerOverlapMS)
	type window struct {
		start, end int64
		id         string
	}
	prefixWindows := make([]window, 0, len(prefix))
	maxIndex := 0
	for _, segment := range prefix {
		if number := voicetranscription.SpeakerIndex(segment.SpeakerID); number > maxIndex {
			maxIndex = number
		}
		if segment.SpeakerID == "" {
			continue
		}
		start, end := recoverySegmentBounds(segment)
		if end <= overlapStart || start >= boundary {
			continue
		}
		prefixWindows = append(prefixWindows, window{start: start, end: end, id: segment.SpeakerID})
	}
	mapping := map[string]string{}
	claimed := map[string]bool{}
	for _, segment := range incoming {
		if segment.SpeakerID == "" {
			continue
		}
		if _, ok := mapping[segment.SpeakerID]; ok {
			continue
		}
		start, end := recoverySegmentBounds(segment)
		if end <= overlapStart || start >= boundary {
			continue
		}
		bestOverlap := int64(0)
		bestID := ""
		for _, previous := range prefixWindows {
			if claimed[previous.id] {
				continue
			}
			overlap := min(end, previous.end) - max(start, previous.start)
			if overlap > bestOverlap {
				bestOverlap = overlap
				bestID = previous.id
			}
		}
		if bestID != "" {
			mapping[segment.SpeakerID] = bestID
			claimed[bestID] = true
		}
	}
	assigned := map[string]string{}
	nextIndex := maxIndex
	out := make([]voicetranscription.StreamingResult, len(incoming))
	for i, segment := range incoming {
		out[i] = segment
		if segment.SpeakerID == "" {
			continue
		}
		if mapped, ok := mapping[segment.SpeakerID]; ok {
			out[i].SpeakerID = mapped
			continue
		}
		if mapped, ok := assigned[segment.SpeakerID]; ok {
			out[i].SpeakerID = mapped
			continue
		}
		nextIndex++
		id := voicetranscription.SpeakerIDFromOneBased(nextIndex)
		assigned[segment.SpeakerID] = id
		out[i].SpeakerID = id
	}
	return out
}

func coalesceRecoverySpeaker(left, right string) string {
	if left != "" {
		return left
	}
	return right
}

func recoverySpeakerConflict(left, right string) bool {
	return left != "" && right != "" && left != right
}

func recoveryOverlapHasSpeakerConflict(segments []voicetranscription.StreamingResult, extra string) bool {
	seen := extra
	for _, segment := range segments {
		if segment.SpeakerID == "" {
			continue
		}
		if seen == "" {
			seen = segment.SpeakerID
			continue
		}
		if segment.SpeakerID != seen {
			return true
		}
	}
	return false
}

func clipRecoverySegmentStart(segment voicetranscription.StreamingResult, start int64) (voicetranscription.StreamingResult, bool) {
	if segment.EndMS <= start {
		return segment, false
	}
	if segment.StartMS < start {
		segment.StartMS = start
	}
	if len(segment.Words) == 0 {
		return segment, segment.EndMS > segment.StartMS && strings.TrimSpace(segment.Text) != ""
	}
	words := make([]voicetranscription.TimedWord, 0, len(segment.Words))
	for _, word := range segment.Words {
		if word.EndMS <= start {
			continue
		}
		if word.StartMS < start {
			word.StartMS = start
		}
		words = append(words, word)
	}
	segment.Words = words
	if len(words) > 0 {
		segment.StartMS = max(segment.StartMS, words[0].StartMS)
	}
	return segment, segment.EndMS > segment.StartMS && strings.TrimSpace(segment.Text) != ""
}
