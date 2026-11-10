package roomagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	agentapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// HTTPGateway adapts TeamHub's Agent management commands to AgentManagement's HTTP contract.
type HTTPGateway struct {
	client        *agentapi.ClientWithResponses
	browserClient *agentapi.ClientWithResponses
}

const agentManagementRequestTimeout = 15 * time.Second

// localBrowserConnectionRequestTimeout covers the Computer's one-minute
// browser verification at the Gateway.
const localBrowserConnectionRequestTimeout = 65 * time.Second

// NewHTTPGateway validates the service endpoint and creates an AgentManagement client.
func NewHTTPGateway(baseURL, token string, client *http.Client) (*HTTPGateway, error) {
	if client == nil {
		client = &http.Client{Timeout: agentManagementRequestTimeout}
	}
	generatedClient, err := NewAgentManagementClient(baseURL, token, client)
	if err != nil {
		return nil, err
	}
	// Keep the browser verification budget separate from ordinary management calls.
	browserHTTPClient := *client
	browserHTTPClient.Timeout = localBrowserConnectionRequestTimeout
	browserClient, err := NewAgentManagementClient(baseURL, token, &browserHTTPClient)
	if err != nil {
		return nil, fmt.Errorf("create browser connection contract client: %w", err)
	}
	return &HTTPGateway{client: generatedClient, browserClient: browserClient}, nil
}

// NewAgentManagementClient validates the Agent Service origin and creates a
// generated AgentManagement client that sends the service token.
func NewAgentManagementClient(baseURL, token string, client *http.Client) (*agentapi.ClientWithResponses, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("invalid AgentManagement base URL")
	}
	if token == "" {
		return nil, errors.New("AgentManagement service token is required")
	}
	authorize := agentapi.WithRequestEditorFn(func(_ context.Context, request *http.Request) error {
		request.Header.Set("Authorization", "Bearer "+token)
		return nil
	})
	generatedClient, err := agentapi.NewClientWithResponses(
		strings.TrimRight(baseURL, "/"), agentapi.WithHTTPClient(client), authorize,
	)
	if err != nil {
		return nil, fmt.Errorf("create AgentManagement contract client: %w", err)
	}
	return generatedClient, nil
}

// NotifyAgentRegistrationChanged wakes Agent Service after TeamHub committed
// a change to one Agent registration.
func (g *HTTPGateway) NotifyAgentRegistrationChanged(ctx context.Context, agentID string) error {
	if !opaqueIDPattern.MatchString(agentID) {
		return errors.New("invalid AgentManagement Agent ID")
	}
	response, err := g.client.NotifyAgentRegistrationChangedWithResponse(ctx, agentID)
	if err != nil {
		return fmt.Errorf("send Agent registration change: %w", err)
	}
	if response.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("AgentManagement returned status %d: %s", response.StatusCode(), truncateUTF8(string(response.Body), 2000))
	}
	return nil
}

// ReadRuntimeHistory reads one page of sanitized native Runtime history for a
// Context; Message Activities filter it to one Message's run.
func (g *HTTPGateway) ReadRuntimeHistory(ctx context.Context, target RuntimeContextTarget, options RuntimeHistoryReadOptions) (RuntimeHistory, error) {
	ref, err := runtimeContextRef(target)
	if err != nil {
		return RuntimeHistory{}, err
	}
	body := agentapi.AgentDebugHistoryRequest{
		TenantId:   target.TenantID,
		ContextKey: target.ContextKey,
		Ref:        ref,
		Cursor:     options.Cursor,
		Limit:      options.Limit,
	}
	response, err := g.client.ReadAgentDebugContextHistoryWithResponse(ctx, body)
	if err != nil {
		return RuntimeHistory{}, fmt.Errorf("read Runtime history: %w", err)
	}
	if response.StatusCode() != http.StatusOK || response.JSON200 == nil {
		return RuntimeHistory{}, fmt.Errorf("AgentManagement returned Runtime history status %d", response.StatusCode())
	}
	upstream := response.JSON200
	if !validRuntimeHistoryStatus(string(upstream.Status)) || strings.TrimSpace(upstream.ProviderKind) == "" {
		return RuntimeHistory{}, errors.New("AgentManagement returned invalid Runtime history")
	}
	result := RuntimeHistory{
		Status: string(upstream.Status), ProviderKind: upstream.ProviderKind,
		Records: make([]RuntimeHistoryRecord, 0, len(upstream.Records)),
	}
	if upstream.Reason != nil {
		result.Reason = *upstream.Reason
	}
	if upstream.PreviousCursor != nil {
		result.PreviousCursor = *upstream.PreviousCursor
	}
	for _, record := range upstream.Records {
		item := RuntimeHistoryRecord{
			Ordinal: record.Ordinal, Timestamp: record.Timestamp, Category: string(record.Category),
			NativeType: record.NativeType, NativeRecord: record.NativeRecord,
			RedactedFields: make([]RuntimeHistoryRedactedField, 0, len(record.RedactedFields)),
		}
		if record.TurnId != nil {
			item.TurnID = *record.TurnId
		}
		if record.ToolCallId != nil {
			item.ToolCallID = *record.ToolCallId
		}
		if record.ToolName != nil {
			item.ToolName = *record.ToolName
		}
		if record.Role != nil {
			item.Role = *record.Role
		}
		if record.Phase != nil {
			item.Phase = *record.Phase
		}
		for _, redacted := range record.RedactedFields {
			item.RedactedFields = append(item.RedactedFields, RuntimeHistoryRedactedField{
				Path: redacted.Path, Reason: string(redacted.Reason), ByteCount: redacted.ByteCount,
			})
		}
		result.Records = append(result.Records, item)
	}
	return result, nil
}

func runtimeContextRef(target RuntimeContextTarget) (agentapi.AgentRuntimeContextRef, error) {
	var ref agentapi.AgentRuntimeContextRef
	if !opaqueIDPattern.MatchString(target.TenantID) || target.ContextKey == "" || len(target.ContextKey) > 1000 || !opaqueIDPattern.MatchString(target.Ref.AgentID) {
		return ref, errors.New("invalid Runtime Context target")
	}
	var err error
	switch target.Ref.Kind {
	case "meta":
		if target.Ref.TaskID != "" || !opaqueIDPattern.MatchString(target.Ref.RoomID) {
			return ref, errors.New("invalid meta Runtime Context target")
		}
		err = ref.FromAgentRuntimeContextRef0(agentapi.AgentRuntimeContextRef0{
			Kind: "meta", AgentId: target.Ref.AgentID, RoomId: target.Ref.RoomID,
		})
	case "alter_ego":
		if target.Ref.RoomID != "" || !opaqueIDPattern.MatchString(target.Ref.TaskID) {
			return ref, errors.New("invalid alter_ego Runtime Context target")
		}
		err = ref.FromAgentRuntimeContextRef1(agentapi.AgentRuntimeContextRef1{
			Kind: "alter_ego", AgentId: target.Ref.AgentID, TaskId: target.Ref.TaskID,
		})
	case "document":
		if target.Ref.RoomID != "" || target.Ref.TaskID != "" || !opaqueIDPattern.MatchString(target.Ref.DocumentID) {
			return ref, errors.New("invalid document Runtime Context target")
		}
		err = ref.FromAgentRuntimeContextRef2(agentapi.AgentRuntimeContextRef2{
			Kind: "document", AgentId: target.Ref.AgentID, DocumentId: target.Ref.DocumentID,
		})
	default:
		return ref, errors.New("invalid Runtime Context kind")
	}
	return ref, err
}

func validRuntimeHistoryStatus(value string) bool {
	return value == "available" || value == "unsupported" || value == "unavailable"
}

// RemoveLocalComputer revokes one owner-scoped Computer after Agent Service verifies it has no current work.
func (g *HTTPGateway) RemoveLocalComputer(ctx context.Context, tenantID, ownerActorID, computerID string) error {
	if !opaqueIDPattern.MatchString(tenantID) || !opaqueIDPattern.MatchString(ownerActorID) || !opaqueIDPattern.MatchString(computerID) {
		return ErrLocalComputerNotFound
	}
	response, err := g.client.RemoveLocalComputerWithResponse(ctx, tenantID, ownerActorID, computerID)
	if err != nil {
		return fmt.Errorf("remove Local Computer: %w", err)
	}
	switch response.StatusCode() {
	case http.StatusNoContent:
		return nil
	case http.StatusNotFound:
		return ErrLocalComputerNotFound
	case http.StatusConflict:
		if response.JSON409 != nil && response.JSON409.Error.Code == "local_computer_busy" {
			return ErrLocalComputerBusy
		}
		return ErrLocalComputerHasAgents
	default:
		return fmt.Errorf("AgentManagement returned status %d: %s", response.StatusCode(), truncateUTF8(string(response.Body), 2000))
	}
}

// ScanLocalSkills asks the owner-scoped Computer to inspect its local Runtime catalog.
func (g *HTTPGateway) ScanLocalSkills(ctx context.Context, command LocalSkillScanCommand) (LocalSkillScan, error) {
	request := agentapi.LocalSkillScanCommandRequest{
		RequestId: command.CommandID, ScanId: command.ScanID,
		RuntimeType: agentapi.LocalSkillScanCommandRequestRuntimeType(command.RuntimeType),
		ExpiresAt:   command.ExpiresAt,
	}
	response, err := g.client.ScanLocalComputerSkillsWithResponse(
		ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request,
	)
	if err != nil {
		return LocalSkillScan{}, fmt.Errorf("scan Local Skills: %w", err)
	}
	if response.StatusCode() != http.StatusOK || response.JSON200 == nil {
		return LocalSkillScan{}, localSkillGatewayError(response.StatusCode(), response.Body)
	}
	result := response.JSON200
	if result.ScanId != command.ScanID || result.ComputerId != command.ComputerID ||
		string(result.RuntimeType) != command.RuntimeType || !result.ExpiresAt.Equal(command.ExpiresAt) {
		return LocalSkillScan{}, errors.New("AgentManagement returned invalid Local Skill scan identity")
	}
	items := make([]LocalSkillCandidate, 0, len(result.Items))
	for _, item := range result.Items {
		if !opaqueIDPattern.MatchString(item.CandidateRef) || strings.TrimSpace(item.Name) == "" ||
			strings.TrimSpace(item.Description) == "" || len(item.PackageSha256) != 64 ||
			(item.Importability != agentapi.LocalSkillCandidateReady &&
				item.Importability != agentapi.LocalSkillCandidateUnsupported) {
			return LocalSkillScan{}, errors.New("AgentManagement returned invalid Local Skill candidate")
		}
		errorCode := ""
		if item.ErrorCode != nil {
			errorCode = *item.ErrorCode
		}
		errorDetail := ""
		if item.ErrorDetail != nil {
			errorDetail = *item.ErrorDetail
		}
		manifestExcerpt := ""
		if item.ManifestExcerpt != nil {
			manifestExcerpt = *item.ManifestExcerpt
		}
		items = append(items, LocalSkillCandidate{
			NativeSource: item.NativeSource, NativeEnabled: item.NativeEnabled,
			CandidateRef: item.CandidateRef, Name: item.Name, Description: item.Description,
			PackageSHA256: item.PackageSha256, FileCount: item.FileCount, SizeBytes: item.SizeBytes,
			Normalizations: append([]string(nil), item.Normalizations...),
			RiskFlags:      append([]string(nil), item.RiskFlags...),
			Importability:  string(item.Importability), ErrorCode: errorCode,
			ErrorDetail: errorDetail, ManifestExcerpt: manifestExcerpt,
		})
	}
	return LocalSkillScan{
		ScanID: result.ScanId, ComputerID: result.ComputerId,
		RuntimeType: string(result.RuntimeType), ExpiresAt: result.ExpiresAt, Items: items,
	}, nil
}

func localSkillGatewayError(status int, body []byte) error {
	switch status {
	case http.StatusNotFound:
		return ErrLocalComputerNotFound
	case http.StatusConflict:
		return ErrLocalSkillCapabilityUnavailable
	case http.StatusServiceUnavailable:
		return ErrLocalComputerNotFound
	default:
		return fmt.Errorf("AgentManagement returned status %d: %s", status, truncateUTF8(string(body), 2000))
	}
}

// CancelRun idempotently asks Agent Service to stop one admitted Run.
func (g *HTTPGateway) CancelRun(ctx context.Context, command RunCancelCommand) (RunCancelResult, error) {
	request := agentapi.CancelAgentRunRequest{RequestId: command.RequestID, RunId: command.RunID}
	if command.AgentID != "" {
		if command.RoomID == "" {
			return RunCancelResult{}, errors.New("invalid Run cancel Context")
		}
		var ref agentapi.AgentRuntimeContextRef
		if err := ref.FromAgentRuntimeContextRef0(agentapi.AgentRuntimeContextRef0{
			Kind: "meta", AgentId: command.AgentID, RoomId: command.RoomID,
		}); err != nil {
			return RunCancelResult{}, err
		}
		request.ContextRef = &ref
	}
	response, err := g.client.CancelAgentRunWithResponse(ctx, command.RunID, request)
	if err != nil {
		return RunCancelResult{}, fmt.Errorf("send Agent Run cancel: %w", err)
	}
	if response.StatusCode() != http.StatusOK || response.JSON200 == nil || response.JSON200.RunId != command.RunID {
		return RunCancelResult{}, fmt.Errorf("AgentManagement returned status %d: %s", response.StatusCode(), truncateUTF8(string(response.Body), 2000))
	}
	return RunCancelResult{RunID: response.JSON200.RunId, Status: string(response.JSON200.Status)}, nil
}

func truncateUTF8(value string, maximumBytes int) string {
	if maximumBytes <= 0 {
		return ""
	}
	value = strings.ReplaceAll(value, "\x00", "\uFFFD")
	value = strings.ToValidUTF8(value, "\uFFFD")
	if len(value) <= maximumBytes {
		return value
	}
	value = value[:maximumBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

// JudgeProactiveEvent asks the Agent Service for the rules a Human's
// AnotherMe judges one outside event by.
func (g *HTTPGateway) JudgeProactiveEvent(ctx context.Context, request agentapi.ProactiveEventJudgeRequest) (agentapi.ProactiveEventJudgement, error) {
	response, err := g.client.JudgeProactiveEventWithResponse(ctx, request)
	if err != nil {
		return agentapi.ProactiveEventJudgement{}, fmt.Errorf("judge proactive event: %w", err)
	}
	if response.JSON200 == nil {
		return agentapi.ProactiveEventJudgement{}, fmt.Errorf("Agent Service judged proactive event with HTTP %d", response.StatusCode())
	}
	return *response.JSON200, nil
}
