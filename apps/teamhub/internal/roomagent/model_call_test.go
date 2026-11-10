package roomagent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewRequiresTheAgentServiceLink(t *testing.T) {
	for _, link := range [][2]string{{"", "token"}, {"http://agent.test", ""}, {" ", " "}} {
		if _, err := NewModelCallClient(link[0], link[1]); !errors.Is(err, ErrModelCallUnconfigured) {
			t.Fatalf("link=%q err=%v", link, err)
		}
	}
	if _, err := NewModelCallClient("agent.test", "token"); err == nil || errors.Is(err, ErrModelCallUnconfigured) {
		t.Fatalf("relative URL err=%v", err)
	}
}

func TestStructuredSendsTheKindKeyAndEffortAndReturnsTheObject(t *testing.T) {
	var raw []byte
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/model-calls" || request.Header.Get("Authorization") != "Bearer service-token" {
			t.Errorf("request=%s %s auth=%q", request.Method, request.URL.Path, request.Header.Get("Authorization"))
		}
		raw, _ = io.ReadAll(request.Body)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"model":"runtime-model","output":{"ok":true}}`))
	}))
	t.Cleanup(server.Close)
	client, err := NewModelCallClient(server.URL, "service-token")
	if err != nil {
		t.Fatal(err)
	}
	schema := json.RawMessage(`{"type":"object","required":["z","a"],"properties":{"z":{"type":"string"},"a":{"type":"string"}}}`)
	output, model, err := client.Structured(context.Background(), ModelCallRequest{
		Kind:         KindApproval,
		Key:          "approval:review_1",
		Effort:       EffortMedium,
		Owner:        ModelCallOwner{TenantID: "tenant_1", OwnerActorID: "actor_1"},
		Instructions: "system", Input: "user", Timeout: 2 * time.Minute,
	}, "result", schema)
	if err != nil || string(output) != `{"ok":true}` || model != "runtime-model" {
		t.Fatalf("output=%s model=%q err=%v", output, model, err)
	}
	var sent struct {
		Kind         string            `json:"kind"`
		Key          string            `json:"key"`
		Effort       string            `json:"effort"`
		Owner        map[string]string `json:"owner"`
		Instructions string            `json:"instructions"`
		Input        string            `json:"input"`
		Output       struct {
			Name   string          `json:"name"`
			Schema json.RawMessage `json:"schema"`
		} `json:"output"`
		TimeoutMS int `json:"timeoutMs"`
	}
	if err := json.Unmarshal(raw, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Kind != "approval" || sent.Key != "approval:review_1" || sent.Effort != "medium" ||
		sent.Owner["tenantId"] != "tenant_1" || sent.Owner["ownerActorId"] != "actor_1" ||
		sent.Instructions != "system" || sent.Input != "user" || sent.TimeoutMS != 120000 || sent.Output.Name != "result" {
		t.Fatalf("sent=%s", raw)
	}
	if string(sent.Output.Schema) != string(schema) {
		t.Fatalf("schema property order changed: %s", sent.Output.Schema)
	}
}

func TestTextOmitsAPartialOwnerOutputAndTimeout(t *testing.T) {
	var sent map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewDecoder(request.Body).Decode(&sent)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"model":"owner-model","text":"Hello"}`))
	}))
	t.Cleanup(server.Close)
	client, err := NewModelCallClient(server.URL+"/", "service-token")
	if err != nil {
		t.Fatal(err)
	}
	text, model, err := client.Text(context.Background(), ModelCallRequest{
		Kind: KindProfile, Key: "profile:1", Owner: ModelCallOwner{TenantID: "tenant_1"}, Input: "hi",
	})
	if err != nil || text != "Hello" || model != "owner-model" {
		t.Fatalf("text=%q model=%q err=%v", text, model, err)
	}
	for _, field := range []string{"owner", "output", "instructions", "effort", "timeoutMs"} {
		if _, ok := sent[field]; ok {
			t.Fatalf("%s must be omitted: %v", field, sent)
		}
	}
}

func TestStatusErrorKeepsTheServiceCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusBadGateway)
		_, _ = response.Write([]byte(`{"error":{"code":"MODEL_UNAVAILABLE","message":"every candidate failed","request_id":"r"}}`))
	}))
	t.Cleanup(server.Close)
	client, err := NewModelCallClient(server.URL, "service-token")
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = client.Text(context.Background(), ModelCallRequest{Input: "x", Timeout: time.Second})
	var status *ModelCallStatusError
	if !errors.As(err, &status) || status.Status != http.StatusBadGateway || status.Code != "MODEL_UNAVAILABLE" || !strings.Contains(err.Error(), "every candidate failed") {
		t.Fatalf("err=%v", err)
	}
}

func TestOfflineAndPendingAnswersAreTheirSentinels(t *testing.T) {
	for code, want := range map[string]error{
		"LOCAL_COMPUTER_OFFLINE":    ErrModelCallComputerOffline,
		"MODEL_CALL_PENDING":        ErrModelCallPending,
		"LOCAL_RUNTIME_UNAVAILABLE": nil,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = response.Write([]byte(`{"error":{"code":"` + code + `","message":"later","request_id":"r"}}`))
		}))
		client, err := NewModelCallClient(server.URL, "service-token")
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = client.Text(context.Background(), ModelCallRequest{Input: "x", Timeout: time.Second})
		server.Close()
		for _, sentinel := range []error{ErrModelCallComputerOffline, ErrModelCallPending} {
			if errors.Is(err, sentinel) != errors.Is(want, sentinel) {
				t.Fatalf("code=%s err=%v sentinel=%v", code, err, sentinel)
			}
		}
	}
}
