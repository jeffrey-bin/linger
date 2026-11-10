package app

import (
	"encoding/json"
	"testing"
	"time"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// These wire structs are frozen from the f09e7dfc generated TeamHub public
// consumer. Keep them independent from current generated component types.
type documentReaderF09e7dfc struct {
	CanEditNativeContent bool                         `json:"can_edit_native_content"`
	Capabilities         documentCapabilitiesF09e7dfc `json:"capabilities"`
	CreatedAt            time.Time                    `json:"created_at"`
	Creator              actorRefF09e7dfc             `json:"creator"`
	CurrentVersion       *documentVersionRefF09e7dfc  `json:"current_version"`
	DraftCapability      string                       `json:"draft_capability"`
	Format               string                       `json:"format"`
	From                 []documentFromF09e7dfc       `json:"from"`
	ID                   string                       `json:"id"`
	Owner                actorRefF09e7dfc             `json:"owner"`
	RepresentationFormat string                       `json:"representation_format"`
	Status               string                       `json:"status"`
	TenantID             string                       `json:"tenant_id"`
	Title                string                       `json:"title"`
	UpdatedAt            time.Time                    `json:"updated_at"`
}

type actorRefF09e7dfc struct {
	DisplayName string `json:"display_name"`
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	TenantID    string `json:"tenant_id"`
}

type documentCapabilitiesF09e7dfc struct {
	Comment      bool `json:"comment"`
	Delete       bool `json:"delete"`
	Duplicate    bool `json:"duplicate"`
	Export       bool `json:"export"`
	Manage       bool `json:"manage"`
	Read         bool `json:"read"`
	UseAsContext bool `json:"use_as_context"`
	Write        bool `json:"write"`
}

type documentFromF09e7dfc struct {
	BindingKind string  `json:"binding_kind"`
	ContextID   string  `json:"context_id"`
	Label       *string `json:"label,omitempty"`
}

type documentVersionRefF09e7dfc struct {
	ID            string `json:"id"`
	SHA256        string `json:"sha256"`
	VersionNumber int    `json:"version_number"`
}

const documentWireF09e7dfc = `{
  "can_edit_native_content": true,
  "capabilities": {
    "comment": true,
    "delete": true,
    "duplicate": true,
    "export": true,
    "manage": true,
    "read": true,
    "use_as_context": true,
    "write": true
  },
  "created_at": "2026-08-29T00:00:00Z",
  "creator": {"display_name":"Alice","id":"actor_alice","kind":"human","tenant_id":"tenant_acme"},
  "current_version": null,
  "draft_capability": "write",
  "format": "blocknote",
  "from": [],
  "id": "document_one",
  "owner": {"display_name":"Alice","id":"actor_alice","kind":"human","tenant_id":"tenant_acme"},
  "representation_format": "markdown",
  "status": "active",
  "tenant_id": "tenant_acme",
  "title": "Mixed version",
  "updated_at": "2026-08-29T00:00:00Z"
}`

const documentWireV2 = `{
  "can_edit_native_content": true,
  "capabilities": {
    "comment": true,
    "delete": true,
    "duplicate": true,
    "export": true,
    "manage": true,
    "read": true,
    "use_as_context": true,
    "write": true
  },
  "created_at": "2026-08-29T00:00:00Z",
  "creator": {"display_name":"Alice","id":"actor_alice","kind":"human","tenant_id":"tenant_acme"},
  "current_version": null,
  "draft_capability": "write",
  "format": "blocknote",
  "from": [],
  "id": "document_one",
  "owner": {"display_name":"Alice","id":"actor_alice","kind":"human","tenant_id":"tenant_acme"},
  "representation_format": "markdown",
  "status": "active",
  "tenant_id": "tenant_acme",
  "title": "Mixed version",
  "updated_at": "2026-08-29T00:00:00Z",
  "access_v2": {
    "schema_version": 2,
    "content_role": "owner",
    "sources": [],
    "policy": {"schema_version":2,"link_scope":"restricted"},
    "requests": [],
    "authorization_mode": "human_native"
  }
}`

func TestDocumentAccessV2MixedVersionGeneratedReaders(t *testing.T) {
	t.Run("oldest live reader decodes V2 producer", func(t *testing.T) {
		var document documentReaderF09e7dfc
		if err := json.Unmarshal([]byte(documentWireV2), &document); err != nil {
			t.Fatal(err)
		}
		if document.ID != "document_one" || document.Title != "Mixed version" ||
			!document.Capabilities.Read || !document.Capabilities.Manage {
			t.Fatalf("oldest live reader decoded=%+v", document)
		}
	})

	t.Run("current reader decodes oldest live producer", func(t *testing.T) {
		var document httpapi.Document
		if err := json.Unmarshal([]byte(documentWireF09e7dfc), &document); err != nil {
			t.Fatal(err)
		}
		if document.Id != "document_one" || document.Title != "Mixed version" ||
			document.AccessV2 != nil || !document.Capabilities.Read || !document.Capabilities.Manage {
			t.Fatalf("current reader decoded=%+v", document)
		}
	})
}
