package voicetranscription

import (
	"fmt"
	"strconv"
	"strings"
)

const speakerIDPrefix = "spk_"

func SpeakerIDFromOneBased(index int) string {
	if index < 1 {
		return ""
	}
	return formatSpeakerID(index)
}

func SpeakerLabel(id string) string {
	number, ok := speakerNumber(id)
	if !ok {
		return ""
	}
	return fmt.Sprintf("Speaker %d", number)
}

func formatSpeakerID(number int) string {
	if number < 1 {
		return ""
	}
	return speakerIDPrefix + strconv.Itoa(number)
}

func SpeakerIndex(id string) int {
	number, ok := speakerNumber(id)
	if !ok {
		return 0
	}
	return number
}

func speakerNumber(id string) (int, bool) {
	id = strings.TrimSpace(id)
	if !strings.HasPrefix(id, speakerIDPrefix) {
		return 0, false
	}
	number, err := strconv.Atoi(id[len(speakerIDPrefix):])
	if err != nil || number < 1 {
		return 0, false
	}
	return number, true
}
