package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentCommentRecoveryBudgetErrorMapsToPayloadTooLarge(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Set("request_id", "request-document-comment-budget")

	if !new(App).writeDocumentCommentError(
		context,
		"attach Document Comment selection Anchor",
		document.ErrCommentRecoveryBudgetExceeded,
	) {
		t.Fatal("Recovery Budget error was not handled")
	}
	if recorder.Code != http.StatusRequestEntityTooLarge ||
		!strings.Contains(recorder.Body.String(), `"code":"PAYLOAD_TOO_LARGE"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
