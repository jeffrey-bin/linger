package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func spaceTestSession() store.GetActiveSessionRow {
	return store.GetActiveSessionRow{
		ID: "session", AccountID: "account_alice", Email: "alice@example.com",
		AccountCreatedAt: pgtype.Timestamptz{Time: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), Valid: true},
		HumanActorID:     "actor_alice", HumanTenantID: "tenant_space", HumanDisplayName: "alice",
	}
}

func spaceTestContext(path string) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, path, nil)
	c.Set("request_id", "space-test")
	c.Set(principalKey, principal{Session: spaceTestSession()})
	return c, recorder
}

func TestValidSessionIsTheSpaceMembership(t *testing.T) {
	application := &App{}
	for _, tenantID := range []string{"tenant_space", "tenant_other", ""} {
		c, recorder := spaceTestContext("/v0/tenants/" + tenantID)
		humanID, ok := application.spaceHuman(c, tenantID)
		if want := tenantID == "tenant_space"; ok != want {
			t.Fatalf("tenant %q allowed=%v want %v", tenantID, ok, want)
		}
		if ok && humanID != "actor_alice" {
			t.Fatalf("Space Human=%q want the session's Human Actor", humanID)
		}
		if !ok && recorder.Code != http.StatusNotFound {
			t.Fatalf("tenant %q status=%d want 404", tenantID, recorder.Code)
		}
	}
}

func TestTenantRoutesAnswerWithTheSessionSpace(t *testing.T) {
	application := &App{}
	c, recorder := spaceTestContext("/v0/tenants")
	application.listTenants(c)
	var list httpapi.TenantList
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Id != "tenant_space" || list.Items[0].Name != "alice's Workspace" ||
		!list.Items[0].CreatedAt.Equal(spaceTestSession().AccountCreatedAt.Time) {
		t.Fatalf("tenants=%+v", list.Items)
	}

	c, recorder = spaceTestContext("/v0/tenants/tenant_other")
	c.Params = gin.Params{{Key: "tenantId", Value: "tenant_other"}}
	application.getTenant(c)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("another Space status=%d want 404", recorder.Code)
	}
}
