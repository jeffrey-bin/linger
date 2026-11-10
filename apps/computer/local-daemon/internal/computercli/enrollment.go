package computercli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

var (
	idPattern               = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	enrollmentSecretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)
)

// credentialBundle is the Gateway credential TeamHub issues for a Computer.
type credentialBundle struct {
	ComputerID          string `json:"computer_id"`
	CredentialExpiresAt string `json:"credential_expires_at"`
	GatewayToken        string `json:"gateway_token"`
	GatewayURL          string `json:"gateway_url"`
	TenantID            string `json:"tenant_id"`
}

// credentialExpiredError reports a well-formed credential past its expiry.
type credentialExpiredError struct{ computerID string }

func (e *credentialExpiredError) Error() string { return "Local Computer credential has expired" }

// replacementRequiredError means the signed-in account cannot renew the
// existing Computer; the browser page waits for the replacement enrollment.
type replacementRequiredError struct {
	continueInBrowser func(url string)
	failBrowser       func()
}

func (e *replacementRequiredError) Error() string {
	return "The existing Local Computer cannot be renewed by the signed-in account"
}

var errEnrollmentCancelled = newError(categoryCredential, "Local Computer setup was cancelled; the existing Computer remains connected")

var errEnrollmentRemoved = errors.New("Local Computer enrollment was removed")

// acquisition is an issued credential and the browser page waiting on it.
type acquisition struct {
	bundle   credentialBundle
	complete func()
	fail     func()
	progress func(progress string)
}

type enrollmentOptions struct {
	callbackTimeout    time.Duration
	displayName        string
	existingComputerID string
	gatewayURL         string
	serverToken        *serverToken
	webURL             string
}

type enrollmentDeps struct {
	httpClient  *http.Client
	openBrowser func(url string) error
	listeners   *listenerGroup
}

func obtainComputerCredential(ctx context.Context, options enrollmentOptions, deps enrollmentDeps) (*acquisition, error) {
	if token := options.serverToken; token != nil {
		if expiry, _ := time.Parse(time.RFC3339Nano, token.ExpiresAt); !expiry.After(time.Now()) {
			return nil, newError(categoryCredential, "Server connection token has expired; generate a new token in Computers")
		}
		bundle, err := exchangeEnrollment(ctx, deps.httpClient, options.webURL, "http://127.0.0.1:9/callback", token.CodeVerifier, callbackResult{kind: "authorization", enrollmentID: token.EnrollmentID, code: token.AuthorizationCode})
		if err != nil {
			return nil, newError(categoryCredential, "Server token exchange failed or its result is uncertain. Retry only this same token; if it was consumed, check the Computer in the product. No new Computer was requested.")
		}
		if bundle.ComputerID != token.ComputerID || bundle.TenantID != token.TenantID {
			return nil, newError(categoryCredential, "Server token exchange returned a different Computer or workspace")
		}
		if err := checkGatewayOverride(bundle, options.gatewayURL); err != nil {
			return nil, err
		}
		return &acquisition{bundle: bundle, complete: func() {}, fail: func() {}, progress: func(string) {}}, nil
	}
	state, codeVerifier := randomToken(), randomToken()
	challenge := sha256.Sum256([]byte(codeVerifier))
	callback, err := startCallbackListener(state, options.callbackTimeout, deps.listeners)
	if err != nil {
		return nil, err
	}
	authorizationURL, err := createAuthorizationURL(options, base64.RawURLEncoding.EncodeToString(challenge[:]), callback.redirectURI, state)
	if err != nil {
		callback.fail()
		return nil, err
	}
	if err := deps.openBrowser(authorizationURL); err != nil {
		callback.fail()
		return nil, err
	}
	authorization, err := callback.wait(ctx)
	if err != nil {
		callback.fail()
		return nil, err
	}
	switch authorization.kind {
	case "cancelled":
		callback.cancel()
		return nil, errEnrollmentCancelled
	case "replacement-required":
		return nil, &replacementRequiredError{continueInBrowser: callback.navigate, failBrowser: callback.fail}
	}
	bundle, err := exchangeEnrollment(ctx, deps.httpClient, options.webURL, callback.redirectURI, codeVerifier, authorization)
	if errors.Is(err, errEnrollmentRemoved) {
		return nil, &replacementRequiredError{continueInBrowser: callback.navigate, failBrowser: callback.fail}
	}
	if err == nil {
		err = checkGatewayOverride(bundle, options.gatewayURL)
	}
	if err != nil {
		callback.fail()
		return nil, err
	}
	return &acquisition{bundle: bundle, complete: callback.complete, fail: callback.fail, progress: callback.updateProgress}, nil
}

func randomToken() string {
	var value [32]byte
	_, _ = rand.Read(value[:])
	return base64.RawURLEncoding.EncodeToString(value[:])
}

func createAuthorizationURL(options enrollmentOptions, challenge, redirectURI, state string) (string, error) {
	base, err := url.Parse(options.webURL)
	if err != nil {
		return "", err
	}
	target := base.ResolveReference(&url.URL{Path: "/connect-computer"})
	query := url.Values{}
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("display_name", options.displayName)
	if options.existingComputerID != "" {
		if !idPattern.MatchString(options.existingComputerID) {
			return "", newError(categoryConfiguration, "Existing Computer ID is invalid")
		}
		query.Set("computer_id", options.existingComputerID)
	}
	target.RawQuery = query.Encode()
	return target.String(), nil
}

func exchangeEnrollment(ctx context.Context, client *http.Client, webURL, redirectURI, codeVerifier string, authorization callbackResult) (credentialBundle, error) {
	base, err := url.Parse(webURL)
	if err != nil {
		return credentialBundle{}, err
	}
	endpoint := base.ResolveReference(&url.URL{Path: "/v0/local-computer-enrollments/" + authorization.enrollmentID + "/exchange"})
	body, _ := json.Marshal(map[string]string{
		"authorization_code": authorization.code, "code_verifier": codeVerifier, "redirect_uri": redirectURI,
	})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return credentialBundle{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return credentialBundle{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusGone {
		return credentialBundle{}, errEnrollmentRemoved
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		category := categoryCredential
		if response.StatusCode >= 500 {
			category = categoryNetwork
		}
		return credentialBundle{}, newError(category, fmt.Sprintf("TeamHub rejected Local Computer setup (%d)", response.StatusCode))
	}
	var value map[string]any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		return credentialBundle{}, invalidCredential()
	}
	return parseCredentialBundle(value)
}

// noRedirects keeps credential exchange on the configured origin.
func noRedirects(*http.Request, []*http.Request) error {
	return errors.New("credential exchange must not redirect")
}

func parseCredentialBundle(value map[string]any) (credentialBundle, error) {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	bundle := credentialBundle{
		ComputerID: stringField(value, "computer_id"), CredentialExpiresAt: stringField(value, "credential_expires_at"),
		GatewayToken: stringField(value, "gateway_token"), GatewayURL: stringField(value, "gateway_url"),
		TenantID: stringField(value, "tenant_id"),
	}
	expiry, expiryErr := time.Parse(time.RFC3339Nano, bundle.CredentialExpiresAt)
	if strings.Join(keys, ",") != "computer_id,credential_expires_at,gateway_token,gateway_url,tenant_id" ||
		!idPattern.MatchString(bundle.ComputerID) || !idPattern.MatchString(bundle.TenantID) ||
		len(bundle.GatewayToken) < 32 || len(bundle.GatewayToken) > 4096 ||
		strings.IndexFunc(bundle.GatewayToken, unicode.IsSpace) != -1 || expiryErr != nil {
		return credentialBundle{}, invalidCredential()
	}
	if err := validateGatewayURL(bundle.GatewayURL); err != nil {
		return credentialBundle{}, err
	}
	if !expiry.After(time.Now()) {
		return credentialBundle{}, &credentialExpiredError{computerID: bundle.ComputerID}
	}
	return bundle, nil
}

// validateGatewayURL accepts wss:// or plain ws:// to any host, without
// embedded credentials.
func validateGatewayURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return newError(categoryConfiguration, "Gateway URL is invalid")
	}
	if parsed.User != nil {
		return newError(categoryConfiguration, "Gateway URL must not contain credentials")
	}
	if parsed.Scheme != "wss" && parsed.Scheme != "ws" {
		return newError(categoryConfiguration, "Gateway URL must use wss or ws")
	}
	return nil
}

func checkGatewayOverride(bundle credentialBundle, gatewayURL string) error {
	if gatewayURL != "" && gatewayURL != bundle.GatewayURL {
		return newError(categoryCredential, "Configured Gateway URL does not match the TeamHub-issued credential")
	}
	return nil
}

func invalidCredential() error {
	return newError(categoryCredential, "TeamHub returned an invalid Local Computer credential")
}

// serverToken is the connection token the Web app generates for a computer
// without a browser.
type serverToken struct {
	Origin            string `json:"origin"`
	DisplayName       string `json:"display_name"`
	EnrollmentID      string `json:"enrollment_id"`
	ComputerID        string `json:"computer_id"`
	TenantID          string `json:"tenant_id"`
	AuthorizationCode string `json:"authorization_code"`
	CodeVerifier      string `json:"code_verifier"`
	ExpiresAt         string `json:"expires_at"`
}

const serverTokenPrefix = "linger-connect-v1."

var (
	tokenPayload = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	tokenSecret  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func parseServerToken(input string) (*serverToken, error) {
	invalid := newError(categoryCredential, "Invalid server connection token")
	input = strings.TrimSpace(input)
	if !strings.HasPrefix(input, serverTokenPrefix) {
		return nil, invalid
	}
	encoded := strings.TrimPrefix(input, serverTokenPrefix)
	if len(encoded) > 8192 || !tokenPayload.MatchString(encoded) {
		return nil, invalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(encoded, "="))
	if err != nil {
		return nil, invalid
	}
	var fields map[string]any
	if json.Unmarshal(payload, &fields) != nil {
		return nil, invalid
	}
	keys := make([]string, 0, len(fields))
	for key, value := range fields {
		if _, isText := value.(string); !isText {
			return nil, invalid
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "authorization_code,code_verifier,computer_id,display_name,enrollment_id,expires_at,origin,tenant_id" {
		return nil, invalid
	}
	var token serverToken
	if json.Unmarshal(payload, &token) != nil || strings.TrimSpace(token.DisplayName) == "" || len([]rune(token.DisplayName)) > 120 {
		return nil, invalid
	}
	for _, value := range []string{token.ComputerID, token.TenantID, token.EnrollmentID} {
		if !idPattern.MatchString(value) {
			return nil, invalid
		}
	}
	for _, value := range []string{token.AuthorizationCode, token.CodeVerifier} {
		if !tokenSecret.MatchString(value) {
			return nil, invalid
		}
	}
	origin, err := url.Parse(token.Origin)
	if err != nil || origin.User != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.Scheme+"://"+origin.Host != token.Origin {
		return nil, invalid
	}
	if _, err := time.Parse(time.RFC3339Nano, token.ExpiresAt); err != nil {
		return nil, invalid
	}
	return &token, nil
}

// callbackResult is what the browser returned to the loopback callback.
type callbackResult struct {
	kind         string // authorization, cancelled or replacement-required
	enrollmentID string
	code         string
}

// listenerGroup lets setup wait until every callback page has been served
// its final answer before the command exits.
type listenerGroup struct{ sync.WaitGroup }

type callbackListener struct {
	redirectURI string
	server      *http.Server
	results     chan callbackResult
	timeout     time.Duration

	mu         sync.Mutex
	accepted   bool
	progress   string
	navigation *navigation
	closed     bool
	retirement *time.Timer
	done       func()
}

type navigation struct{ kind, url string }

func startCallbackListener(state string, timeout time.Duration, group *listenerGroup) (*callbackListener, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, wrapError(categoryNetwork, "Local Computer callback did not bind to loopback", err)
	}
	host := listener.Addr().String()
	callback := &callbackListener{
		redirectURI: "http://" + host + "/callback", results: make(chan callbackResult, 1),
		timeout: timeout, progress: "exchanging-credential",
	}
	group.Add(1)
	var once sync.Once
	callback.done = func() { once.Do(group.Done) }
	callback.server = &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		callback.serve(writer, request, host, state)
	})}
	go func() {
		_ = callback.server.Serve(listener)
		callback.done()
	}()
	return callback, nil
}

func (c *callbackListener) serve(writer http.ResponseWriter, request *http.Request, host, state string) {
	remote, _, _ := net.SplitHostPort(request.RemoteAddr)
	if request.Method != http.MethodGet || remote != "127.0.0.1" || request.Host != host {
		writeCallbackPage(writer, http.StatusBadRequest, invalidCallbackPage)
		return
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		writeCallbackPage(writer, http.StatusBadRequest, invalidCallbackPage)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if request.URL.Path == "/callback/progress" && exactQuery(query, "state") && query.Get("state") == state {
		// The pending page polls this without leaving, so the card stays put
		// until the final answer is ready at /callback/status.
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		_ = json.NewEncoder(writer).Encode(map[string]any{"done": c.navigation != nil, "message": pendingCallbackMessage(c.progress)})
		return
	}
	if request.URL.Path == "/callback/status" && exactQuery(query, "state") && query.Get("state") == state {
		if c.navigation == nil {
			writePendingCallback(writer, state, c.progress)
			return
		}
		switch c.navigation.kind {
		case "redirect":
			writer.Header().Set("Cache-Control", "no-store")
			writer.Header().Set("Location", c.navigation.url)
			writer.Header().Set("X-Content-Type-Options", "nosniff")
			writer.WriteHeader(http.StatusSeeOther)
		case "completed":
			writeCallbackPage(writer, http.StatusOK, completedCallbackPage)
		case "cancelled":
			writeCallbackPage(writer, http.StatusOK, cancelledCallbackPage)
		default:
			writeCallbackPage(writer, http.StatusInternalServerError, failedCallbackPage)
		}
		c.closeLocked()
		return
	}
	result, ok := readCallback(request.URL.Path, query, state)
	if !ok || c.accepted {
		writeCallbackPage(writer, http.StatusBadRequest, invalidCallbackPage)
		return
	}
	c.accepted = true
	writePendingCallback(writer, state, c.progress)
	c.results <- result
}

func exactQuery(query url.Values, keys ...string) bool {
	if len(query) != len(keys) {
		return false
	}
	for _, key := range keys {
		if len(query[key]) != 1 {
			return false
		}
	}
	return true
}

func readCallback(path string, query url.Values, state string) (callbackResult, bool) {
	if path != "/callback" || len(query["state"]) == 0 || query.Get("state") != state {
		return callbackResult{}, false
	}
	if exactQuery(query, "error", "state") {
		switch query.Get("error") {
		case "local_computer_replacement_cancelled":
			return callbackResult{kind: "cancelled"}, true
		case "local_computer_removed", "local_computer_replacement_required":
			return callbackResult{kind: "replacement-required"}, true
		}
	}
	if !exactQuery(query, "code", "enrollment_id", "state") {
		return callbackResult{}, false
	}
	enrollmentID, code := query.Get("enrollment_id"), query.Get("code")
	if !idPattern.MatchString(enrollmentID) || !enrollmentSecretPattern.MatchString(code) {
		return callbackResult{}, false
	}
	return callbackResult{kind: "authorization", enrollmentID: enrollmentID, code: code}, true
}

func (c *callbackListener) wait(ctx context.Context) (callbackResult, error) {
	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	select {
	case result := <-c.results:
		return result, nil
	case <-timer.C:
		return callbackResult{}, newError(categoryNetwork, "Timed out waiting for browser authorization")
	case <-ctx.Done():
		return callbackResult{}, ctx.Err()
	}
}

func (c *callbackListener) settle(next navigation) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.navigation = &next
	c.retireLocked()
}

func (c *callbackListener) cancel()             { c.settle(navigation{kind: "cancelled"}) }
func (c *callbackListener) navigate(url string) { c.settle(navigation{kind: "redirect", url: url}) }

func (c *callbackListener) complete() { c.settle(navigation{kind: "completed"}) }

func (c *callbackListener) fail() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.accepted {
		c.closeLocked()
		return
	}
	c.navigation = &navigation{kind: "failed"}
	c.retireLocked()
}

func (c *callbackListener) updateProgress(progress string) {
	c.mu.Lock()
	c.progress = progress
	c.mu.Unlock()
}

// callbackAnswerWindow bounds how long a settled callback page stays
// answerable. Chrome can delay the refresh of a background tab by seconds, so
// the listener closes as soon as the page fetches its final answer and only
// falls back to this bound when the page never returns.
const callbackAnswerWindow = 60 * time.Second

// retireLocked keeps the page answerable until it fetches the final result,
// at most callbackAnswerWindow.
func (c *callbackListener) retireLocked() {
	if c.retirement != nil {
		c.retirement.Stop()
	}
	c.retirement = time.AfterFunc(callbackAnswerWindow, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.closeLocked()
	})
}

func (c *callbackListener) closeLocked() {
	if c.retirement != nil {
		c.retirement.Stop()
	}
	if c.closed {
		return
	}
	c.closed = true
	// Shutdown lets the response being written finish.
	go func() { _ = c.server.Shutdown(context.Background()) }()
}

// callbackPage is one state of the setup page the browser shows on the
// loopback callback.
type callbackPage struct {
	Tone, Title, Heading, Message, Hint string
	// Refresh is the status path that answers with the final page, and
	// Progress the path a pending page polls; both are empty on a final page.
	Refresh, Progress string
}

var (
	invalidCallbackPage = callbackPage{
		Tone: "danger", Title: "Invalid callback", Heading: "This link is not valid",
		Message: "This setup link was already used or does not belong to this terminal.",
		Hint:    "Run the login command again to start a new setup.",
	}
	completedCallbackPage = callbackPage{
		Tone: "success", Title: "Linger Computer setup complete", Heading: "Computer connected",
		Message: "This Local Computer is connected to Linger.",
		Hint:    "You can close this page.",
	}
	cancelledCallbackPage = callbackPage{
		Tone: "neutral", Title: "Linger Computer setup cancelled", Heading: "Setup cancelled",
		Message: "The existing Local Computer remains connected.",
		Hint:    "You can close this page.",
	}
	failedCallbackPage = callbackPage{
		Tone: "danger", Title: "Linger Computer setup failed", Heading: "Setup did not finish",
		Message: "The Computer could not be connected.",
		Hint:    "Return to the terminal for details.",
	}
)

// callbackPageTemplate draws every state as one centered card. The page loads
// nothing: the CSP allows only its inline style, so the mark is inline SVG.
var callbackPageTemplate = template.Must(template.New("callback").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
{{if .Refresh}}<noscript><meta http-equiv="refresh" content="0.25;url={{.Refresh}}"></noscript>{{end}}
<title>{{.Title}}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f5f5f4;color:#1c1917;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{width:100%;max-width:420px;padding:32px 28px;border:1px solid #e7e5e4;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06);text-align:center}
.mark{display:inline-flex;width:44px;height:44px;margin-bottom:16px;align-items:center;justify-content:center;border-radius:999px}
.mark svg{width:22px;height:22px}
.success .mark{background:#dcfce7;color:#15803d}
.danger .mark{background:#fee2e2;color:#b91c1c}
.neutral .mark{background:#f5f5f4;color:#57534e}
.pending .mark{border:3px solid #e7e5e4;border-top-color:#1c1917;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.pending .mark{animation:none}}
h1{margin:0 0 8px;font-size:18px;font-weight:600}
p{margin:0;color:#44403c}
.hint{margin-top:16px;padding-top:16px;border-top:1px solid #f5f5f4;color:#78716c;font-size:13px}
</style></head>
<body><main class="{{.Tone}}" role="status">
<span class="mark" aria-hidden="true">{{if eq .Tone "success"}}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>{{else if eq .Tone "danger"}}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>{{else if eq .Tone "neutral"}}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M7 12h10"/></svg>{{end}}</span>
<h1>{{.Heading}}</h1>
<p id="message">{{.Message}}</p>
<p class="hint">{{.Hint}}</p>
</main>{{if .Refresh}}<script data-refresh="{{.Refresh}}" data-progress="{{.Progress}}">` + callbackRefreshScript + `</script>{{end}}</body></html>
`))

// callbackRefreshScript polls the progress path and updates the message in
// place, so the card does not redraw; it leaves for the final page only once
// the answer is ready. It uses timers rather than a meta refresh because Chrome
// starts a meta refresh only after the load event, which an extension that
// injects into every page can hold back indefinitely. The script is constant,
// so the CSP admits it by hash.
const callbackRefreshScript = `var d=document.currentScript.dataset,m=document.getElementById("message");function t(){fetch(d.progress,{cache:"no-store"}).then(function(r){return r.json()}).then(function(p){if(p.done){location.replace(d.refresh);return}m.textContent=p.message;setTimeout(t,250)},function(){setTimeout(t,1000)})}setTimeout(t,250)`

var callbackHeaders = map[string]string{
	"Cache-Control":           "no-store",
	"Content-Security-Policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src '" + scriptHash(callbackRefreshScript) + "'",
	"Content-Type":            "text/html; charset=utf-8",
	"X-Content-Type-Options":  "nosniff",
}

func scriptHash(script string) string {
	sum := sha256.Sum256([]byte(script))
	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}

func writeCallbackPage(writer http.ResponseWriter, status int, page callbackPage) {
	for key, value := range callbackHeaders {
		writer.Header().Set(key, value)
	}
	writer.WriteHeader(status)
	_ = callbackPageTemplate.Execute(writer, page)
}

func writePendingCallback(writer http.ResponseWriter, state, progress string) {
	page := callbackPage{
		Tone: "pending", Title: "Linger Computer setup", Heading: "Connecting this Computer",
		Message:  pendingCallbackMessage(progress),
		Hint:     "Keep the terminal open until this page shows that the Computer is connected.",
		Refresh:  "/callback/status?state=" + url.QueryEscape(state),
		Progress: "/callback/progress?state=" + url.QueryEscape(state),
	}
	writeCallbackPage(writer, http.StatusOK, page)
}

func pendingCallbackMessage(progress string) string {
	if progress == "starting-daemon" {
		return "Saving configuration and starting the daemon..."
	}
	return "Authorization received. Securely connecting this Computer..."
}
