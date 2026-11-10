package app

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// Tasks have no finish route: a delegated Task reports through its Run's
// final reply, so neither finish route is mounted.
func TestTaskFinishRoutesAreRetired(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.TeamHubInternalToken = "service-token"
	})}
	engine := gin.New()
	engine.Use(gin.Recovery(), func(c *gin.Context) {
		c.Set("request_id", "request_test")
		c.Next()
	})
	a.registerContractRoutes(engine)
	assertRetiredAgentRoute(t, engine, http.MethodPost,
		"/v0/agents/agent_existing/tasks/task_existing/finish-admissions", `{}`, "service-token")
	assertRetiredAgentRoute(t, engine, http.MethodPost,
		"/api/agent/v1/tasks/task_existing/finish", `{}`, "")
}
