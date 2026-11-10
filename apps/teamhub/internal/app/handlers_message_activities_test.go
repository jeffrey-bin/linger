package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMessageActivitiesRequireSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodGet, "/v0/rooms/room-1/messages/message-1/activities", nil)
	context.Set("request_id", "request-message-activities")
	newPublicContractTestEngine(&App{}).ServeHTTP(response, context.Request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRunActivitiesRequireSession(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodGet, "/v0/rooms/room-1/runs/run-1/activities", nil)
	context.Set("request_id", "request-run-activities")
	newPublicContractTestEngine(&App{}).ServeHTTP(response, context.Request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", response.Code)
	}
}
