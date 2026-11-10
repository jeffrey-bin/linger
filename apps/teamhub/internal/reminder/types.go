package reminder

import (
	"errors"
	"fmt"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

const (
	maxNameRunes        = 120
	maxPromptRunes      = 50000
	maxRemindersPerRoom = 50
	// maxPendingOncePerRoom bounds the one-shot checks an Agent can line up.
	maxPendingOncePerRoom = 20
	defaultListLimit      = 50
	maxListLimit          = 100
)

var (
	ErrNotFound            = errors.New("reminder resource not found")
	ErrInvalid             = errors.New("reminder command is invalid")
	ErrConflict            = errors.New("reminder state conflict")
	ErrForbidden           = errors.New("reminder capability forbidden")
	ErrIdempotencyConflict = errors.New("reminder idempotency key reused")
	ErrLimitReached        = errors.New("room reminder limit reached")
	ErrMentionInvalid      = fmt.Errorf("%w: mention", ErrInvalid)
	// ErrPendingOnceLimit is the limit on one-shot Routines still waiting to fire.
	ErrPendingOnceLimit = fmt.Errorf("%w: pending one-shot", ErrLimitReached)
	// ErrTemplateAgentUnavailable is a template copy whose Agent is not active,
	// so the copy cannot run or be enabled now.
	ErrTemplateAgentUnavailable = fmt.Errorf("%w: template Agent unavailable", ErrConflict)
	// ErrAppListener is a change other than pause or resume to an app listener
	// Routine. Its install sweep would put a deleted one back, so it goes only
	// when the Human revokes AnotherMe's access to the app.
	ErrAppListener = errors.New("an app listener Routine can only be paused or resumed")
)

type Schedule struct {
	Kind          string
	Time          string
	Timezone      string
	Weekdays      []string
	IntervalHours *int
	// RunAt is the one moment a "once" Routine fires.
	RunAt *time.Time
}

type Authority struct {
	TenantID  string
	RoomID    string
	ActorID   string
	Principal *agentcredential.Principal
}

type Cadence struct {
	Kind          string     `json:"kind"`
	Timezone      string     `json:"timezone"`
	Hour          *int       `json:"hour,omitempty"`
	Minute        *int       `json:"minute,omitempty"`
	Weekdays      []string   `json:"weekdays,omitempty"`
	IntervalHours *int       `json:"interval_hours,omitempty"`
	RunAt         *time.Time `json:"run_at,omitempty"`
}

// Reminder is a Routine: it runs on Cadence, or, as an app listener, it has
// Listener instead.
type Reminder struct {
	ID               string     `json:"id"`
	RoomID           string     `json:"room_id"`
	CreatedByActorID string     `json:"created_by_actor_id"`
	Name             string     `json:"name"`
	Instruction      string     `json:"instruction"`
	MentionActorID   *string    `json:"mention_actor_id,omitempty"`
	Cadence          Cadence    `json:"cadence"`
	Listener         *Listener  `json:"listener,omitempty"`
	Enabled          bool       `json:"enabled"`
	NextRunAt        *time.Time `json:"next_run_at,omitempty"`
	TrackingItemID   *string    `json:"tracking_item_id,omitempty"`
	Revision         int64      `json:"revision"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

// Listener names the connected app an app listener Routine listens to.
type Listener struct {
	// App is the connection provider: gmail, outlook, google_calendar, slack.
	App string `json:"app"`
}

type CreateInput struct {
	Name           string
	Instruction    string
	MentionActorID *string
	Cadence        Cadence
	Enabled        *bool
	// TrackingItemID ties an Agent Routine to a Tracking Item of the Human it
	// represents; Purpose says what the Routine does for that item.
	TrackingItemID  string
	TrackingPurpose string
}

type UpdateInput struct {
	// ExpectedRevision 0 takes the current revision.
	ExpectedRevision int64
	Name             *string
	Instruction      *string
	MentionActorID   **string
	Cadence          *Cadence
	Enabled          *bool
}

type Page struct {
	Items      []Reminder
	HasMore    bool
	NextCursor string
}

// Result is a Routine write.
type Result struct {
	Value  Reminder
	Status int
	Replay bool
}

type ScheduleResult struct {
	ReminderID     string
	MessageID      string
	ScheduledFor   time.Time
	NextRunAt      time.Time
	RoomID         string
	RoomSeq        int64
	MentionDropped bool
}
