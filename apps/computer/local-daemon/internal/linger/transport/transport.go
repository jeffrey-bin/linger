package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// Hello contains only device proof and observed local capabilities. Enrollment
// credentials are carried by the concrete transport and never enter this type.
type Hello struct {
	ProtocolVersion    string
	RunnerID           string
	ConnectionNonce    string
	DisplayName        string
	Identity           Identity
	Signature          []byte
	SentAt             time.Time
	Capacity           *int
	Runtimes           []string
	RuntimeDiagnostics json.RawMessage
	Capabilities       []string
	WorkspaceGrants    json.RawMessage
	AgentRunners       json.RawMessage
	ActiveOperations   json.RawMessage
	Registrations      []RegistrationObservation
}

func IdentityProofPayload(hello Hello) []byte {
	return bytes.Join([][]byte{
		// Frozen wire constant: daemons and Agent Services of any version must
		// sign and verify the same label, so it keeps its original name.
		[]byte("simplex-computer-daemon-identity-v1"),
		[]byte(hello.RunnerID),
		[]byte(hello.ConnectionNonce),
		[]byte(hello.SentAt.Format(time.RFC3339Nano)),
		[]byte(hello.ProtocolVersion),
	}, []byte{0})
}

type RegistrationObservation struct {
	TenantID           string          `json:"tenant_id"`
	OwnerActorID       string          `json:"owner_actor_id"`
	ProviderType       string          `json:"provider_type"`
	Status             string          `json:"status"`
	Revision           uint64          `json:"revision"`
	Capabilities       []string        `json:"capabilities"`
	RuntimeDiagnostics json.RawMessage `json:"runtime_diagnostics"`
}

type RuntimeRegistration struct {
	RegistrationID string                  `json:"registration_id"`
	Observation    RegistrationObservation `json:"observation"`
}

// Stream is the only control-plane seam visible to the daemon core. A
// production implementation speaks Runner Gateway; tests use an in-memory
// stream. Registration, Assignment, Context, Operation, and receipt semantics
// stay in typed Command/Event payloads instead of transport-specific methods.
type Stream interface {
	Receive(context.Context) (protocol.Command, error)
	Send(context.Context, protocol.Event) error
	Close() error
}

type ControlPlane interface {
	Connect(context.Context, Hello) (Stream, error)
}
