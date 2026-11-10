package app

import (
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getAgentMemory(c *gin.Context) {
	agentID := c.Param("agentId")
	value, err := a.agentRuntimeState.ReadMemory(c.Request.Context(), agentID)
	if a.writeAgentRuntimeStateError(c, "Agent memory", err) {
		return
	}
	c.Data(http.StatusOK, "application/json", value)
}

func (a *App) commitAgentMemory(c *gin.Context) {
	agentID := c.Param("agentId")
	var input teamhubinternal.AgentMemoryDocument
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4<<20), &input, "invalid memory"); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid Agent memory")
		return
	}
	if !validAgentMemory(input) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid Agent memory limits")
		return
	}
	data, err := json.Marshal(input)
	if err == nil {
		data, err = a.agentRuntimeState.CommitMemory(c.Request.Context(), agentID, int64(input.Revision), data)
	}
	if a.writeAgentRuntimeStateError(c, "Agent memory", err) {
		return
	}
	c.Data(http.StatusOK, "application/json", data)
}

var memoryKey = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validAgentMemory(input teamhubinternal.AgentMemoryDocument) bool {
	if input.Sessions == nil || input.Cursors == nil || len(input.Summary) > 8000 || len(input.Memory) > 200000 || len(input.Sessions) > 30 || input.Revision < 0 {
		return false
	}
	for key, session := range input.Sessions {
		if !memoryKey.MatchString(key) || session.ContextKey == "" || session.ThreadId == "" || session.Through < 0 || session.UpdatedRevision < 1 || session.UpdatedRevision > input.Revision+1 || len(session.Summary) > 32000 || len(session.RawMemory) > 96000 {
			return false
		}
	}
	for key, cursor := range input.Cursors {
		if !memoryKey.MatchString(key) || cursor.ThreadId == "" || cursor.Through < 0 {
			return false
		}
	}
	if p := input.Pending; p != nil {
		if (p.Stage != "extract" && p.Stage != "consolidate") || len(p.Prompt) > 400000 || (p.Attempt != nil && (*p.Attempt < 0 || *p.Attempt > 3)) {
			return false
		}
		// Only an extraction reads one source session; a consolidation has none.
		source := p.SourceKey != nil || p.ThreadId != nil || p.Through != nil
		if p.Stage == "consolidate" {
			return !source
		}
		if p.SourceKey == nil || !memoryKey.MatchString(*p.SourceKey) || p.ThreadId == nil || *p.ThreadId == "" || p.Through == nil || *p.Through < 0 {
			return false
		}
	}
	return true
}
