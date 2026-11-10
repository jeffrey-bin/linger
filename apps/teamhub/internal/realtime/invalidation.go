package realtime

import (
	"context"
	"errors"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Invalidation hints tell browsers which resource to refetch. They are sent
// through the commit NOTIFY channel and never persisted: a hint lost while a
// browser is offline is covered by the stream.resync the browser receives on
// reconnect.
const (
	// InvalidationKindPrefix prefixes the resource in a hint's notification kind.
	InvalidationKindPrefix = "invalidate."

	// InvalidateRoom: the Room's summary, unread state, read state, or a card
	// shown in it changed. The id is the Room ID; Sequence is its room_seq.
	InvalidateRoom = "room"
	// InvalidateDirectory: Tenant Actors, Agents, or Room members changed. The id is the Tenant ID.
	InvalidateDirectory = "directory"
	// InvalidateAgents: Agent availability, status, or activity changed. The id is the Tenant ID.
	InvalidateAgents = "agents"
	// InvalidateAnotherMe: the Tenant's AnotherMe was created. The id is the Tenant ID.
	InvalidateAnotherMe = "another-me"
	// InvalidateComputers: Local Computers changed. The id is the Tenant ID.
	InvalidateComputers = "computers"
	// InvalidateConnections: external connections changed. The id is the Tenant ID.
	InvalidateConnections = "connections"
	// InvalidateWorkItems: Work Items changed. The id is the Tenant ID.
	InvalidateWorkItems = "work-items"
	// InvalidateDocument: a Document's metadata, access, comments, or access
	// requests changed. The id is the Document ID.
	InvalidateDocument = "document"
	// InvalidateDocumentAccess: as InvalidateDocument, and access may have
	// been revoked, so browsers drop cached Document bytes. The id is the
	// Document ID.
	InvalidateDocumentAccess = "document-access"
)

var invalidationResources = map[string]bool{
	InvalidateRoom: true, InvalidateDirectory: true, InvalidateAgents: true, InvalidateAnotherMe: true,
	InvalidateComputers: true, InvalidateConnections: true, InvalidateWorkItems: true, InvalidateDocument: true,
	InvalidateDocumentAccess: true,
}

// ValidInvalidationResource reports whether resource is a published hint type.
func ValidInvalidationResource(resource string) bool { return invalidationResources[resource] }

// Invalidation names one changed resource in a Tenant.
type Invalidation struct {
	TenantID string
	Resource string
	ID       string
	// RoomSeq is the Room's latest room_seq for a Room hint, else zero.
	RoomSeq int64
}

// TenantTopic is the notification topic of a Tenant's invalidation hints.
func TenantTopic(tenantID string) string { return "tenant:" + tenantID }

// Notifier sends a NOTIFY inside the caller's transaction, so PostgreSQL
// delivers it only after commit and collapses identical hints of one
// transaction into one notification. *store.Queries implements it.
type Notifier interface {
	PublishInvalidation(ctx context.Context, arg store.PublishInvalidationParams) error
}

// Invalidate publishes one hint in the caller's transaction.
func Invalidate(ctx context.Context, notifier Notifier, hint Invalidation) error {
	if hint.TenantID == "" || hint.ID == "" || !ValidInvalidationResource(hint.Resource) ||
		strings.ContainsAny(hint.TenantID+hint.ID, "\r\n") ||
		len(hint.TenantID) > maxNotificationFieldBytes || len(hint.ID) > maxNotificationFieldBytes ||
		hint.RoomSeq < 0 || (hint.Resource != InvalidateRoom && hint.RoomSeq != 0) {
		return errors.New("realtime invalidation is invalid")
	}
	return notifier.PublishInvalidation(ctx, store.PublishInvalidationParams{
		Topic: TenantTopic(hint.TenantID), Kind: InvalidationKindPrefix + hint.Resource,
		ResourceID: hint.ID, Sequence: hint.RoomSeq,
	})
}

// InvalidationFromEvent reads a hint back from a Broker event. ok is false for
// any other event.
func InvalidationFromEvent(event Event) (Invalidation, bool) {
	tenantID, found := strings.CutPrefix(event.Topic, "tenant:")
	resource, isHint := strings.CutPrefix(event.Kind, InvalidationKindPrefix)
	if !found || !isHint || tenantID == "" || !ValidInvalidationResource(resource) {
		return Invalidation{}, false
	}
	return Invalidation{TenantID: tenantID, Resource: resource, ID: event.ResourceID, RoomSeq: event.Sequence}, true
}
