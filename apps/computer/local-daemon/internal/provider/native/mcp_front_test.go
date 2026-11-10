package native

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestResidentMCPShape(t *testing.T) {
	shape, targets, eligible := residentMCPShape(nil)
	if empty, _, _ := residentMCPShape(json.RawMessage(`{"mcpServers":{}}`)); !eligible || shape != empty || len(targets) != 0 {
		t.Fatal("no config must be the empty set")
	}
	first := `{"mcpServers":{"b":{"type":"http","url":"http://127.0.0.1:1/x?y=1","timeout":1.50},"a":{"url":"https://h/p","type":"http"}}}`
	second := `{"mcpServers":{"a":{"type":"http","url":"https://other:9/q"},"b":{"type":"http","url":"http://127.0.0.1:2/z","timeout":1.50}}}`
	shapeA, targetsA, okA := residentMCPShape(json.RawMessage(first))
	shapeB, _, okB := residentMCPShape(json.RawMessage(second))
	if !okA || !okB || shapeA != shapeB || strings.Contains(shapeA, "127.0.0.1") || !strings.Contains(shapeA, "1.50") {
		t.Fatalf("shapes = %s / %s", shapeA, shapeB)
	}
	if targetsA["b"] != "http://127.0.0.1:1/x?y=1" || targetsA["a"] != "https://h/p" {
		t.Fatalf("targets = %v", targetsA)
	}
	added, _, _ := residentMCPShape(json.RawMessage(`{"mcpServers":{"a":{"type":"http","url":"https://h/p"}}}`))
	if added == shapeA {
		t.Fatal("removing a server must change the shape")
	}
	for _, config := range []string{`[]`, `{"mcpServers":[]}`, `{"mcpServers":{"a":{"type":"stdio","command":"x"}}}`, `{"mcpServers":{"a":{"type":"http"}}}`, `{"mcpServers":{"a":1}}`} {
		if _, _, ok := residentMCPShape(json.RawMessage(config)); ok {
			t.Fatalf("%s must be ineligible", config)
		}
	}
	if _, targets, ok := residentMCPShape(json.RawMessage(`{}`)); !ok || len(targets) != 0 {
		t.Fatal("config without servers must be eligible")
	}
}

func TestMCPFrontRoutesBoundTargets(t *testing.T) {
	type seen struct{ path, query, host, method string }
	hits := make(chan seen, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- seen{r.URL.Path, r.URL.RawQuery, r.Host, r.Method}
		_, _ = io.WriteString(w, "upstream-ok")
	}))
	defer upstream.Close()

	front, err := newMCPFront()
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	name := "files server"
	if !strings.HasSuffix(front.URL(name), "/files%20server") || len(strings.Split(front.prefix, "/")[2]) != 43 {
		t.Fatalf("front URL = %s", front.URL(name))
	}
	rewritten, err := front.Rewrite(json.RawMessage(`{"mcpServers":{"files server":{"type":"http","url":"http://old"}}}`))
	if err != nil || !strings.Contains(string(rewritten), front.address) {
		t.Fatalf("rewrite = %s, %v", rewritten, err)
	}

	response, err := http.Post(front.URL(name), "application/json", strings.NewReader("{}"))
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unbound status = %v, %v", response, err)
	}
	_ = response.Body.Close()

	if err := front.Bind(map[string]string{name: upstream.URL + "/mcp/one?token=a"}); err != nil {
		t.Fatal(err)
	}
	response, err = http.Post(front.URL(name)+"?session=s", "application/json", strings.NewReader("{}"))
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("bound call = %v, %v", response, err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	hit := <-hits
	if string(body) != "upstream-ok" || hit.path != "/mcp/one" || hit.query != "token=a&session=s" || hit.host != strings.TrimPrefix(upstream.URL, "http://") || hit.method != "POST" {
		t.Fatalf("hit = %+v body %q", hit, body)
	}

	if err := front.Bind(map[string]string{name: "ftp://nowhere"}); err == nil || !strings.Contains(err.Error(), `MCP server "files server" has an unusable url`) {
		t.Fatalf("bad bind = %v", err)
	}
	if response, err := http.Get(front.URL(name)); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("failed bind must keep the previous binding: %v %v", response, err)
	} else {
		_ = response.Body.Close()
		<-hits
	}

	front.Unbind()
	response, err = http.Post(front.URL(name), "application/json", strings.NewReader("{}"))
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unbound status = %v, %v", response, err)
	}
	_ = response.Body.Close()
	if response, _ := http.Get("http://" + front.address + "/elsewhere"); response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("outside prefix status = %d", response.StatusCode)
	}

	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()
	_ = front.Bind(map[string]string{name: closedURL})
	if response, _ := http.Get(front.URL(name)); response.StatusCode != http.StatusBadGateway {
		t.Fatalf("dead upstream status = %d", response.StatusCode)
	}

	front.Close()
	front.Close()
	var nilFront *mcpFront
	nilFront.Unbind()
	nilFront.Close()
	client := http.Client{Timeout: 2 * time.Second}
	if response, err := client.Get(front.URL(name)); err == nil {
		_ = response.Body.Close()
		t.Fatal("closed front still answers")
	}
}

func TestMCPFrontStreamsEvents(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "data: second\n\n")
	}))
	defer upstream.Close()
	defer close(release)
	front, err := newMCPFront()
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	_ = front.Bind(map[string]string{"sse": upstream.URL})
	response, err := http.Get(front.URL("sse"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line := make(chan string, 1)
	go func() {
		text, _ := bufio.NewReader(response.Body).ReadString('\n')
		line <- text
	}()
	select {
	case text := <-line:
		if text != "data: first\n" {
			t.Fatalf("line = %q", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("event was not flushed")
	}
}
