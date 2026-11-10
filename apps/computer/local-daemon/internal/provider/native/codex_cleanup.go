package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var (
	// codexCleanupBudget bounds one turn cleanup; tests lower it.
	codexCleanupBudget = newCodexTunable(10 * time.Second)
	codexCleanupPoll   = 25 * time.Millisecond
)

const codexTerminalPageLimit = 100

// codexTurnTracker remembers the most recent turn/start of a process, so
// cleanup can interrupt it and terminate its background commands.
type codexTurnTracker struct {
	sent      bool
	threadID  string
	turnID    string
	rejected  bool
	completed bool
	commands  map[string]map[string]bool
}

func (p *codexProcess) trackTurnStart(threadID string) {
	p.mu.Lock()
	p.tracker = codexTurnTracker{sent: true, threadID: threadID, commands: map[string]map[string]bool{}}
	p.mu.Unlock()
}

// untrackTurnStart forgets a turn/start that never reached stdin.
func (p *codexProcess) untrackTurnStart() {
	p.mu.Lock()
	p.tracker = codexTurnTracker{}
	p.mu.Unlock()
}

// trackTurnAck records the acknowledgement of turn/start, even a late one.
func (p *codexProcess) trackTurnAck(reply codexReply) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var rpcErr *codexRPCError
	if errors.As(reply.err, &rpcErr) {
		p.tracker.rejected = true
		return
	}
	if reply.err != nil {
		return
	}
	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(reply.result, &result) == nil && result.Turn.ID != "" && p.tracker.turnID == "" {
		p.tracker.turnID = result.Turn.ID
	}
}

// trackNotification feeds accepted notifications for the tracked thread.
func (p *codexProcess) trackNotification(method string, threadID, turnID string, item codexItem) {
	p.mu.Lock()
	defer p.mu.Unlock()
	tracker := &p.tracker
	if !tracker.sent || (threadID != "" && threadID != tracker.threadID) {
		return
	}
	switch method {
	case "turn/started":
		if tracker.turnID == "" {
			tracker.turnID = turnID
		}
	case "turn/completed":
		if tracker.turnID == "" {
			tracker.turnID = turnID
		}
		if turnID == tracker.turnID {
			tracker.completed = true
		}
	case "item/started", "item/completed":
		if item.Type == "commandExecution" && item.ID != "" && turnID != "" {
			if tracker.commands[turnID] == nil {
				tracker.commands[turnID] = map[string]bool{}
			}
			tracker.commands[turnID][item.ID] = true
		}
	}
}

func (p *codexProcess) trackerSnapshot() codexTurnTracker {
	p.mu.Lock()
	defer p.mu.Unlock()
	snapshot := p.tracker
	return snapshot
}

func (p *codexProcess) turnCommands(turnID string) map[string]bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]bool{}
	for id := range p.tracker.commands[turnID] {
		out[id] = true
	}
	return out
}

// cleanupTurn interrupts the last turn if it is still running and
// terminates the background terminals its commands left behind.
func (p *codexProcess) cleanupTurn() error {
	ctx, cancel := context.WithTimeout(context.Background(), codexCleanupBudget.get())
	defer cancel()
	if !p.trackerSnapshot().sent {
		return nil
	}
	snapshot, err := p.waitTracker(ctx, func(t codexTurnTracker) bool { return t.turnID != "" || t.rejected })
	if err != nil {
		return fmt.Errorf("turn/start outcome unconfirmed: %w", err)
	}
	if snapshot.turnID == "" {
		return nil
	}
	thread, turn := snapshot.threadID, snapshot.turnID
	if !snapshot.completed {
		if _, _, err := p.transport.call(ctx, "turn/interrupt", map[string]any{"threadId": thread, "turnId": turn}, 0, nil); err != nil {
			return fmt.Errorf("interrupt Codex turn: %w", err)
		}
		if _, err := p.waitTracker(ctx, func(t codexTurnTracker) bool { return t.completed }); err != nil {
			return fmt.Errorf("interrupted turn did not settle: %w", err)
		}
	}
	commands := p.turnCommands(turn)
	if len(commands) == 0 {
		return nil
	}
	for {
		matches, err := p.listTerminals(ctx, thread, commands)
		if err != nil {
			return err
		}
		if len(matches) == 0 {
			return nil
		}
		for _, processID := range matches {
			if _, _, err := p.transport.call(ctx, "thread/backgroundTerminals/terminate", map[string]any{"threadId": thread, "processId": processID}, 0, nil); err != nil {
				return fmt.Errorf("terminate background terminal: %w", err)
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("background terminals survived cleanup: %w", ctx.Err())
		case <-time.After(codexCleanupPoll):
		}
	}
}

// waitTracker polls until ready holds, the transport dies, or ctx ends.
func (p *codexProcess) waitTracker(ctx context.Context, ready func(codexTurnTracker) bool) (codexTurnTracker, error) {
	for {
		snapshot := p.trackerSnapshot()
		if ready(snapshot) {
			return snapshot, nil
		}
		if err := p.transport.err(); err != nil {
			return snapshot, err
		}
		select {
		case <-ctx.Done():
			return snapshot, ctx.Err()
		case <-p.transport.dead:
		case <-time.After(codexCleanupPoll):
		}
	}
}

// listTerminals pages through the thread's background terminals and returns
// the process ids that belong to commands.
func (p *codexProcess) listTerminals(ctx context.Context, threadID string, commands map[string]bool) ([]json.RawMessage, error) {
	var matches []json.RawMessage
	var cursor any
	seen := map[string]bool{}
	for {
		result, _, err := p.transport.call(ctx, "thread/backgroundTerminals/list", map[string]any{"threadId": threadID, "cursor": cursor, "limit": codexTerminalPageLimit}, 0, nil)
		if err != nil {
			return nil, fmt.Errorf("list background terminals: %w", err)
		}
		var page struct {
			Data *[]struct {
				ItemID    string          `json:"itemId"`
				ProcessID json.RawMessage `json:"processId"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if json.Unmarshal(result, &page) != nil || page.Data == nil {
			return nil, errors.New("background terminals response omitted data")
		}
		for _, entry := range *page.Data {
			if !commands[entry.ItemID] {
				continue
			}
			if codexEmptyID(entry.ProcessID) {
				return nil, errors.New("background terminal omitted process identity")
			}
			matches = append(matches, entry.ProcessID)
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return matches, nil
		}
		if seen[*page.NextCursor] {
			return nil, errors.New("background terminals cursor repeated")
		}
		seen[*page.NextCursor] = true
		cursor = *page.NextCursor
	}
}

func codexEmptyID(raw json.RawMessage) bool {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text == ""
	}
	var number json.Number
	return json.Unmarshal(raw, &number) != nil
}
