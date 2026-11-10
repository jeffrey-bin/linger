package localskills

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	maxCandidates        = 256
	packageDigestVersion = "teamhub.skill-package.v1\x00"
)

type Command struct {
	Type            string    `json:"type"`
	Kind            string    `json:"kind"`
	ProtocolVersion string    `json:"protocol_version"`
	CommandID       string    `json:"command_id"`
	RunnerID        string    `json:"runner_id"`
	TenantID        string    `json:"tenant_id"`
	OwnerActorID    string    `json:"owner_actor_id"`
	ConnectionEpoch uint64    `json:"connection_epoch"`
	ExpiresAt       time.Time `json:"expires_at"`
	ScanID          string    `json:"scan_id"`
	RuntimeType     string    `json:"runtime_type,omitempty"`
}

type Candidate struct {
	NativeSource    string   `json:"native_source,omitempty"`
	NativeEnabled   *bool    `json:"native_enabled,omitempty"`
	CandidateRef    string   `json:"candidate_ref"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	PackageSHA256   string   `json:"package_sha256"`
	FileCount       int      `json:"file_count"`
	SizeBytes       int64    `json:"size_bytes"`
	Normalizations  []string `json:"normalizations"`
	RiskFlags       []string `json:"risk_flags"`
	Importability   string   `json:"importability"`
	ErrorCode       string   `json:"error_code,omitempty"`
	ErrorDetail     string   `json:"error_detail,omitempty"`
	ManifestExcerpt string   `json:"manifest_excerpt,omitempty"`
}

type commandIdentity struct {
	ProtocolVersion string    `json:"protocol_version"`
	CommandID       string    `json:"command_id"`
	RunnerID        string    `json:"runner_id"`
	TenantID        string    `json:"tenant_id"`
	OwnerActorID    string    `json:"owner_actor_id"`
	ConnectionEpoch uint64    `json:"connection_epoch"`
	ExpiresAt       time.Time `json:"expires_at"`
}

type scannedOutcome struct {
	commandIdentity
	Type        string      `json:"type"`
	Kind        string      `json:"kind"`
	Outcome     string      `json:"outcome"`
	ScanID      string      `json:"scan_id"`
	RuntimeType string      `json:"runtime_type"`
	Items       []Candidate `json:"items"`
}

type failedOutcome struct {
	commandIdentity
	Type    string       `json:"type"`
	Kind    string       `json:"kind"`
	Outcome string       `json:"outcome"`
	Stage   string       `json:"stage"`
	ScanID  string       `json:"scan_id,omitempty"`
	Error   outcomeError `json:"error"`
}

type outcomeError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Options struct {
	HomeDirectory string
	CodexHome     string
	CurrentUID    int
	Now           func() time.Time
}

// nativeSkill is the Runtime-independent shape of an inherited Skill. Each
// Runtime discovers its own Skill trees; the scan only needs the metadata a
// candidate carries.
type nativeSkill struct {
	Name, Description, Path, Source string
	Enabled                         bool
}

// Catalog scans the Computer user's Skill trees. A scan only reads local
// files, so a repeated command is scanned again rather than replayed.
type Catalog struct {
	home       string
	codexHome  string
	currentUID int
	now        func() time.Time
}

func Open(options Options) (*Catalog, error) {
	if options.HomeDirectory == "" {
		var err error
		options.HomeDirectory, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	if options.CurrentUID < 0 {
		options.CurrentUID = os.Getuid()
	}
	catalog := &Catalog{home: options.HomeDirectory, codexHome: options.CodexHome, currentUID: options.CurrentUID, now: options.Now}
	if catalog.now == nil {
		catalog.now = func() time.Time { return time.Now().UTC() }
	}
	return catalog, nil
}

func (c *Catalog) Handle(ctx context.Context, encoded json.RawMessage) (json.RawMessage, error) {
	var command Command
	if err := json.Unmarshal(encoded, &command); err != nil {
		return nil, fmt.Errorf("decode Local Skill command: %w", err)
	}
	var outcome any
	if err := validateCommand(command, c.now()); err != nil {
		outcome = failure(command, err)
	} else {
		value, scanErr := c.scan(ctx, command)
		if scanErr != nil {
			outcome = failure(command, scanErr)
		} else {
			outcome = value
		}
	}
	return json.Marshal(outcome)
}

func (c *Catalog) scan(ctx context.Context, command Command) (scannedOutcome, error) {
	items := make([]Candidate, 0)
	// Native inheritance metadata is additive. An unreadable Runtime config or
	// Skill tree leaves the platform scan intact without native_source.
	nativeByPath := map[string]nativeSkill{}
	switch command.RuntimeType {
	case "codex":
		source := c.codexHome
		if source == "" {
			source = filepath.Join(c.home, ".codex")
		}
		if native, err := workspace.DiscoverCodexSkills(source, c.home); err == nil {
			for _, skill := range native {
				nativeByPath[filepath.Dir(skill.Path)] = nativeSkill{
					Name: skill.Name, Description: skill.Description,
					Path: skill.Path, Source: skill.Source, Enabled: skill.Enabled,
				}
			}
		}
	case "claude":
		if native, err := workspace.DiscoverClaudeSkills(filepath.Join(c.home, ".claude")); err == nil {
			for _, skill := range native {
				nativeByPath[filepath.Dir(skill.Path)] = nativeSkill{
					Name: skill.Name, Description: skill.Description,
					Path: skill.Path, Source: skill.Source, Enabled: skill.Enabled,
				}
			}
		}
	}
	roots := skillRoots(c.home, command.RuntimeType)
	if command.RuntimeType == "codex" && c.codexHome != "" {
		roots = []string{filepath.Join(c.home, ".agents", "skills"), filepath.Join(c.codexHome, "skills")}
	}
	for _, root := range roots {
		directories, err := immediateDirectories(root)
		if err != nil {
			return scannedOutcome{}, err
		}
		for _, source := range directories {
			if len(items) >= maxCandidates {
				break
			}
			item := inspectCandidate(root, source, c.currentUID)
			if item == nil {
				continue
			}
			nativePath, _ := filepath.EvalSymlinks(source)
			if native, ok := nativeByPath[nativePath]; ok {
				item.Name = native.Name
				item.Description = native.Description
				item.NativeSource = native.Source
				enabled := native.Enabled
				item.NativeEnabled = &enabled
				delete(nativeByPath, nativePath)
			}
			items = append(items, *item)
		}
	}
	for _, native := range nativeByPath {
		if len(items) >= maxCandidates {
			return scannedOutcome{}, errors.New("Local Skill catalog exceeds limit")
		}
		ref, err := newCandidateRef()
		if err != nil {
			return scannedOutcome{}, err
		}
		enabled := native.Enabled
		candidate := Candidate{
			CandidateRef: ref, Name: native.Name, Description: native.Description,
			PackageSHA256: strings.Repeat("0", 64), FileCount: 1, SizeBytes: 1,
			Normalizations: []string{}, RiskFlags: []string{},
			Importability: "unsupported", ErrorCode: "LOCAL_SKILL_NATIVE_ONLY",
			ErrorDetail:  "Inherited directly from this Computer; no package import is required",
			NativeSource: native.Source, NativeEnabled: &enabled,
		}
		// Plugin-cache and Codex `.system` Skills are inherited in place, so the
		// package contract must not decide whether the Runtime reports them. When
		// the tree does satisfy it the digest, size and risk flags are the real
		// ones; when it does not — a top-level LICENSE.txt is enough — the Skill
		// is still inherited and still listed.
		if inspected, err := inspectSkill(filepath.Dir(native.Path), c.currentUID); err == nil {
			candidate.PackageSHA256 = inspected.PackageSHA256
			candidate.FileCount = len(inspected.Files)
			candidate.SizeBytes = inspected.SizeBytes
			candidate.Normalizations = append([]string{}, inspected.Normalizations...)
			candidate.RiskFlags = append([]string{}, inspected.RiskFlags...)
		}
		items = append(items, candidate)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return scannedOutcome{
		commandIdentity: identity(command), Type: wire.TypeExecuted, Kind: wire.KindSkillsScan,
		Outcome: wire.OutcomeSucceeded, ScanID: command.ScanID,
		RuntimeType: command.RuntimeType, Items: items,
	}, nil
}

func canonicalPackageDigest(files []SkillFile) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte(packageDigestVersion))
	for _, file := range files {
		pathBytes := []byte(file.RelativePath)
		_ = binary.Write(hash, binary.BigEndian, uint64(len(pathBytes)))
		_, _ = hash.Write(pathBytes)
		_ = binary.Write(hash, binary.BigEndian, uint64(len(file.Content)))
		decoded, _ := hex.DecodeString(file.SHA256)
		_, _ = hash.Write(decoded)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func newCandidateRef() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func validateCommand(command Command, now time.Time) error {
	if command.Type != wire.TypeExecute || command.Kind != wire.KindSkillsScan {
		return &catalogError{Code: "LOCAL_SKILL_COMMAND_INVALID", Message: "Local Skill command type is invalid"}
	}
	if command.ProtocolVersion == "" || command.CommandID == "" || command.RunnerID == "" || command.TenantID == "" ||
		command.OwnerActorID == "" || command.ConnectionEpoch < 1 || command.ScanID == "" || !command.ExpiresAt.After(now) {
		return &catalogError{Code: "LOCAL_SKILL_COMMAND_INVALID", Message: "Local Skill command identity is invalid"}
	}
	if command.RuntimeType != "codex" && command.RuntimeType != "claude" {
		return &catalogError{Code: "LOCAL_SKILL_COMMAND_INVALID", Message: "Local Skill Runtime type is invalid"}
	}
	return nil
}

func identity(command Command) commandIdentity {
	return commandIdentity{
		ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		RunnerID: command.RunnerID, TenantID: command.TenantID, OwnerActorID: command.OwnerActorID,
		ConnectionEpoch: command.ConnectionEpoch, ExpiresAt: command.ExpiresAt,
	}
}

type catalogError struct {
	Code, Message string
	Retryable     bool
}

func (e *catalogError) Error() string { return e.Message }

func failure(command Command, err error) failedOutcome {
	failure := &catalogError{Code: "LOCAL_SKILL_OPERATION_FAILED", Message: "Local Skill operation failed"}
	var typed *catalogError
	if errors.As(err, &typed) {
		failure = typed
	}
	return failedOutcome{
		commandIdentity: identity(command), Type: wire.TypeExecuted, Kind: wire.KindSkillsScan,
		Outcome: wire.OutcomeFailed, Stage: "scan", ScanID: command.ScanID,
		Error: outcomeError{Code: failure.Code, Message: failure.Message, Retryable: failure.Retryable},
	}
}
