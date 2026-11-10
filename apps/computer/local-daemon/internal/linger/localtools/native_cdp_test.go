package localtools

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func TestNativeBrowserRecoversMissingProxyAfterBrowserStartup(t *testing.T) {
	journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
	if err != nil {
		t.Fatal(err)
	}
	// This is the retained state after Chrome starts but net.Listen fails.
	// The existing browser and MCP client must survive retry unchanged.
	browser := &nativeBrowser{endpoint: "http://127.0.0.1:1"}
	client := fixtureClient(t, "image", "")
	op := &operation{
		manager:       &Manager{journal: journal, operations: map[*operation]bool{}},
		spec:          provider.OperationSpec{AgentID: "fixture"},
		identity:      mcpproxy.OperationIdentity{OperationID: "retry"},
		nativeBrowser: browser,
		browser:       client,
	}
	op.label = "original-owner"
	for range 2 {
		if _, err := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	if op.nativeProxy == nil || op.nativeBrowser != browser || op.browser != client || journal.blocked() {
		t.Fatal("browser retry lost its owner or did not complete the action receipt")
	}
	if err := op.nativeProxy.close(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeCDPActionAdmissionAndUnknownCleanup(t *testing.T) {
	defer func(previous time.Duration) { cdpDrainTimeout = previous }(cdpDrainTimeout)
	cdpDrainTimeout = 200 * time.Millisecond
	for _, acknowledge := range []bool{true, false} {
		t.Run(map[bool]string{true: "acknowledged", false: "lost-receipt"}[acknowledge], func(t *testing.T) {
			seen := make(chan struct{}, 1)
			chrome := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/json/version" {
					_ = json.NewEncoder(w).Encode(map[string]string{"webSocketDebuggerUrl": "ws://127.0.0.1/devtools/browser/test"})
					return
				}
				socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer socket.Close()
				for {
					_, data, err := socket.ReadMessage()
					if err != nil {
						return
					}
					var message struct {
						ID     uint64 `json:"id"`
						Method string `json:"method"`
					}
					_ = json.Unmarshal(data, &message)
					seen <- struct{}{}
					// Chrome may never answer setup for a target it keeps paused.
					if acknowledge && message.Method != "Runtime.runIfWaitingForDebugger" {
						_ = socket.WriteJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
					}
				}
			}))
			defer chrome.Close()
			proxy, err := openNativeCDPProxy(chrome.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.close()
			response, err := http.Get(proxy.endpoint + "/json/version")
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusConflict {
				t.Fatal("inactive discovery was admitted")
			}
			proxy.resume()
			response, err = http.Get(proxy.endpoint + "/json/version")
			if err != nil {
				t.Fatal(err)
			}
			var metadata map[string]string
			_ = json.NewDecoder(response.Body).Decode(&metadata)
			_ = response.Body.Close()
			if !strings.HasPrefix(metadata["webSocketDebuggerUrl"], "ws"+strings.TrimPrefix(proxy.endpoint, "http")) {
				t.Fatal("Chrome endpoint escaped the private proxy")
			}
			client, _, err := websocket.DefaultDialer.Dial(metadata["webSocketDebuggerUrl"], nil)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			_ = client.WriteJSON(map[string]any{"id": 9, "method": "Runtime.runIfWaitingForDebugger", "sessionId": "worker"})
			<-seen
			_ = client.WriteJSON(map[string]any{"id": 1, "method": "Page.test"})
			select {
			case <-seen:
			case <-time.After(3 * time.Second):
				t.Fatal("active command was not delivered")
			}
			if acknowledge {
				_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
				if _, _, err := client.ReadMessage(); err != nil {
					t.Fatal(err)
				}
			}
			if clean := proxy.pause(); clean != acknowledge {
				t.Fatalf("pause clean=%v, acknowledgment=%v", clean, acknowledge)
			}
			if acknowledge {
				_ = client.WriteJSON(map[string]any{"id": 2, "method": "Page.test"})
				_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
				if _, _, err := client.ReadMessage(); err == nil {
					t.Fatal("inactive command was admitted")
				}
				select {
				case <-seen:
					t.Fatal("command crossed the completed action")
				default:
				}
			} else if err := proxy.close(); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
				t.Fatalf("lost CDP receipt was cleared: %v", err)
			}
		})
	}
}
