package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalinsight"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listPersonalInsights(c *gin.Context) {
	result, err := a.personalInsights.List(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"))
	if a.writePersonalInsightError(c, "list Personal Insights", err) {
		return
	}
	model := httpapi.PersonalInsightList{Items: make([]httpapi.PersonalInsight, 0, len(result.Items))}
	for _, item := range result.Items {
		model.Items = append(model.Items, httpapi.PersonalInsight{
			Id: item.ID, Dimension: item.Dimension, Statement: item.Statement, CreatedAt: item.CreatedAt,
		})
	}
	if result.Generation != nil {
		model.LatestGeneration = &httpapi.PersonalInsightGeneration{
			Status: result.Generation.Status, UpdatedAt: result.Generation.UpdatedAt,
		}
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) deletePersonalInsight(c *gin.Context) {
	err := a.personalInsights.Dismiss(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), c.Param("personalInsightId"))
	if a.writePersonalInsightError(c, "delete Personal Insight", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) writePersonalInsightError(c *gin.Context, action string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, personalinsight.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Personal Insight was not found")
	default:
		a.internalError(c, action, err)
	}
	return true
}
