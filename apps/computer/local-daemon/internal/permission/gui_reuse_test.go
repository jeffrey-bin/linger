package permission

import (
	"context"
	"strconv"
	"testing"
	"time"
)

func TestGUIReuseKeyNamesNavigationShapesOnly(t *testing.T) {
	for _, test := range []struct {
		name, tool, input, key string
	}{
		{"click opens or sends", "mcp__computer__click", `{"pid":719,"window_id":433,"element_token":"s5:814"}`, ""},
		{"scroll", "mcp__computer__scroll", `{"pid":719,"window_id":433,"direction":"down"}`, "scroll@719/433"},
		{"scroll with an unknown option", "mcp__computer__scroll", `{"pid":719,"window_id":433,"direction":"down","screenshot_out_file":"/tmp/x"}`, ""},
		{"batch with an unknown option", "mcp__computer__run_actions", `{"actions":[{"tool":"press_key","pid":719,"key":"escape","capture":true}]}`, ""},
		{"escape", "mcp__computer__press_key", `{"pid":719,"key":"Escape"}`, "press_key:escape@719/-"},
		{"tab switch", "mcp__computer__hotkey", `{"pid":719,"keys":["option","cmd","right"]}`, "hotkey:cmd+option+right@719/-"},
		{"batch of navigation", "mcp__computer__run_actions", `{"actions":[{"tool":"press_key","pid":719,"window_id":433,"key":"escape"},{"tool":"scroll","pid":719,"window_id":433,"direction":"down"}],"read":{"pid":719}}`, "run_actions:press_key:escape@719/433;scroll@719/433"},
		{"batch with a click", "mcp__computer__run_actions", `{"actions":[{"tool":"press_key","pid":719,"key":"escape"},{"tool":"click","pid":719,"window_id":433,"element_token":"s5:144"}]}`, ""},
		{"script", "mcp__computer__run_script", `{"script":"return 1;"}`, ""},
		{"modified click", "mcp__computer__click", `{"pid":719,"window_id":433,"element_token":"s5:1","modifier":["cmd"]}`, ""},
		{"typing", "mcp__computer__type_text", `{"pid":719,"text":"hello"}`, ""},
		{"return submits", "mcp__computer__press_key", `{"pid":719,"key":"return"}`, ""},
		{"close tab", "mcp__computer__hotkey", `{"pid":719,"keys":["cmd","w"]}`, ""},
		{"batch with typing", "mcp__computer__run_actions", `{"actions":[{"tool":"scroll","pid":719,"window_id":433,"direction":"down"},{"tool":"type_text","pid":719,"text":"x"}]}`, ""},
		{"browser tools", "mcp__browser__browser_click", `{"target":"e5"}`, ""},
		{"no pid", "mcp__computer__click", `{"x":1,"y":2}`, ""},
		{"foreground scroll", "mcp__computer__scroll", `{"pid":719,"window_id":433,"direction":"down","delivery_mode":"foreground"}`, ""},
		{"batch with a foreground scroll", "mcp__computer__run_actions", `{"actions":[{"tool":"scroll","pid":719,"window_id":433,"direction":"down"},{"tool":"scroll","pid":719,"window_id":433,"direction":"down","delivery_mode":"foreground"}]}`, ""},
		{"paged text read has its key's shape", "mcp__computer__recognize_text", `{"pid":719,"window_id":433,"pages":4,"next_key":"right","region":{"x":1,"y":2,"width":3,"height":4}}`, "press_key:right@719/433"},
		{"paged text read with another field", "mcp__computer__recognize_text", `{"pid":719,"window_id":433,"pages":4,"next_key":"right","PID":999}`, ""},
		{"paged text read without a known key", "mcp__computer__recognize_text", `{"pid":719,"window_id":433,"pages":4,"next_key":"return"}`, ""},
		{"background scroll", "mcp__computer__scroll", `{"pid":719,"window_id":433,"direction":"down","delivery_mode":"background"}`, "scroll@719/433"},
	} {
		t.Run(test.name, func(t *testing.T) {
			key, ok := GUIReuseKey(test.tool, test.input)
			if ok != (test.key != "") || key != test.key {
				t.Fatalf("GUIReuseKey = %q, %v; want %q", key, ok, test.key)
			}
		})
	}
}

func TestReviewerReusesAnAllowForTheSameNavigationShape(t *testing.T) {
	requester := newFakeRequester()
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	reviewer := &Reviewer{Requester: requester, Now: func() time.Time { return now }}
	click := func(direction string, window int) Request {
		return Request{Action: Action{Tool: "mcp__computer__run_actions", Input: `{"actions":[{"tool":"scroll","pid":719,"window_id":` + itoa(window) + `,"direction":"` + direction + `"}]}`}}
	}
	first := review(reviewer, click("down", 433))
	requester.answer(t, <-requester.sent, `{"decision":"allow"}`)
	if got := <-first; got.Decision != Allow {
		t.Fatalf("first verdict: %+v", got)
	}
	if got := reviewer.Review(context.Background(), click("up", 433)); got.Decision != Allow {
		t.Fatalf("second verdict: %+v", got)
	}
	if len(requester.requests) != 1 {
		t.Fatalf("a scroll of the same shape was judged again: %d reviews", len(requester.requests))
	}
	other := review(reviewer, click("down", 434))
	select {
	case id := <-requester.sent:
		requester.answer(t, id, `{"decision":"needs_approval","message":"card","interaction_id":"card-1"}`)
	case <-time.After(time.Second):
		t.Fatal("a scroll in another window was not judged")
	}
	if got := <-other; got.Decision != NeedsApproval {
		t.Fatalf("other window verdict: %+v", got)
	}
	// A verdict that is not allow clears the shape it was given for.
	again := review(reviewer, click("up", 434))
	select {
	case id := <-requester.sent:
		requester.answer(t, id, `{"decision":"allow"}`)
	case <-time.After(time.Second):
		t.Fatal("the shape with a needs_approval verdict was reused")
	}
	<-again
	// The reuse expires.
	now = now.Add(guiReuseTTL + time.Second)
	expired := review(reviewer, click("down", 433))
	select {
	case id := <-requester.sent:
		requester.answer(t, id, `{"decision":"allow"}`)
	case <-time.After(time.Second):
		t.Fatal("an expired reuse allowed the scroll")
	}
	<-expired
}

func TestReviewerDoesNotReuseVerdictsForClicksOrTyping(t *testing.T) {
	for _, action := range []Action{
		{Tool: "mcp__computer__type_text", Input: `{"pid":719,"text":"hello"}`},
		{Tool: "mcp__computer__click", Input: `{"pid":719,"window_id":433,"element_token":"s5:144"}`},
	} {
		requester := newFakeRequester()
		reviewer := &Reviewer{Requester: requester}
		for range 2 {
			verdict := review(reviewer, Request{Action: action})
			select {
			case id := <-requester.sent:
				requester.answer(t, id, `{"decision":"allow"}`)
			case <-time.After(time.Second):
				t.Fatalf("%s was not judged", action.Tool)
			}
			<-verdict
		}
		if len(requester.requests) != 2 {
			t.Fatalf("%s reviews = %d, want 2", action.Tool, len(requester.requests))
		}
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
