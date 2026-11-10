package mcpproxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type catalogReply struct {
	status      int
	contentType string
	body        string
}

func openCatalogSet(t *testing.T, replies map[string]func(method string) catalogReply) (*Set, map[string]string) {
	t.Helper()
	descriptors := make([]Descriptor, 0, len(replies))
	for name, reply := range replies {
		upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			body, _ := readBody(request)
			method := ""
			if index := strings.Index(string(body), `"method":"`); index >= 0 {
				method = strings.SplitN(string(body)[index+len(`"method":"`):], `"`, 2)[0]
			}
			answer := reply(method)
			if answer.contentType != "" {
				writer.Header().Set("Content-Type", answer.contentType)
			}
			writer.WriteHeader(answer.status)
			_, _ = writer.Write([]byte(answer.body))
		}))
		t.Cleanup(upstream.Close)
		descriptors = append(descriptors, Descriptor{
			Name: name, RelayURL: upstream.URL, RelayToken: strings.Repeat("token", 7), ExpiresAt: time.Now().Add(time.Minute),
		})
	}
	set, err := Open(context.Background(), mustDescriptors(t, descriptors), OperationIdentity{OperationID: "operation-1", ExecutionLeaseID: "lease-1"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = set.Close() })
	urls := make(map[string]string, len(replies))
	for name := range replies {
		urls[name] = localServerURL(t, set.Config(), name)
	}
	return set, urls
}

func postRPC(t *testing.T, localURL, body string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, localURL, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
}

func jsonReply(body string) catalogReply {
	return catalogReply{status: http.StatusOK, contentType: "application/json", body: body}
}

func waitReadyWithin(set *Set, budget time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	return set.WaitReady(ctx)
}

func TestSetWaitReadyRequiresEveryServerCatalog(t *testing.T) {
	set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
		"teamhub": func(string) catalogReply {
			return jsonReply(`{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"send_message","inputSchema":{"type":"object"}}]}}`)
		},
		"wiki": func(method string) catalogReply {
			if method == "initialize" {
				return jsonReply(`{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"}}`)
			}
			return jsonReply(`{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"query","inputSchema":{"type":"object"}}],"nextCursor":"page-2"}}`)
		},
	})
	if err := waitReadyWithin(set, 50*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("catalog readiness before any tools/list = %v", err)
	}
	postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	postRPC(t, urls["wiki"], `{"jsonrpc":"2.0","id":0,"method":"initialize"}`)
	if err := waitReadyWithin(set, 50*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("initialize without a listed catalog was treated as ready: %v", err)
	}
	// Codex 0.155.1 installs the first page and never requests nextCursor.
	postRPC(t, urls["wiki"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if err := waitReadyWithin(set, time.Second); err != nil {
		t.Fatalf("every installed catalog was listed: %v", err)
	}
}

func TestSetWaitReadyRejectsCatalogCodexCannotInstall(t *testing.T) {
	for name, tools := range map[string]string{
		"missing tools":        `{}`,
		"missing name":         `{"tools":[{"inputSchema":{"type":"object"}}]}`,
		"missing input schema": `{"tools":[{"name":"send_message"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
				"teamhub": func(string) catalogReply { return jsonReply(`{"jsonrpc":"2.0","id":1,"result":` + tools + `}`) },
			})
			postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			if err := waitReadyWithin(set, time.Second); err == nil || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("uninstallable catalog readiness = %v", err)
			}
		})
	}
}

func TestSetWaitReadyAcceptsStreamedReplyForMatchingRequest(t *testing.T) {
	set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
		"teamhub": func(string) catalogReply {
			return catalogReply{status: http.StatusOK, contentType: "text/event-stream", body: "" +
				"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":6,\"result\":{\"tools\":[],\"nextCursor\":\"x\"}}\n\n" +
				"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"tools\":[{\"name\":\"send_message\",\"inputSchema\":{\"type\":\"object\"}}]}}\n\n"}
		},
	})
	postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)
	if err := waitReadyWithin(set, time.Second); err != nil {
		t.Fatalf("streamed catalog reply was not observed: %v", err)
	}
}

func TestSetWaitReadyFailsOnFirstCatalogFailure(t *testing.T) {
	for name, reply := range map[string]catalogReply{
		"http status":    {status: http.StatusBadGateway},
		"json-rpc error": jsonReply(`{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"down"}}`),
	} {
		t.Run(name, func(t *testing.T) {
			set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
				"teamhub": func(string) catalogReply { return reply },
				"wiki":    func(string) catalogReply { return jsonReply(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`) },
			})
			postRPC(t, urls["wiki"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			if err := waitReadyWithin(set, time.Second); err == nil || errors.Is(err, context.DeadlineExceeded) ||
				!strings.Contains(err.Error(), "teamhub") {
				t.Fatalf("failed catalog readiness = %v", err)
			}
		})
	}
}

func TestSetWaitReadyIgnoresToolCallsAndNotifications(t *testing.T) {
	set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
		"teamhub": func(method string) catalogReply {
			if method == "notifications/initialized" {
				return catalogReply{status: http.StatusAccepted}
			}
			return catalogReply{status: http.StatusBadGateway}
		},
	})
	postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"x"}}`)
	if err := waitReadyWithin(set, 50*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("non-catalog traffic decided readiness: %v", err)
	}
}

func TestSetWaitReadyMirrorsCodexToolDecoding(t *testing.T) {
	valid := `{"name":"send_message","title":"Send","description":"Send one message","inputSchema":{"type":"object"},` +
		`"outputSchema":null,"annotations":{"title":"Send","readOnlyHint":false,"openWorldHint":null},` +
		`"icons":[{"src":"https://example.test/icon.png","mimeType":"image/png","sizes":["48x48"],"theme":"dark"}],"_meta":{"k":1}}`
	for name, test := range map[string]struct {
		tool  string
		ready bool
	}{
		"every optional field":        {tool: valid, ready: true},
		"description is a number":     {tool: `{"name":"a","description":42,"inputSchema":{}}`},
		"title is a number":           {tool: `{"name":"a","title":7,"inputSchema":{}}`},
		"input schema is a string":    {tool: `{"name":"a","inputSchema":"object"}`},
		"output schema is an array":   {tool: `{"name":"a","inputSchema":{},"outputSchema":[]}`},
		"annotation hint is a string": {tool: `{"name":"a","inputSchema":{},"annotations":{"readOnlyHint":"yes"}}`},
		"icon without src":            {tool: `{"name":"a","inputSchema":{},"icons":[{"mimeType":"image/png"}]}`},
		"icon sizes is a string":      {tool: `{"name":"a","inputSchema":{},"icons":[{"src":"x","sizes":"48x48"}]}`},
		"unknown icon theme":          {tool: `{"name":"a","inputSchema":{},"icons":[{"src":"x","theme":"blue"}]}`},
		"meta is an array":            {tool: `{"name":"a","inputSchema":{},"_meta":[]}`},
		"tool is null":                {tool: `null`},
	} {
		t.Run(name, func(t *testing.T) {
			set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
				"teamhub": func(string) catalogReply {
					return jsonReply(`{"jsonrpc":"2.0","id":1,"result":{"tools":[` + test.tool + `]}}`)
				},
			})
			postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			// A complete reply must settle immediately either way, never by timeout.
			err := waitReadyWithin(set, time.Second)
			if errors.Is(err, context.DeadlineExceeded) || (err == nil) != test.ready {
				t.Fatalf("readiness=%v, want ready=%v", err, test.ready)
			}
		})
	}
}

func TestSetWaitReadyMirrorsCodexStrictKeysAndResultFields(t *testing.T) {
	const tool = `{"name":"a","inputSchema":{}}`
	for name, test := range map[string]struct {
		frame string
		ready bool
	}{
		"null optional result fields":  {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"nextCursor":null,"_meta":null,"resultType":null,"ttlMs":null,"cacheScope":null}}`, ready: true},
		"valid optional result fields": {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"nextCursor":"p2","_meta":{},"resultType":"complete","ttlMs":-3,"cacheScope":"private"}}`, ready: true},
		"unknown keys are ignored":     {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{},"annotations":{"ReadOnlyHint":"x"},"extra":1}],"extra":[]}}`, ready: true},
		"nextCursor is a number":       {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"nextCursor":42}}`},
		"resultType is a number":       {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"resultType":5}}`},
		"ttlMs is fractional":          {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"ttlMs":1.5}}`},
		"unknown cacheScope":           {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"cacheScope":"shared"}}`},
		"result meta is an array":      {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[` + tool + `],"_meta":[]}}`},
		"capitalized tool name":        {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"Name":"a","inputSchema":{}}]}}`},
		"capitalized input schema":     {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","InputSchema":{}}]}}`},
		"capitalized tools":            {frame: `{"jsonrpc":"2.0","id":1,"result":{"Tools":[` + tool + `]}}`},
		"duplicate tool field":         {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","name":"b","inputSchema":{}}]}}`},
		"null icon size":               {frame: `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{},"icons":[{"src":"x","sizes":[null]}]}]}}`},
		"wrong JSON-RPC version":       {frame: `{"jsonrpc":"1.0","id":1,"result":{"tools":[` + tool + `]}}`},
		"capitalized result":           {frame: `{"jsonrpc":"2.0","id":1,"Result":{"tools":[` + tool + `]}}`},
	} {
		t.Run(name, func(t *testing.T) {
			set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
				"teamhub": func(string) catalogReply { return jsonReply(test.frame) },
			})
			postRPC(t, urls["teamhub"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			err := waitReadyWithin(set, time.Second)
			if errors.Is(err, context.DeadlineExceeded) || (err == nil) != test.ready {
				t.Fatalf("readiness=%v, want ready=%v", err, test.ready)
			}
		})
	}
}

func TestSetWaitReadyReportsFailureBehindPendingServer(t *testing.T) {
	set, urls := openCatalogSet(t, map[string]func(string) catalogReply{
		"a_pending": func(string) catalogReply { return jsonReply(`{}`) },
		"z_failed": func(string) catalogReply {
			return jsonReply(`{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"down"}}`)
		},
	})
	// a_pending never lists its catalog.
	postRPC(t, urls["z_failed"], `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	started := time.Now()
	err := waitReadyWithin(set, 2*time.Second)
	if err == nil || errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "z_failed") {
		t.Fatalf("a settled failure waited behind a pending server: %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("failure surfaced after %s", elapsed)
	}
}
