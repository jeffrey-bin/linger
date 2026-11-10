package app

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/keywordsearch"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// searchTenantMessages answers GET /v0/tenants/{tenantId}/messages/search:
// conversation Messages whose body contains the query, newest first, limited
// to Rooms the caller can read today. Hits carry the plain Message model
// without card, attachment or thread hydration; the Room view loads those
// when the hit is opened.
func (a *App) searchTenantMessages(c *gin.Context) {
	params := contractParams[httpapi.SearchTenantMessagesParams](c)
	cursor, limit, ok := parsePage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid pagination parameters")
		return
	}
	query, ok := keywordsearch.Normalize(params.Q, keywordsearch.HumanQueryChars)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "q must be between 1 and 200 characters")
		return
	}
	accountID, tenantID := currentPrincipal(c).Session.AccountID, c.Param("tenantId")
	if !a.requireSpace(c, tenantID) {
		return
	}
	page, err := a.collaboration.SearchMessages(c.Request.Context(), accountID, tenantID, query, collaboration.Page{Cursor: cursor, Limit: limit})
	if a.writeSearchTimeout(c, err) {
		return
	}
	if err != nil {
		a.internalError(c, "search messages", err)
		return
	}
	c.JSON(http.StatusOK, page)
}

// writeSearchTimeout answers 503 SEARCH_TIMEOUT when PostgreSQL stopped a
// keyword search at its statement timeout. Clients do not retry it.
func (a *App) writeSearchTimeout(c *gin.Context, err error) bool {
	if !keywordsearch.TimedOut(c.Request.Context(), err) {
		return false
	}
	a.writeError(c, http.StatusServiceUnavailable, "SEARCH_TIMEOUT", "search took too long; narrow the query and try again")
	return true
}
