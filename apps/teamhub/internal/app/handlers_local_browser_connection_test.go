package app

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

const testBrowserToken = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U_-"

func TestNormalizeBrowserExtensionTokenTreatsPastedTextAsData(t *testing.T) {
	for _, input := range []string{
		testBrowserToken,
		"  " + testBrowserToken + "\n",
		"PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + testBrowserToken,
		"\r\nPLAYWRIGHT_MCP_EXTENSION_TOKEN=\"" + testBrowserToken + "\"\r\n",
		"PLAYWRIGHT_MCP_EXTENSION_TOKEN='" + testBrowserToken + "'",
		"\"PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + testBrowserToken + "\"",
		"'" + testBrowserToken + "'",
	} {
		if got, ok := normalizeBrowserExtensionToken(input); !ok || got != testBrowserToken {
			t.Fatalf("normalize(%q)=%q,%v", input, got, ok)
		}
	}
	for _, input := range []string{
		"",
		"short",
		"PLAYWRIGHT_MCP_EXTENSION_TOKEN=",
		"PLAYWRIGHT_MCP_EXTENSION_TOKEN=PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + testBrowserToken,
		"export PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + testBrowserToken,
		testBrowserToken + "; rm -rf ~",
		"$(" + testBrowserToken + ")",
		"\"" + testBrowserToken + "'",
		testBrowserToken + " " + testBrowserToken,
		strings.Repeat("a", 257),
	} {
		if got, ok := normalizeBrowserExtensionToken(input); ok || got != "" {
			t.Fatalf("normalize(%q)=%q,%v want rejection", input, got, ok)
		}
	}
}

func TestPutBrowserConnectionRejectsInvalidTokenWithoutEchoOrLogs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	secret := "PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + testBrowserToken + "; curl attacker"
	for _, body := range []string{
		`{"extension_token":"` + secret + `"}`,
		`{"extension_token":"` + testBrowserToken + `","profile":"../../etc"}`,
		`{"extension_token":"` + testBrowserToken + `","unexpected":"` + testBrowserToken + `"}`,
	} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPut, "/v0/tenants/tenant_1/local-computers/computer_1/browser-connection", strings.NewReader(body))
		c.Set("request_id", "request_1")
		a.putLocalComputerBrowserConnection(c)
		if recorder.Code != http.StatusBadRequest || strings.Contains(recorder.Body.String(), testBrowserToken) {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	}
	if logs.Len() != 0 {
		t.Fatalf("logs=%s", logs.String())
	}
}

func TestBrowserConnectionFailuresKeepOnlyKnownComputerCodes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{logger: slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))}
	for _, test := range []struct {
		err  error
		want string
	}{
		{&roomagent.LocalBrowserConnectionError{Code: "BROWSER_TOKEN_REJECTED"}, "BROWSER_TOKEN_REJECTED"},
		{&roomagent.LocalBrowserConnectionError{Code: "BROWSER_EXTENSION_UNAVAILABLE"}, "BROWSER_EXTENSION_UNAVAILABLE"},
		{&roomagent.LocalBrowserConnectionError{Code: "SOMETHING_ELSE"}, "BROWSER_CONNECTION_FAILED"},
		{roomagent.ErrLocalBrowserConnectionFailed, "BROWSER_CONNECTION_FAILED"},
	} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPut, "/v0/tenants/tenant_1/local-computers/computer_1/browser-connection", nil)
		c.Set("request_id", "request_1")
		a.writeLocalBrowserConnectionError(c, roomagent.LocalBrowserConnectionConfigure, test.err)
		if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), `"code":"`+test.want+`"`) {
			t.Fatalf("err=%v status=%d body=%s", test.err, recorder.Code, recorder.Body.String())
		}
	}
}
