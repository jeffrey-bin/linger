package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type ProviderInstallation struct {
	Type           string
	ExecutablePath string
	EntryPath      string
	Environment    map[string]string
	Version        string
	// ContextWindows maps a model ID to its discovered context length in
	// tokens.
	ContextWindows map[string]int
}

type WorkspaceGrant struct {
	GrantID  string
	TenantID string
	Path     string
}

type RegistrationBinding struct {
	RegistrationID string
	TenantID       string
	OwnerActorID   string
	ProviderType   string
	Status         registration.Status
}

type ExecutionResolver struct {
	// Bound by the local launcher; never accepted from a wire request.
	ServiceCommand     []string
	TeamHubCLIBin      string
	ToolGuide          string // describes the Computer's local tools to every Operation
	Providers          map[string]ProviderInstallation
	ProviderLookup     func(context.Context, string) (ProviderInstallation, bool, error)
	WorkspaceGrants    map[string]WorkspaceGrant
	Registrations      map[string]RegistrationBinding
	RegistrationLookup func(context.Context, string) (RegistrationBinding, bool, error)
	// CLICredentials finds the Agent-level TeamHub CLI credential the Daemon
	// stored. Nil leaves every Operation without a TeamHub CLI profile.
	CLICredentials CLICredentialLookup
	Views          interface {
		ValidatedView(context.Context, string, json.RawMessage) (ViewRecord, error)
	}
}

// codexLocalDefaultArgs keep reasoning summaries in the rollout consumed by
// Debug History and Room transcripts. The native adapter owns memory policy.
var codexLocalDefaultArgs = []string{
	"--config", `model_reasoning_summary="auto"`,
	"--config", "hide_agent_reasoning=false",
}

func (r ExecutionResolver) Resolve(ctx context.Context, command protocol.Command, encoded json.RawMessage) (provider.OperationSpec, error) {
	if command.RegistrationID == "" || command.AssignmentRevision == 0 {
		return provider.OperationSpec{}, errors.New("Operation lacks an Agent Runtime Assignment")
	}
	binding, ok, err := r.registration(ctx, command.RegistrationID)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	if !ok || binding.RegistrationID != command.RegistrationID {
		return provider.OperationSpec{}, errors.New("Operation Registration binding is unavailable")
	}
	if binding.TenantID != command.TenantID {
		return provider.OperationSpec{}, errors.New("Operation Registration tenant binding is invalid")
	}
	if binding.ProviderType != command.RuntimeType {
		return provider.OperationSpec{}, errors.New("Operation Registration provider binding is invalid")
	}
	if binding.Status != registration.StatusOnline {
		return provider.OperationSpec{}, fmt.Errorf("Operation Local Runtime Registration is %s", binding.Status)
	}
	installation, ok, err := r.provider(ctx, command.RuntimeType)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	if !ok || installation.Type != command.RuntimeType || installation.ExecutablePath == "" {
		return provider.OperationSpec{}, errors.New("local Runtime installation is unavailable")
	}
	grant, ok := r.WorkspaceGrants[command.WorkspaceGrantID]
	if !ok || grant.GrantID != command.WorkspaceGrantID || grant.TenantID != command.TenantID || grant.Path == "" {
		return provider.OperationSpec{}, errors.New("local workspace grant is unavailable")
	}
	if r.Views == nil {
		return provider.OperationSpec{}, errors.New("Context View store is unavailable")
	}
	view, err := r.Views.ValidatedView(ctx, command.ExecutionContextKey, command.ContextViewRef)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	workingDirectory := view.WorkspacePath
	var request semanticRequest
	if err := json.Unmarshal(encoded, &request); err != nil {
		return provider.OperationSpec{}, fmt.Errorf("decode semantic Operation request: %w", err)
	}
	if request.Runtime.Type != command.RuntimeType {
		return provider.OperationSpec{}, errors.New("semantic Runtime does not match Operation identity")
	}
	if request.Runtime.ReasoningEffort != "" && !validReasoningEffort(request.Runtime.ReasoningEffort) {
		return provider.OperationSpec{}, errors.New("semantic Runtime reasoning effort is invalid")
	}
	if request.Kind != "run.start" {
		return provider.OperationSpec{}, fmt.Errorf("unsupported semantic Operation kind %q", request.Kind)
	}
	resumeSessionID := request.Session.threadID()
	if resumeSessionID == "" {
		resumeSessionID = request.Session.SessionID
	}
	if command.RuntimeType == "codex" && resumeSessionID == "" && (request.Session.ThreadIDCamel == nil || *request.Session.ThreadIDCamel != "") {
		return provider.OperationSpec{}, errors.New("Codex run.start requires a retained session or an explicit first-run marker")
	}
	developerInstructions := instructionValue(request.SessionOptions.DeveloperInstructions)
	if command.HostAccess == "trusted" {
		developerInstructions = strings.TrimSpace(strings.Join([]string{
			developerInstructions, trustedHostServiceInstructions, boundServiceInstructions(r.ServiceCommand),
		}, "\n\n"))
	}
	if r.ToolGuide != "" {
		developerInstructions = strings.TrimSpace(developerInstructions + "\n\n" + r.ToolGuide)
	}
	systemPrompt := strings.TrimSpace(strings.Join([]string{
		instructionValue(request.SessionOptions.BaseInstructions),
		developerInstructions,
	}, "\n\n"))
	spec := provider.OperationSpec{
		OperationKind: request.Kind, Provider: command.RuntimeType,
		ExecutablePath: installation.ExecutablePath, WorkingDirectory: workingDirectory,
		Model: request.Runtime.Model, Prompt: request.Input.Text,
		ExecutionRunRef:   strings.TrimSpace(request.RunContext.ExecutionRunRef),
		HumanInteractions: request.RunContext.HumanInteractions,
		PermissionReview:  request.RunContext.PermissionReview,
		TeamHubCLIBin:     r.TeamHubCLIBin,
		ThinkingLevel:     request.Runtime.ReasoningEffort,
		ContextWindow:     installation.ContextWindows[request.Runtime.Model],
		ResumeSessionID:   resumeSessionID, Environment: cloneEnvironment(installation.Environment),
		ThreadName: request.SessionOptions.ThreadName, SystemPrompt: systemPrompt,
		BaseInstructions:      request.SessionOptions.BaseInstructions,
		DeveloperInstructions: request.SessionOptions.DeveloperInstructions,
		MCPRelays:             append(json.RawMessage(nil), request.RunResources.MCPServers...),
		CodexVersion:          installation.Version,
		TenantID:              command.TenantID, OwnerActorID: binding.OwnerActorID, AgentID: command.AgentID,
	}
	if command.HostAccess == "trusted" || r.ToolGuide != "" {
		spec.DeveloperInstructions = &developerInstructions
	}
	// The profile path is stable and depends only on the Agent-level credential,
	// so a Run's first and later provider starts see the same environment.
	configuration := filepath.Join(workingDirectory, ".teamhub", "cli", "config.json")
	if info, err := os.Lstat(configuration); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return provider.OperationSpec{}, errors.New("TeamHub CLI configuration or installation is unavailable; upgrade Local Computer")
		}
		checked, err := openContextFile(workingDirectory, ".teamhub/cli/config.json")
		if err != nil {
			return provider.OperationSpec{}, errors.New("TeamHub CLI configuration path is invalid")
		}
		_ = checked.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		return provider.OperationSpec{}, errors.New("TeamHub CLI configuration is unavailable")
	}
	installed, err := r.cliCredentialInstalled(command.TenantID, command.AgentID)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	if installed {
		if r.TeamHubCLIBin == "" {
			return provider.OperationSpec{}, errors.New("TeamHub CLI configuration or installation is unavailable; upgrade Local Computer")
		}
		if spec.Environment == nil {
			spec.Environment = make(map[string]string)
		}
		spec.Environment["TEAMHUB_CONFIG"] = configuration
		spec.Environment["TEAMHUB_PROFILE"] = "runtime"
		searchPath := spec.Environment["PATH"]
		if searchPath == "" {
			searchPath = os.Getenv("PATH")
		}
		spec.Environment["PATH"] = r.TeamHubCLIBin + string(os.PathListSeparator) + searchPath
	}
	if command.RuntimeType == "codex" {
		// Local Codex records the same reasoning the Cloud Runtime does and
		// disables native automatic Memory. These are daemon defaults: per-Agent
		// custom args still win by argv order.
		spec.ExtraArgs = append(spec.ExtraArgs, codexLocalDefaultArgs...)
	}
	if spec.MCPRelays == nil {
		spec.MCPRelays = json.RawMessage(`[]`)
	}
	if views, ok := r.Views.(interface {
		SharedTaskAccess(context.Context, string, string) (provider.SharedTaskAccess, error)
	}); ok {
		var reference ViewRef
		if err := json.Unmarshal(command.ContextViewRef, &reference); err != nil {
			return provider.OperationSpec{}, err
		}
		if spec.SharedTask, err = views.SharedTaskAccess(ctx, command.ExecutionContextKey, reference.ViewDigest); err != nil {
			return provider.OperationSpec{}, err
		}
	}
	if command.RuntimeType == "claude" {
		spec.ClaudeSkillNames = authorizedClaudeSkillNames(view.View.Mappings)
	}
	spec.ContextSkillDigest = contextSkillDigest(view.View.Mappings)
	if (command.RuntimeType == "claude" || command.RuntimeType == "pi") && resumeSessionID != "" && !request.Session.materialized() {
		spec.CreateProviderSessionID = resumeSessionID
		spec.ResumeSessionID = ""
	}
	return spec, nil
}

// cliCredentialInstalled reports whether the Daemon holds the Agent's TeamHub
// CLI credential.
func (r ExecutionResolver) cliCredentialInstalled(tenantID, agentID string) (bool, error) {
	if r.CLICredentials == nil {
		return false, nil
	}
	_, err := r.CLICredentials.Lookup(tenantID, agentID)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, clicredential.ErrNotInstalled):
		return false, nil
	default:
		return false, errors.New("TeamHub CLI credential is unavailable")
	}
}

// contextSkillDigest identifies the Skill packages the View publishes into
// the workspace, from the View's own file digests: a file a Runtime or an
// Agent writes there later does not change it.
func contextSkillDigest(mappings []Mapping) string {
	var records []string
	for _, mapping := range mappings {
		if mapping.Kind != "skills" || mapping.TargetPath != ".agents/skills" {
			continue
		}
		for _, file := range mapping.Files {
			records = append(records, fmt.Sprintf("%s\x00%s\x00%t", file.RelativePath, file.SHA256, file.Executable))
		}
	}
	slices.Sort(records)
	sum := sha256.New()
	for _, record := range records {
		_, _ = fmt.Fprintf(sum, "%d:%s\n", len(record), record)
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func authorizedClaudeSkillNames(mappings []Mapping) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, mapping := range mappings {
		if mapping.Kind != "skills" || mapping.TargetPath != ".agents/skills" || mapping.Access != "read_only" {
			continue
		}
		for _, file := range mapping.Files {
			parts := strings.Split(file.RelativePath, "/")
			if len(parts) == 2 && parts[1] == "SKILL.md" && parts[0] != "" && !seen[parts[0]] {
				seen[parts[0]] = true
				names = append(names, parts[0])
			}
		}
	}
	return names
}

func (r ExecutionResolver) ValidateAgentRunner(ctx context.Context, command protocol.Command, encoded json.RawMessage) error {
	if command.RegistrationID == "" || command.AssignmentRevision == 0 {
		return errors.New("Agent Runner lacks an Agent Runtime Assignment")
	}
	binding, ok, err := r.registration(ctx, command.RegistrationID)
	if err != nil {
		return err
	}
	if !ok || binding.TenantID != command.TenantID {
		return errors.New("Agent Runner Registration binding is invalid")
	}
	if binding.Status != registration.StatusOnline {
		return fmt.Errorf("Agent Runner Local Runtime Registration is %s", binding.Status)
	}
	var payload struct {
		Runtime struct {
			Type string `json:"type"`
		} `json:"runtime"`
		WorkspaceGrantID string `json:"workspace_grant_id"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return err
	}
	installation, ok, err := r.provider(ctx, payload.Runtime.Type)
	if err != nil {
		return err
	}
	if payload.Runtime.Type != binding.ProviderType || !ok || installation.ExecutablePath == "" {
		return errors.New("Agent Runner Runtime is unavailable")
	}
	grant, ok := r.WorkspaceGrants[payload.WorkspaceGrantID]
	if !ok || grant.TenantID != command.TenantID || grant.Path == "" {
		return errors.New("Agent Runner workspace grant is unavailable")
	}
	return nil
}

func (r ExecutionResolver) provider(ctx context.Context, runtimeType string) (ProviderInstallation, bool, error) {
	if r.ProviderLookup != nil {
		return r.ProviderLookup(ctx, runtimeType)
	}
	installation, ok := r.Providers[runtimeType]
	return installation, ok, nil
}

func (r ExecutionResolver) registration(ctx context.Context, registrationID string) (RegistrationBinding, bool, error) {
	if r.RegistrationLookup != nil {
		return r.RegistrationLookup(ctx, registrationID)
	}
	binding, ok := r.Registrations[registrationID]
	return binding, ok, nil
}

type semanticRequest struct {
	Kind    string `json:"kind"`
	Runtime struct {
		Type            string `json:"type"`
		Model           string `json:"model,omitempty"`
		ReasoningEffort string `json:"reasoning_effort,omitempty"`
	} `json:"runtime"`
	SessionOptions struct {
		ThreadName            string  `json:"thread_name"`
		BaseInstructions      *string `json:"base_instructions,omitempty"`
		DeveloperInstructions *string `json:"developer_instructions,omitempty"`
	} `json:"session_options"`
	Session semanticSession `json:"session,omitempty"`
	Input   struct {
		Text string `json:"text,omitempty"`
	} `json:"input,omitempty"`
	RunResources struct {
		MCPServers json.RawMessage `json:"mcp_servers"`
	} `json:"run_resources,omitempty"`
	RunContext struct {
		ExecutionRunRef   string `json:"execution_run_ref,omitempty"`
		HumanInteractions bool   `json:"human_interactions,omitempty"`
		PermissionReview  bool   `json:"permission_review,omitempty"`
	} `json:"run_context,omitempty"`
}

type semanticSession struct {
	ThreadID           string  `json:"thread_id,omitempty"`
	ThreadIDCamel      *string `json:"threadId,omitempty"`
	SessionID          string  `json:"session_id,omitempty"`
	SessionIDCamel     string  `json:"sessionId,omitempty"`
	Provider           string  `json:"provider,omitempty"`
	LingerMaterialized *bool   `json:"lingerMaterialized,omitempty"`
}

func (s semanticSession) threadID() string {
	threadID := ""
	if s.ThreadIDCamel != nil {
		threadID = *s.ThreadIDCamel
	}
	return firstNonEmpty(s.ThreadID, threadID, s.SessionID, s.SessionIDCamel)
}
func (s semanticSession) materialized() bool {
	return s.LingerMaterialized == nil || *s.LingerMaterialized
}

func instructionValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func validReasoningEffort(value string) bool {
	switch value {
	case "none", "low", "medium", "high", "xhigh", "max", "ultra":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

const trustedHostServiceInstructions = "When the user asks for a local server or other process that must remain available after this turn, start it through the Computer daemon with `linger-computer daemon service start <name> -- <command> [args...]`. Do not use shell backgrounding or nohup for a persistent service because command-process containment will stop it. Use `linger-computer daemon service stop <name>` before replacing it, and verify the final localhost URL after the managed start returns."

func cloneEnvironment(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func boundServiceInstructions(command []string) string {
	if len(command) == 0 {
		return "No bound Computer CLI is available in this launch. Do not guess a global linger-computer installation or another Computer config. Report persistent-service management as unavailable if the task needs it."
	}
	encoded, _ := json.Marshal(command)
	return "The current Computer CLI executable and fixed arguments are " + string(encoded) + ". Append daemon service start <name> -- <command> [args...], daemon service list --json, or daemon service stop <name> to this exact argument vector. Quote arguments for the host shell. Do not invoke the bare global linger-computer launcher or choose another config. This binding contains no credential."
}
