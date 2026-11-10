package messagecreation

// Room notices are the short lines a Room timeline shows when an Agent creates
// an Agent, someone adds a member, or an Agent's identity changes through the
// Agent CLI. A notice is a room_notice Message: Humans see it, Agent reads
// list Message kinds explicitly and never see it, and it wakes no one.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// noticeActorRef is the public ActorRef a notice names; display names are taken
// when the notice is written.
type noticeActorRef struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

func noticeRefOf(actor store.Actor) *noticeActorRef {
	return &noticeActorRef{ID: actor.ID, TenantID: actor.TenantID, Kind: actor.Kind, DisplayName: actor.DisplayName}
}

// FieldChange is a name or description before and after an identity change.
type FieldChange struct {
	Field  string `json:"field"`
	Before string `json:"before"`
	After  string `json:"after"`
}

// Notice is one structured line, in the public MessageNotice shape.
type Notice struct {
	Type                string          `json:"type"`
	Agent               *noticeActorRef `json:"agent,omitempty"`
	ApprovedBy          *noticeActorRef `json:"approved_by,omitempty"`
	Member              *noticeActorRef `json:"member,omitempty"`
	Initialized         *bool           `json:"initialized,omitempty"`
	Changes             *[]FieldChange  `json:"changes,omitempty"`
	InstructionsChanged *bool           `json:"instructions_changed,omitempty"`
}

// AgentCreated announces an Agent the author created. Without approvedBy it
// joined this Room; with it, it was created after that Human's approval and
// joined no Room.
func AgentCreated(agent store.Actor, approvedBy *store.Actor) Notice {
	notice := Notice{Type: "agent_created", Agent: noticeRefOf(agent)}
	if approvedBy != nil {
		notice.ApprovedBy = noticeRefOf(*approvedBy)
	}
	return notice
}

// MemberAdded announces a Human or Agent the author added to the Room.
func MemberAdded(member store.Actor) Notice {
	return Notice{Type: "member_added", Member: noticeRefOf(member)}
}

// AgentProfileChanged announces an identity change of agent, named as it is
// after the change. changes holds only the name and description that changed;
// the instruction text itself is never part of a notice.
func AgentProfileChanged(agent store.Actor, initialized bool, changes []FieldChange, instructionsChanged bool) Notice {
	if changes == nil {
		changes = []FieldChange{}
	}
	return Notice{
		Type: "agent_profile_changed", Agent: noticeRefOf(agent), Initialized: &initialized,
		Changes: &changes, InstructionsChanged: &instructionsChanged,
	}
}

// Empty reports an identity change notice with nothing to announce.
func (n Notice) Empty() bool {
	return n.Type == "agent_profile_changed" && (n.Changes == nil || len(*n.Changes) == 0) &&
		(n.InstructionsChanged == nil || !*n.InstructionsChanged)
}

// Text is the plain-text line clients without notice support show.
func (n Notice) Text(author store.Actor) string {
	switch n.Type {
	case "agent_created":
		if n.ApprovedBy != nil {
			return author.DisplayName + " created " + n.Agent.DisplayName + " after " + n.ApprovedBy.DisplayName + " approved it."
		}
		return author.DisplayName + " created " + n.Agent.DisplayName + " and added it to this Room."
	case "member_added":
		return author.DisplayName + " added " + n.Member.DisplayName + " to this Room."
	}
	before := n.Agent.DisplayName
	fields := make([]string, 0, 3)
	var changes []FieldChange
	if n.Changes != nil {
		changes = *n.Changes
	}
	for _, change := range changes {
		if change.Field == "name" {
			before = change.Before
		}
		fields = append(fields, change.Field)
	}
	if n.InstructionsChanged != nil && *n.InstructionsChanged {
		fields = append(fields, "instructions")
	}
	if n.Initialized != nil && *n.Initialized {
		if author.ID == n.Agent.ID {
			return before + " set up its identity as " + n.Agent.DisplayName + "."
		}
		return author.DisplayName + " set up " + before + " as " + n.Agent.DisplayName + "."
	}
	return author.DisplayName + " updated " + n.Agent.DisplayName + ": " + strings.Join(fields, ", ") + "."
}

// CreateNotice writes and publishes the notice in the caller's transaction. A Room
// whose deletion has started takes no notice, so a retried job never fails on
// it; the result is then empty.
func CreateNotice(ctx context.Context, queries *store.Queries, tenantID, roomID string, author store.Actor, notice Notice) (Result, error) {
	if notice.Empty() {
		return Result{}, nil
	}
	if _, err := queries.GetActiveRoomForMutation(ctx, roomID); errors.Is(err, pgx.ErrNoRows) {
		return Result{}, nil
	} else if err != nil {
		return Result{}, err
	}
	encoded, err := json.Marshal(notice)
	if err != nil {
		return Result{}, err
	}
	text := notice.Text(author)
	return Create(ctx, queries, Draft{
		TenantID: tenantID, RoomID: roomID, Author: author, Kind: "room_notice",
		Validated: true, Mentions: []store.Actor{}, Notice: encoded,
		Content: Content{RawMessage: text, Segments: []Segment{{Type: "text", Content: text}}},
	})
}
