package transport

import (
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// BoundToolOutput bounds the display copy before the ledger assigns its sequence.
// It leaves provider execution and already persisted replay events untouched.
func BoundToolOutput(event protocol.Event) (protocol.Event, error) {
	if event.Type != protocol.EventOperationEvent {
		return event, nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return event, err
	}
	var kind, output string
	if json.Unmarshal(payload["type"], &kind) != nil || kind != "tool.returned" || len(payload["output"]) == 0 || payload["output"][0] != '"' || json.Unmarshal(payload["output"], &output) != nil {
		return event, nil //nolint:nilerr // a non tool.returned event passes through unchanged
	}

	// Measure the same envelope used by Send, including JSON escaping and all
	// identity metadata. Reserve the largest sequence so later ledger assignment
	// cannot turn a persistable event into an oversized frame.
	probe := event
	probe.Sequence = ^uint64(0)
	payload["output"] = json.RawMessage(`""`)
	var err error
	probe.Payload, err = json.Marshal(payload)
	if err != nil {
		return event, err
	}
	wire, err := replyFrame(probe)
	if err != nil {
		return event, err
	}
	emptyFrame, err := json.Marshal(wire)
	if err != nil {
		return event, err
	}
	encodedOutput, err := json.Marshal(output)
	if err != nil {
		return event, err
	}
	if len(emptyFrame)+len(encodedOutput)-2 <= MaxFrameBytes {
		return event, nil
	}

	marker := fmt.Sprintf("\n[Tool output truncated for display: original UTF-8 size %d bytes; Runner Gateway frame limit 4 MiB.]", len(output))
	encodedMarker, _ := json.Marshal(marker)
	// Each encoded string has two quotes; the final output has only one pair.
	prefixBudget := MaxFrameBytes - len(emptyFrame) - len(encodedMarker) + 4
	if prefixBudget < 2 {
		return event, errors.New("tool result metadata exceeds Runner Gateway frame limit")
	}
	prefixEnd := func(index int) int {
		for index > 0 && index < len(output) && !utf8.RuneStart(output[index]) {
			index--
		}
		return index
	}
	low, high := 0, min(len(output), prefixBudget)
	for low < high {
		mid := low + (high-low+1)/2
		encoded, _ := json.Marshal(output[:prefixEnd(mid)])
		if len(encoded) <= prefixBudget {
			low = mid
		} else {
			high = mid - 1
		}
	}
	payload["output"], err = json.Marshal(output[:prefixEnd(low)] + marker)
	if err != nil {
		return event, err
	}
	event.Payload, err = json.Marshal(payload)
	return event, err
}
