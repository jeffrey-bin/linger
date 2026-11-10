// Package agentauth authorizes Agent CLI business commands from the current
// Agent credential, the requested target and current resource facts, and
// records their idempotent operation receipts.
package agentauth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	ErrInvalid           = errors.New("invalid Agent command target")
	ErrCredentialInvalid = errors.New("Agent credential is invalid or expired")
	ErrForbidden         = errors.New("Agent operation is forbidden")
	// ErrTaskContextForbidden is the ErrForbidden of a command a Task's
	// AlterEgo may not run: only the Meta speaks and publishes.
	ErrTaskContextForbidden = fmt.Errorf("%w in a Task Context", ErrForbidden)
	// ErrProviderKeyRequired is the ErrForbidden of a connected app action
	// before the deployment has a Composio API key.
	ErrProviderKeyRequired = fmt.Errorf("%w until a Composio API key is added", ErrForbidden)
)

type targetKey struct{}
type Target struct{ Kind, ID string }

// Authorization contains current Agent authority and resolved business facts.
// A target chooses a resource; no Runtime Context or Run identity is manufactured.
type Authorization struct {
	*agentcredential.Principal
	Target                                Target
	RoomID, ParticipantTaskID, DocumentID string
	PersonalKnowledgeAgentID              string
}

// AllowsRoomTarget confines a Room command to the caller's Context Room, which
// the CLI sends from its configuration. A request without a Room Context gets
// no Room.
func AllowsRoomTarget(authority Authorization, roomID string) bool {
	return roomID != "" && authority.RoomID == roomID
}

// TaskContextForbiddenMessage tells a Task's AlterEgo where its output goes
// instead.
const TaskContextForbiddenMessage = "A Task cannot send messages, create Documents, Rooms or Tasks, or manage Tasks. " +
	"In a Task, put what the Meta needs into your final reply and write files to ./playground/<taskId>/"

// taskContextBlocked lists what a Task Context may not do: only its Meta
// speaks and publishes; the AlterEgo reports through its final reply.
func taskContextBlocked(tool string) bool {
	switch tool {
	case "send_message", "send_message_sequence", "send_direct_message", "send_emoji", "ask_user", "show_fragment",
		"create_document", "create_room", "create_team_md",
		"create_task", "check_task", "send_task", "stop_task":
		return true
	}
	return false
}

// A target selects a business resource. It never contributes authority.
func WithTarget(ctx context.Context, kind, id string) context.Context {
	return context.WithValue(ctx, targetKey{}, Target{Kind: kind, ID: id})
}
func TargetFromContext(ctx context.Context) Target {
	target, _ := ctx.Value(targetKey{}).(Target)
	return target
}

// Service authorizes Agent business commands against current database facts.
type Service struct {
	pool          *pgxpool.Pool
	connectedApps func() bool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// SetConnectedApps makes the connected app actions depend on configured: while
// it reports false they are outside the allowlist. Without it they are allowed.
func (s *Service) SetConnectedApps(configured func() bool) { s.connectedApps = configured }

func (s *Service) Authorize(ctx context.Context, token, action string) (Authorization, error) {
	if s == nil || s.pool == nil {
		return Authorization{}, ErrCredentialInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Authorization{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authorization, err := s.AuthorizeInTx(ctx, tx, token, action)
	if err != nil {
		return Authorization{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Authorization{}, err
	}
	return authorization, nil
}

// AuthorizeInTx is the shared business authority entry point. Runtime Context
// credentials only identify resource sessions and cannot authorize Agent commands.
func (s *Service) AuthorizeInTx(ctx context.Context, tx pgx.Tx, token, action string) (Authorization, error) {
	if tx == nil || !strings.HasPrefix(token, "th_agent_") {
		return Authorization{}, ErrCredentialInvalid
	}
	if !s.actionConfigured(action) {
		return Authorization{}, ErrProviderKeyRequired
	}
	return authorizeAgentPrincipal(ctx, tx, token, action)
}

// actionConfigured reports whether the deployment currently runs the feature
// behind action. The connected app actions that reach Composio need a
// Composio API key; listing the Agent's grants and asking for a connection do
// not, so an Agent can ask the user for the key.
func (s *Service) actionConfigured(action string) bool {
	switch action {
	case "search_app_tools", "execute_app_tool", "manage_auto_reminders":
		return s.connectedApps == nil || s.connectedApps()
	}
	return true
}

func authorizeAgentPrincipal(ctx context.Context, tx pgx.Tx, token, action string) (Authorization, error) {
	if !businessAction(action) {
		return Authorization{}, ErrForbidden
	}
	p, err := agentcredential.AuthenticateInTx(ctx, tx, token)
	if errors.Is(err, agentcredential.ErrForbidden) {
		return Authorization{}, ErrForbidden
	}
	if errors.Is(err, agentcredential.ErrInvalid) {
		return Authorization{}, ErrCredentialInvalid
	}
	if err != nil {
		return Authorization{}, err
	}
	if p.AgentType != "general" && p.AgentType != "anotherme" {
		return Authorization{}, ErrForbidden
	}
	target := TargetFromContext(ctx)
	i := Authorization{Principal: &p, Target: target}
	switch target.Kind {
	case "":
	case "room":
		err = tx.QueryRow(ctx, `SELECT room.id FROM active_room_members member JOIN rooms room
 ON room.id=member.room_id AND room.tenant_id=member.tenant_id AND room.deletion_started_at IS NULL
 WHERE member.room_id=$1 AND member.tenant_id=$2 AND member.actor_id=$3`, target.ID, p.TenantID, p.AgentActorID).Scan(&i.RoomID)
	case "task":
		var participant bool
		err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT room_id FROM work_item_room_links
 WHERE work_item_id=item.id AND tenant_id=item.tenant_id AND link_type='work' LIMIT 1),''),EXISTS(SELECT 1 FROM task_execution_participants participant WHERE participant.task_id=item.id AND participant.generation=item.task_execution_generation AND participant.actor_id=$3) FROM work_items item
 WHERE item.id=$1 AND item.tenant_id=$2 AND item.kind='task' AND item.archived_at IS NULL
 AND (item.created_by_actor_id=$3 OR EXISTS(SELECT 1 FROM work_item_assignments assignment WHERE assignment.work_item_id=item.id AND assignment.actor_id=$3)
 OR EXISTS(SELECT 1 FROM work_item_access_grants grant_row WHERE grant_row.work_item_id=item.id AND grant_row.actor_id=$3)
 OR EXISTS(SELECT 1 FROM task_execution_participants participant WHERE participant.task_id=item.id
 AND participant.generation=item.task_execution_generation AND participant.actor_id=$3)) FOR SHARE OF item`, target.ID, p.TenantID, p.AgentActorID).Scan(&i.RoomID, &participant)
		if participant {
			i.ParticipantTaskID = target.ID
		}
	case "thread":
		if !commentAction(action) {
			return Authorization{}, ErrForbidden
		}
		// Resolve and authorize the thread's Document in this transaction. A
		// client-supplied thread never grants access or requires a second read.
		err = tx.QueryRow(ctx, `SELECT document.id FROM room_document_comment_threads thread
 JOIN documents document ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 WHERE thread.id=$1 AND thread.tenant_id=$2 AND document.status='active'
 AND (EXISTS(SELECT 1 FROM resolve_agent_document_access_v2($3,document.id) access
 WHERE access.tenant_id=$2 AND access.actor_id=$4 AND access.can_read)
 OR document_comment_agent_readable($2,document.id,$4))`, target.ID, p.TenantID, p.AgentID, p.AgentActorID).Scan(&i.DocumentID)
		i.Target = Target{Kind: "document", ID: i.DocumentID}
	case "document":
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT true FROM documents document
 WHERE document.id=$2 AND document.tenant_id=$3 AND document.status='active'
 AND (EXISTS(SELECT 1 FROM resolve_agent_document_access_v2($1,$2) access
 WHERE access.tenant_id=$3 AND access.actor_id=$4 AND access.can_read)
 OR ($5 AND document_comment_agent_readable($3,$2,$4)))`, p.AgentID, target.ID, p.TenantID, p.AgentActorID, commentAction(action)).Scan(&allowed)
		i.DocumentID = target.ID
	default:
		return Authorization{}, ErrInvalid
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Authorization{}, ErrForbidden
	}
	if err != nil {
		return Authorization{}, err
	}
	if i.ParticipantTaskID != "" && taskContextBlocked(action) {
		return Authorization{}, ErrTaskContextForbidden
	}
	// Delegated Tasks belong to the caller's Room Context.
	if (action == "create_task" || action == "check_task" || action == "send_task" || action == "stop_task") &&
		(target.Kind != "room" || i.RoomID == "") {
		return Authorization{}, ErrForbidden
	}
	knowledge := knowledgeAction(action)
	if knowledge {
		i.PersonalKnowledgeAgentID, err = resolvePersonalKnowledgeAgentID(ctx, store.New(tx), p.TenantID, p.UserArtifactOwnerActorID)
		if err != nil {
			return Authorization{}, err
		}
	}
	if !businessCapability(i, action) || (knowledge && p.UserArtifactOwnerActorID == "") {
		return Authorization{}, ErrForbidden
	}
	return i, nil
}

// This is an API action allowlist, not a transport inventory. Each owning
// service independently enforces the action's current permissions.
func businessAction(action string) bool {
	switch action {
	case "apply_document_semantic_mutation", "ask_user", "check_task", "create_document", "create_task", "create_room", "create_routine", "create_team_md", "delete_routine", "enable_routine", "get_document_comment_thread", "list_available_agents", "list_routines", "pause_routine", "replace_document_comment_text", "reply_document_comment", "run_routine", "send_direct_message", "send_emoji", "send_message", "send_message_sequence", "send_task", "show_fragment", "stop_task", "upload_artifact_tree", "upload_artifacts",
		"add_room_member", "create_agent", "get_agent", "update_agent", "list_connected_apps", "search_app_tools", "execute_app_tool", "manage_auto_reminders",
		"get_personal_profile", "write_personal_profile", "start_personal_profile_build", "get_account_profile", "update_account_profile",
		"request_browser_connection", "read_computer_permissions", "request_computer_permission":
		return true
	}
	return knowledgeAction(action)
}

// Knowledge actions read the Agent owner's personal knowledge and tracking items.
func knowledgeAction(action string) bool {
	switch action {
	case "search_knowledge", "read_knowledge", "list_tracking_items", "add_tracking_item", "update_tracking_item", "complete_tracking_item":
		return true
	}
	return false
}

func commentAction(action string) bool {
	return action == "get_document_comment_thread" || action == "reply_document_comment" || action == "replace_document_comment_text"
}

// Admit actions using the current Agent type and resolved resource role.
// Target is only request shape; ParticipantTaskID comes from current database membership.
func businessCapability(i Authorization, action string) bool {
	if i.AgentType != "general" && i.AgentType != "anotherme" {
		return false
	}
	switch action {
	case "list_available_agents", "get_agent", "create_agent", "update_agent":
		// Any meta Context; an alter_ego cannot manage Agents.
		return i.ParticipantTaskID == "" && i.Target.Kind != "document"
	case "get_personal_profile", "write_personal_profile", "start_personal_profile_build", "get_account_profile", "update_account_profile":
		// Only an AnotherMe acts on its owner's Profile, from its Meta or a Task.
		return i.AgentType == "anotherme" && i.UserArtifactOwnerActorID != "" && i.Target.Kind != "document"
	case "send_message_sequence":
		return i.AgentType == "anotherme" && i.ParticipantTaskID == "" && i.Target.Kind != "document"
	case "create_task", "check_task", "send_task", "stop_task", "create_room", "create_team_md", "show_fragment":
		return i.ParticipantTaskID == "" && i.Target.Kind != "document"
	case "get_document_comment_thread", "reply_document_comment", "replace_document_comment_text":
		return i.Target.Kind == "document"
	case "apply_document_semantic_mutation":
		return true
	case "send_direct_message":
		return i.ParticipantTaskID == "" && i.Target.Kind != "document"
	case "ask_user":
		// A question card goes to the caller's Context Room.
		return i.ParticipantTaskID == "" && i.Target.Kind == "room" && i.RoomID != ""
	case "add_room_member":
		// The member joins the caller's Context Room, from its Meta.
		return i.ParticipantTaskID == "" && i.Target.Kind == "room" && i.RoomID != ""
	case "upload_artifacts", "upload_artifact_tree", "list_connected_apps", "search_app_tools", "execute_app_tool":
		return i.Target.Kind != "document"
	default:
		return i.Target.Kind != "document"
	}
}

func resolvePersonalKnowledgeAgentID(ctx context.Context, queries *store.Queries, tenantID, ownerActorID string) (string, error) {
	if ownerActorID == "" {
		return "", nil
	}
	registration, err := queries.GetAnotherMeRegistration(ctx, store.GetAnotherMeRegistrationParams{
		TenantID: tenantID, RepresentedHumanActorID: ownerActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !registration.UserArtifactOwnerActorID.Valid || registration.UserArtifactOwnerActorID.String != ownerActorID ||
		!registration.AgentManagementID.Valid || registration.Status != "active" {
		return "", nil
	}
	return registration.AgentManagementID.String, nil
}
