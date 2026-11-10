package reminder

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// A Routine trigger is a normalized array of 1-8 specs (OR group). The only
// installer is AnotherMe's app listener (internal/proactive), so a spec takes
// exactly the shapes it installs; the provider read is incremental and the
// remaining filter is matched locally against the normalized event.

const (
	maxListenersPerRoutine = 8
	defaultPollIntervalSec = 300
	minPollIntervalSec     = 60
)

const (
	ListenerSlack   = "slack"
	ListenerGmail   = "gmail"
	ListenerOutlook = "outlook"
	ListenerGCal    = "gcal"
)

type ListenerSpec struct {
	Type                string         `json:"type"`
	Account             string         `json:"account"`
	Channel             string         `json:"channel,omitempty"`     // slack: "*"
	Match               *ListenerMatch `json:"match,omitempty"`       // slack kind; optional gmail label
	CalendarID          string         `json:"calendar_id,omitempty"` // gcal
	Events              []string       `json:"events,omitempty"`      // gcal
	PollIntervalSeconds int            `json:"poll_interval_seconds,omitempty"`
}

type ListenerMatch struct {
	Kind    string `json:"kind,omitempty"`     // slack: mention
	LabelID string `json:"label_id,omitempty"` // gmail
}

// parseTriggerSpec validates and normalizes the routine trigger JSON array. The
// result is the canonical array stored in room_reminders.trigger.
func parseTriggerSpec(raw json.RawMessage) ([]ListenerSpec, json.RawMessage, error) {
	var specs []ListenerSpec
	if err := json.Unmarshal(raw, &specs); err != nil {
		return nil, nil, fmt.Errorf("%w: trigger must be an array", ErrInvalid)
	}
	if len(specs) == 0 {
		return nil, nil, fmt.Errorf("%w: trigger requires at least one listener", ErrInvalid)
	}
	if len(specs) > maxListenersPerRoutine {
		return nil, nil, fmt.Errorf("%w: trigger allows at most %d listeners", ErrInvalid, maxListenersPerRoutine)
	}
	for i := range specs {
		if err := normalizeListener(&specs[i]); err != nil {
			return nil, nil, fmt.Errorf("%w: listener[%d] %w", ErrInvalid, i, err)
		}
	}
	canonical, err := json.Marshal(specs)
	if err != nil {
		return nil, nil, err
	}
	return specs, canonical, nil
}

func normalizeListener(spec *ListenerSpec) error {
	spec.Type = strings.TrimSpace(spec.Type)
	spec.Account = strings.TrimSpace(spec.Account)
	if spec.Account == "" {
		return fmt.Errorf("account is required")
	}
	if spec.PollIntervalSeconds != 0 && spec.PollIntervalSeconds < minPollIntervalSec {
		return fmt.Errorf("poll_interval_seconds must be at least %d", minPollIntervalSec)
	}
	var match ListenerMatch
	if spec.Match != nil {
		match = *spec.Match
	}
	switch spec.Type {
	case ListenerSlack:
		// Mentions of the connected user in every channel it can see.
		if spec.Channel != "*" || match != (ListenerMatch{Kind: "mention"}) {
			return fmt.Errorf(`slack listeners take channel "*" and match.kind "mention"`)
		}
	case ListenerGmail:
		if match.Kind != "" {
			return fmt.Errorf("match.kind is not supported for gmail")
		}
	case ListenerOutlook:
		if match != (ListenerMatch{}) {
			return fmt.Errorf("outlook listeners take no match")
		}
	case ListenerGCal:
		if match != (ListenerMatch{}) {
			return fmt.Errorf("gcal listeners take no match")
		}
		spec.CalendarID = strings.TrimSpace(spec.CalendarID)
		if spec.CalendarID == "" {
			spec.CalendarID = "primary"
		}
		if len(spec.Events) == 0 {
			return fmt.Errorf("events is required")
		}
		for i, e := range spec.Events {
			spec.Events[i] = strings.TrimSpace(e)
			switch spec.Events[i] {
			case "created", "updated", "cancelled":
			default:
				return fmt.Errorf("events %q is not supported", e)
			}
		}
	default:
		return fmt.Errorf("type %q is not supported", spec.Type)
	}
	return nil
}

// ListenerEvent is the canonical shape every inbound source maps to before
// local matching and routing. Undelivered events wait in the poll cursor.
type ListenerEvent struct {
	Grant       *GrantReference `json:"-"`
	Source      string          `json:"source"`
	EventID     string          `json:"event_id"`
	EventKind   string          `json:"event_kind,omitempty"` // gcal: created|updated|cancelled; slack: message
	Channel     string          `json:"channel,omitempty"`
	ChannelID   string          `json:"channel_id,omitempty"`
	Sender      string          `json:"sender,omitempty"`
	Text        string          `json:"text,omitempty"`
	IsMention   bool            `json:"is_mention,omitempty"`
	From        string          `json:"from,omitempty"`
	Subject     string          `json:"subject,omitempty"`
	Snippet     string          `json:"snippet,omitempty"` // Cleaned, bounded mail body; not the provider preview.
	MessageID   string          `json:"message_id,omitempty"`
	ThreadID    string          `json:"thread_id,omitempty"`
	LabelIDs    []string        `json:"label_ids,omitempty"`
	Summary     string          `json:"summary,omitempty"`
	Start       string          `json:"start,omitempty"`
	End         string          `json:"end,omitempty"`
	To          string          `json:"to,omitempty"`
	Description string          `json:"description,omitempty"`
	Location    string          `json:"location,omitempty"`
	Organizer   string          `json:"organizer,omitempty"`
}

// MatchEvent reports whether a spec matches the normalized event locally.
// Source/type identity is established by the caller; this only applies filters.
func MatchEvent(spec ListenerSpec, event ListenerEvent) bool {
	switch spec.Type {
	case ListenerSlack:
		return event.IsMention
	case ListenerGmail:
		return spec.Match == nil || spec.Match.LabelID == "" || slices.Contains(event.LabelIDs, spec.Match.LabelID)
	case ListenerOutlook:
		return true
	case ListenerGCal:
		return slices.Contains(spec.Events, event.EventKind)
	}
	return false
}
