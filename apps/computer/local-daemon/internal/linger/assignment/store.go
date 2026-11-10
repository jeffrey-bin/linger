package assignment

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"sync"
)

var (
	ErrConflict = errors.New("Agent Runtime Assignment state conflicts with retained state")
	ErrStale    = errors.New("Agent Runtime Assignment command is stale")
)

type Command struct {
	Type               string          `json:"type"`
	CommandID          string          `json:"command_id"`
	RunnerID           string          `json:"runner_id"`
	TenantID           string          `json:"tenant_id"`
	AgentID            string          `json:"agent_id"`
	RegistrationID     string          `json:"registration_id,omitempty"`
	AssignmentRevision uint64          `json:"assignment_revision,omitempty"`
	RunnerRevision     uint64          `json:"runner_revision"`
	Runtime            json.RawMessage `json:"runtime,omitempty"`
	WorkspaceGrantID   string          `json:"workspace_grant_id,omitempty"`
}

type Record struct {
	RunnerID           string          `json:"runner_id"`
	TenantID           string          `json:"tenant_id"`
	AgentID            string          `json:"agent_id"`
	RegistrationID     string          `json:"registration_id,omitempty"`
	AssignmentRevision uint64          `json:"assignment_revision,omitempty"`
	RunnerRevision     uint64          `json:"runner_revision"`
	State              string          `json:"state"`
	Runtime            json.RawMessage `json:"runtime,omitempty"`
	WorkspaceGrantID   string          `json:"workspace_grant_id,omitempty"`
	RunnerPID          int             `json:"runner_pid,omitempty"`
	CommandID          string          `json:"-"`
	CommandDigest      string          `json:"-"`
}

type Store interface {
	Apply(context.Context, Command, int) (Record, error)
	List(context.Context) ([]Record, error)
}

// MemoryStore holds the Agent Runners the Gateway ensured on this Daemon
// process. The Gateway ensures them again on every connection, so they are
// not kept across a restart.
type MemoryStore struct {
	mu      sync.Mutex
	records map[string]Record
}

// NewMemoryStore returns an empty store; the Gateway ensures every Runner again
// on each connection.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[string]Record)}
}

// Apply records an Agent Runner command and returns the resulting Runner.
func (s *MemoryStore) Apply(_ context.Context, command Command, runnerPID int) (Record, error) {
	digest, err := commandDigest(command)
	if err != nil {
		return Record{}, err
	}
	key := command.TenantID + "\x00" + command.AgentID
	s.mu.Lock()
	defer s.mu.Unlock()
	current, exists := s.records[key]
	next, err := apply(current, exists, command, digest, runnerPID)
	if err != nil {
		return Record{}, err
	}
	s.records[key] = clone(next)
	return clone(next), nil
}

// List returns the Runners in Tenant and Agent order.
func (s *MemoryStore) List(context.Context) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Record, 0, len(s.records))
	for _, record := range s.records {
		result = append(result, clone(record))
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].TenantID != result[j].TenantID {
			return result[i].TenantID < result[j].TenantID
		}
		return result[i].AgentID < result[j].AgentID
	})
	return result, nil
}

func apply(current Record, exists bool, command Command, digest string, runnerPID int) (Record, error) {
	if err := validateCommand(command); err != nil {
		return Record{}, err
	}
	if exists {
		if command.RunnerID != current.RunnerID {
			return Record{}, ErrConflict
		}
		if command.RunnerRevision < current.RunnerRevision {
			return Record{}, ErrStale
		}
		if command.RunnerRevision == current.RunnerRevision {
			if digest != current.CommandDigest {
				return Record{}, ErrConflict
			}
			return current, nil
		}
	}
	next := Record{
		RunnerID: command.RunnerID, TenantID: command.TenantID, AgentID: command.AgentID,
		RegistrationID: command.RegistrationID, AssignmentRevision: command.AssignmentRevision,
		RunnerRevision: command.RunnerRevision, CommandID: command.CommandID, CommandDigest: digest,
	}
	switch command.Type {
	case "agent_runner.ensure":
		next.State = "ready"
		next.Runtime = append(json.RawMessage(nil), command.Runtime...)
		next.WorkspaceGrantID = command.WorkspaceGrantID
		next.RunnerPID = runnerPID
	case "agent_runner.remove":
		next.State = "removed"
	default:
		return Record{}, ErrConflict
	}
	return next, nil
}

func validateCommand(command Command) error {
	if command.CommandID == "" || command.RunnerID == "" || command.TenantID == "" || command.AgentID == "" || command.RunnerRevision == 0 ||
		(command.RegistrationID == "") != (command.AssignmentRevision == 0) {
		return ErrConflict
	}
	if command.Type == "agent_runner.ensure" {
		if len(command.Runtime) == 0 || command.WorkspaceGrantID == "" || command.RegistrationID == "" || command.AssignmentRevision == 0 {
			return ErrConflict
		}
	}
	return nil
}

func commandDigest(command Command) (string, error) {
	if len(command.Runtime) > 0 {
		var runtime any
		decoder := json.NewDecoder(bytes.NewReader(command.Runtime))
		decoder.UseNumber()
		if err := decoder.Decode(&runtime); err != nil {
			return "", err
		}
		encoded, err := json.Marshal(runtime)
		if err != nil {
			return "", err
		}
		command.Runtime = encoded
	}
	return rawCommandDigest(command)
}

func rawCommandDigest(command Command) (string, error) {
	semantic := command
	semantic.CommandID = ""
	encoded, err := json.Marshal(semantic)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func clone(record Record) Record {
	record.Runtime = append(json.RawMessage(nil), record.Runtime...)
	return record
}

var _ Store = (*MemoryStore)(nil)
