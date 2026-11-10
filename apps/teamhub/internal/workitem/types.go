package workitem

import (
	"errors"
	"time"
)

var (
	ErrNotFound            = errors.New("work item resource not found")
	ErrInvalid             = errors.New("invalid work item command")
	ErrConflict            = errors.New("work item state conflict")
	ErrForbidden           = errors.New("work item capability forbidden")
	ErrIdempotencyConflict = errors.New("work item idempotency key reused")
	ErrUnavailable         = errors.New("work item capability unavailable")
)

type Actor struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type Assignment struct {
	Actor      Actor     `json:"actor"`
	AssignedBy Actor     `json:"assigned_by"`
	AssignedAt time.Time `json:"assigned_at"`
}

type AccessGrant struct {
	Actor     Actor     `json:"actor"`
	GrantedBy Actor     `json:"granted_by"`
	GrantedAt time.Time `json:"granted_at"`
}

type TaskExecutionSummary struct {
	Generation             int64     `json:"generation"`
	Status                 string    `json:"status"`
	ExecutionRevision      int64     `json:"execution_revision"`
	ReasonCode             string    `json:"reason_code,omitempty"`
	DesiredControl         string    `json:"desired_control"`
	ControlRevision        int64     `json:"control_revision"`
	ControlSettledRevision int64     `json:"control_settled_revision"`
	PendingControl         bool      `json:"pending_control"`
	ControlOutcome         string    `json:"control_outcome,omitempty"`
	ExecutionUpdatedAt     time.Time `json:"execution_updated_at"`
}

type Item struct {
	ID                   string                `json:"id"`
	TenantID             string                `json:"tenant_id"`
	Number               int64                 `json:"number"`
	Kind                 string                `json:"kind"`
	Title                string                `json:"title"`
	Description          string                `json:"description"`
	ReferencedActors     []Actor               `json:"referenced_actors"`
	Priority             string                `json:"priority"`
	State                string                `json:"state"`
	Resolution           *string               `json:"resolution,omitempty"`
	Version              int64                 `json:"version"`
	CreatedBy            Actor                 `json:"created_by"`
	UpdatedBy            Actor                 `json:"updated_by"`
	Assignees            []Assignment          `json:"assignees"`
	ExplicitAccessGrants []AccessGrant         `json:"explicit_access_grants"`
	OriginRoomID         *string               `json:"origin_room_id,omitempty"`
	OriginMessageID      *string               `json:"origin_message_id,omitempty"`
	WorkRoomID           *string               `json:"work_room_id,omitempty"`
	TaskExecution        *TaskExecutionSummary `json:"task_execution,omitempty"`
	ArchivedAt           *time.Time            `json:"archived_at,omitempty"`
	CreatedAt            time.Time             `json:"created_at"`
	UpdatedAt            time.Time             `json:"updated_at"`
}

type Result[T any] struct {
	Value  T
	Replay bool
}

type Page struct {
	Items      []Item
	HasMore    bool
	NextCursor string
}

type ListFilter struct {
	Cursor          string
	Limit           int32
	Scope           string
	Kind            string
	State           string
	Priority        string
	ExecutionStatus string
	PendingControl  *bool
	AssigneeActorID string
	OriginRoomID    string
	WorkRoomID      string
	IncludeArchived bool
}

type CreateInput struct {
	Kind                string   `json:"kind"`
	Title               string   `json:"title"`
	Description         string   `json:"description"`
	ReferencedActorIDs  []string `json:"referenced_actor_ids"`
	Priority            string   `json:"priority"`
	AssigneeActorIDs    []string `json:"assignee_actor_ids"`
	AssigneeActorIDsSet bool     `json:"-"`
	OriginRoomID        string   `json:"origin_room_id,omitempty"`
}

type UpdateInput struct {
	ExpectedVersion    int64     `json:"expected_version"`
	Title              *string   `json:"title,omitempty"`
	Description        *string   `json:"description,omitempty"`
	ReferencedActorIDs *[]string `json:"referenced_actor_ids,omitempty"`
	Priority           *string   `json:"priority,omitempty"`
}

type TransitionInput struct {
	ExpectedVersion int64   `json:"expected_version"`
	State           string  `json:"state"`
	Resolution      *string `json:"resolution,omitempty"`
}

type TaskExecutionControlInput struct {
	Action                  string `json:"action"`
	ExpectedGeneration      int64  `json:"expected_generation"`
	ExpectedControlRevision int64  `json:"expected_control_revision"`
	Reason                  string `json:"reason,omitempty"`
}

type VersionInput struct {
	ExpectedVersion int64 `json:"expected_version"`
}

type CommentSegment struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	ActorID string `json:"actor_id,omitempty"`
}

type CommentInput struct {
	Body     string           `json:"body"`
	Segments []CommentSegment `json:"segments"`
}

type CommentUpdateInput struct {
	ExpectedVersion int64        `json:"expected_version"`
	Content         CommentInput `json:"content"`
}

type Comment struct {
	ID         string           `json:"id"`
	TenantID   string           `json:"tenant_id"`
	WorkItemID string           `json:"work_item_id"`
	Author     Actor            `json:"author"`
	Body       string           `json:"body"`
	Segments   []CommentSegment `json:"segments"`
	Version    int64            `json:"version"`
	DeletedAt  *time.Time       `json:"deleted_at,omitempty"`
	CreatedAt  time.Time        `json:"created_at"`
	UpdatedAt  time.Time        `json:"updated_at"`
}

type CommentPage struct {
	Items      []Comment
	HasMore    bool
	NextCursor string
}

type Activity struct {
	ID            string         `json:"id"`
	WorkItemID    string         `json:"work_item_id"`
	Kind          string         `json:"kind"`
	Actor         Actor          `json:"actor"`
	FromState     *string        `json:"from_state,omitempty"`
	ToState       *string        `json:"to_state,omitempty"`
	TargetActorID *string        `json:"target_actor_id,omitempty"`
	CommentID     *string        `json:"comment_id,omitempty"`
	RoomID        *string        `json:"room_id,omitempty"`
	Details       map[string]any `json:"details"`
	OccurredAt    time.Time      `json:"occurred_at"`
}

type TimelineEntry struct {
	Type     string
	Comment  *Comment
	Activity *Activity
}

type TimelinePage struct {
	Items      []TimelineEntry
	HasMore    bool
	NextCursor string
}
