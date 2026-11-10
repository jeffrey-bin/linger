package computercli

import (
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// The pending page polls from its inline script, which the CSP must admit
// by the exact hash of the script the page carries.
func TestPendingCallbackPageScriptMatchesItsCSPHash(t *testing.T) {
	recorder := httptest.NewRecorder()
	writePendingCallback(recorder, "state-1", "")
	body := recorder.Body.String()
	script := regexp.MustCompile(`<script data-refresh="([^"]*)" data-progress="([^"]*)">([^<]*)</script>`).FindStringSubmatch(body)
	if script == nil || script[1] != "/callback/status?state=state-1" || script[2] != "/callback/progress?state=state-1" {
		t.Fatalf("pending page has no refresh script: %s", body)
	}
	if csp := recorder.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src '"+scriptHash(script[3])+"'") {
		t.Fatalf("CSP %q does not admit the page script", csp)
	}
	if !strings.Contains(body, `<noscript><meta http-equiv="refresh" content="0.25;url=/callback/status?state=state-1"></noscript>`) {
		t.Fatalf("pending page lost its no-script refresh: %s", body)
	}
}

func TestFinalCallbackPageDoesNotReload(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeCallbackPage(recorder, 200, completedCallbackPage)
	body := recorder.Body.String()
	if strings.Contains(body, "<script") || strings.Contains(body, "refresh") || !strings.Contains(body, "Computer connected") {
		t.Fatalf("final page = %s", body)
	}
}
