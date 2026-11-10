package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentCreationApprovalRequestMaxBytes = 5 << 20

type agentCreationApprovalService interface {
	Submit(context.Context, string, agentcreationapproval.Input) (agentcreationapproval.Result, error)
	ListAvailableAgents(context.Context, string, string, int) (agentcreationapproval.AvailableAgentPage, error)
}

func (a *App) listAvailableAgents(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentListAvailableAgentsRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentCreationApprovalRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeInvalidAgentCreationApproval(c)
		return
	}
	limit := 50
	if request.Limit != nil {
		limit = int(*request.Limit)
	}
	cursor := ""
	if request.Cursor != nil {
		cursor = *request.Cursor
	}
	result, err := a.agentCreationApprovals.ListAvailableAgents(
		c.Request.Context(), token,
		cursor, limit,
	)
	// `teamhub agent list` is the only caller, so report eligibility in CLI terms.
	if errors.Is(err, agentauth.ErrForbidden) || errors.Is(err, agentcreationapproval.ErrForbidden) {
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Only an Agent in its Meta Context can list available Agents")
		return
	}
	if a.writeAgentCreationApprovalError(c, err) {
		return
	}
	agents := make([]teamhubagentapi.AgentAvailableAgent, 0, len(result.Agents))
	for _, agent := range result.Agents {
		if agent.ActorID == "" || strings.TrimSpace(agent.Name) == "" {
			a.writeAgentCreationApprovalError(c, agentcreationapproval.ErrUnavailable)
			return
		}
		agents = append(agents, teamhubagentapi.AgentAvailableAgent{
			ActorId: agent.ActorID, Name: agent.Name, Description: agent.Description,
		})
	}
	response := teamhubagentapi.AgentListAvailableAgentsResponse{
		Agents: agents,
	}
	if result.NextCursor != "" {
		response.NextCursor = &result.NextCursor
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) submitAgentCreationApprovalRequest(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentRoomCreationApprovalRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentCreationApprovalRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeInvalidAgentCreationApproval(c)
		return
	}
	input, err := agentCreationApprovalRequestToDomain(request)
	if err != nil {
		a.writeInvalidAgentCreationApproval(c)
		return
	}
	result, err := a.agentCreationApprovals.Submit(c.Request.Context(), token, input)
	if a.writeAgentCreationApprovalError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentCreationApprovalResponse{
		Accepted: true, Status: "pending_approval",
		CreationApprovalRequestId: result.CreationApprovalRequestID,
		MessageId:                 result.MessageID,
	})
}
func agentCreationApprovalRequestToDomain(
	value teamhubagentapi.AgentRoomCreationApprovalRequest,
) (agentcreationapproval.Input, error) {
	if value.RequestKind != "room_creation" {
		return agentcreationapproval.Input{}, errors.New("invalid Room Creation approval")
	}
	callerSegments, err := creationSegmentsToDomain(value.CallerInput.InitialMessageSegments)
	if err != nil {
		return agentcreationapproval.Input{}, err
	}
	effectiveSegments, err := creationSegmentsToDomain(value.EffectivePayload.InitialMessageSegments)
	if err != nil {
		return agentcreationapproval.Input{}, err
	}
	callerJSON, err := json.Marshal(value.CallerInput)
	if err != nil {
		return agentcreationapproval.Input{}, err
	}
	effectiveJSON, err := json.Marshal(value.EffectivePayload)
	if err != nil {
		return agentcreationapproval.Input{}, err
	}
	var callerArtifacts, effectiveArtifacts []string
	if value.CallerInput.Artifacts != nil {
		callerArtifacts = append([]string(nil), (*value.CallerInput.Artifacts)...)
	}
	if value.EffectivePayload.Artifacts != nil {
		effectiveArtifacts = append([]string(nil), (*value.EffectivePayload.Artifacts)...)
	}
	return agentcreationapproval.Input{
		RequestKind: "room_creation",
		RoomCaller: &agentcreationapproval.RoomCallerInput{
			Name: value.CallerInput.Name, Description: value.CallerInput.Description,
			MemberIDs: append([]string(nil), value.CallerInput.MemberIds...), Artifacts: callerArtifacts,
			InitialMessageSegments: callerSegments,
		},
		RoomEffective: &agentcreationapproval.RoomEffectivePayload{
			Name: value.EffectivePayload.Name, Description: value.EffectivePayload.Description,
			MemberIDs: append([]string(nil), value.EffectivePayload.MemberIds...), Artifacts: effectiveArtifacts,
			InitialMessageSegments: effectiveSegments,
		},
		SourceInboxIDs:  append([]string(nil), []string{}...),
		InvocationID:    value.InvocationId,
		CallerInputJSON: callerJSON, EffectivePayloadJSON: effectiveJSON,
	}, nil
}

func creationSegmentsToDomain(values []teamhubagentapi.AgentCreationMessageSegment) ([]messagecreation.Segment, error) {
	result := make([]messagecreation.Segment, 0, len(values))
	for _, segment := range values {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return nil, err
		}
		switch discriminator {
		case "text":
			value, err := segment.AsAgentTextMessageSegment()
			if err != nil || value.Type != "text" {
				return nil, errors.New("invalid Creation text segment")
			}
			result = append(result, messagecreation.Segment{Type: "text", Content: value.Content})
		case "reference":
			value, err := segment.AsAgentReferenceMessageSegment()
			if err != nil || value.Type != "reference" || !value.TargetType.Valid() {
				return nil, errors.New("invalid Creation reference segment")
			}
			result = append(result, messagecreation.Segment{
				Type: "reference", Content: value.Content, Target: value.Target, TargetType: string(value.TargetType),
			})
		default:
			return nil, errors.New("invalid Creation segment discriminator")
		}
	}
	return result, nil
}
func (a *App) writeInvalidAgentCreationApproval(c *gin.Context) {
	a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Agent Creation approval request is invalid")
}

func (a *App) writeAgentCreationApprovalError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentcreationapproval.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeInvalidAgentCreationApproval(c)
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "Creation Tool is not allowed for this Context"))
	case errors.Is(err, agentcreationapproval.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Creation provenance is not authorized")
	case errors.Is(err, agentcreationapproval.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "Creation target is unavailable")
	case errors.Is(err, agentcreationapproval.ErrConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeVersionConflict, "Creation effective payload conflicts with TeamHub authority")
	case errors.Is(err, agentcreationapproval.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Agent Creation invocation was reused with different caller input")
	case errors.Is(err, agentcreationapproval.ErrUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Agent Creation approval service is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("Agent Creation approval", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Agent Creation approval service could not complete the request")
	}
	return true
}
