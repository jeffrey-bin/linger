package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	teamhubapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

type agentKnowledgeInput struct {
	Query           string   `json:"query,omitempty"`
	Alternates      []string `json:"alternates,omitempty"`
	DateFrom        *string  `json:"dateFrom,omitempty"`
	DateTo          *string  `json:"dateTo,omitempty"`
	EventFrom       *string  `json:"eventFrom,omitempty"`
	EventTo         *string  `json:"eventTo,omitempty"`
	EvidenceID      string   `json:"evidenceId,omitempty"`
	SectionRequests []struct {
		SectionID string `json:"sectionId"`
		Offset    *int   `json:"offset,omitempty"`
	} `json:"sectionRequests,omitempty"`
}

var (
	agentKnowledgeEvidenceIDPattern = regexp.MustCompile(`^raw_[a-f0-9]{16}_[a-f0-9]{16}$`)
	agentKnowledgeSectionIDPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,127}$`)
)

// searchAgentKnowledge runs one search over every source of the Agent
// owner's knowledge index; each result names its source kind.
func (a *App) searchAgentKnowledge(c *gin.Context) {
	a.agentKnowledge(c, "search_knowledge")
}

// readAgentKnowledge reads sections of one evidence item a search returned.
func (a *App) readAgentKnowledge(c *gin.Context) {
	a.agentKnowledge(c, "read_knowledge")
}

// agentKnowledge authorizes the call once against the Agent's current
// knowledge source and forwards the scoped request to Memory.
func (a *App) agentKnowledge(c *gin.Context, tool string) {
	var input agentKnowledgeInput
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10), &input, "request body must contain one object"); err != nil {
		a.writeAgentAPIError(c, 400, teamhubapi.AgentApiErrorCodeInvalidInput, "Knowledge input is invalid")
		return
	}
	auth, err := a.agentAuth.Authorize(c.Request.Context(), strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "), tool)
	if err == nil && auth.Principal == nil {
		err = agentauth.ErrCredentialInvalid
	}
	if a.writeAgentAuthError(c, "authorize current knowledge source", err) {
		return
	}
	body, err := agentKnowledgeRequest(tool, input, auth)
	if err != nil {
		a.writeAgentAPIError(c, 400, teamhubapi.AgentApiErrorCodeInvalidInput, "Knowledge input or authorized source is invalid")
		return
	}
	if a.memory == nil {
		a.writeAgentAPIError(c, 503, teamhubapi.AgentApiErrorCodeDependencyUnavailable, "Knowledge query is not configured")
		return
	}
	encoded, _ := json.Marshal(body)
	code, result, err := a.memory.Knowledge(c.Request.Context(), tool, encoded)
	if err != nil || code != 200 || !json.Valid(result) {
		if code == 404 {
			a.writeAgentAPIError(c, 404, teamhubapi.AgentApiErrorCode("knowledge_evidence_not_found"), "Knowledge evidence is unavailable")
			return
		}
		a.writeAgentAPIError(c, 503, teamhubapi.AgentApiErrorCodeDependencyUnavailable, "Knowledge query could not complete")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Data(200, "application/json", result)
}

func agentKnowledgeRequest(tool string, input agentKnowledgeInput, identity agentauth.Authorization) (map[string]any, error) {
	invalid := errors.New("invalid knowledge request")
	if identity.TenantID == "" || identity.UserArtifactOwnerActorID == "" || identity.PersonalKnowledgeAgentID == "" {
		return nil, invalid
	}
	result := map[string]any{
		"tenant_id": identity.TenantID, "user_artifact_owner_actor_id": identity.UserArtifactOwnerActorID,
		"agent_actor_id": identity.AgentActorID, "agent_id": identity.PersonalKnowledgeAgentID,
	}
	switch tool {
	case "search_knowledge":
		if strings.TrimSpace(input.Query) == "" || utf8.RuneCountInString(input.Query) > 10000 || input.EvidenceID != "" || len(input.SectionRequests) > 0 {
			return nil, invalid
		}
		result["query"] = input.Query
		if len(input.Alternates) > 6 {
			return nil, invalid
		}
		for _, alternate := range input.Alternates {
			if strings.TrimSpace(alternate) == "" || utf8.RuneCountInString(alternate) > 200 {
				return nil, invalid
			}
		}
		if len(input.Alternates) > 0 {
			result["alternates"] = input.Alternates
		}
		// Agents copy the current date into source filters, hiding earlier records.
		// Every Agent time range is one soft window that ranks matching facts and
		// chunks higher without excluding others; event bounds take precedence.
		from, to := input.DateFrom, input.DateTo
		if input.EventFrom != nil || input.EventTo != nil {
			from, to = input.EventFrom, input.EventTo
		}
		for _, value := range []*string{input.DateFrom, input.DateTo, input.EventFrom, input.EventTo} {
			if value != nil {
				if _, err := time.Parse("2006-01-02", *value); err != nil {
					return nil, invalid
				}
			}
		}
		if from != nil {
			result["event_from"] = *from
		}
		if to != nil {
			result["event_to"] = *to
		}
		if input.DateFrom != nil && input.DateTo != nil && *input.DateFrom > *input.DateTo ||
			input.EventFrom != nil && input.EventTo != nil && *input.EventFrom > *input.EventTo {
			return nil, invalid
		}
	case "read_knowledge":
		if len(input.Alternates) > 0 || input.Query != "" || input.DateFrom != nil || input.DateTo != nil || input.EventFrom != nil || input.EventTo != nil {
			return nil, invalid
		}
		if !agentKnowledgeEvidenceIDPattern.MatchString(input.EvidenceID) || len(input.SectionRequests) < 1 || len(input.SectionRequests) > 8 {
			return nil, invalid
		}
		result["evidence_id"] = input.EvidenceID
		sections := make([]map[string]any, 0, len(input.SectionRequests))
		seenSections := make(map[string]bool)
		for _, r := range input.SectionRequests {
			if !agentKnowledgeSectionIDPattern.MatchString(r.SectionID) || r.Offset != nil && (*r.Offset < 0 || *r.Offset > 200000) {
				return nil, invalid
			}
			if seenSections[r.SectionID] {
				return nil, invalid
			}
			seenSections[r.SectionID] = true
			section := map[string]any{"section_id": r.SectionID}
			if r.Offset != nil {
				section["offset"] = *r.Offset
			}
			sections = append(sections, section)
		}
		result["section_requests"] = sections
	default:
		return nil, invalid
	}
	return result, nil
}
