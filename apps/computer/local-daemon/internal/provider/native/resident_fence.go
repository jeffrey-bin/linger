package native

import "sync"

// releaseFence is the release state an Operation saw when it started. A
// release of its Context, its Agent or everything after that moment keeps
// the Operation's process from parking.
type releaseFence struct {
	contextKey string
	agentID    string
	global     uint64
	context    uint64
	agent      uint64
}

// releaseCounters count releases per scope for the whole Computer process.
var releaseCounters = struct {
	sync.Mutex
	global   uint64
	contexts map[string]uint64
	agents   map[string]uint64
}{contexts: map[string]uint64{}, agents: map[string]uint64{}}

// captureReleaseFence records the release state for an Operation of profile.
func captureReleaseFence(profile Profile) releaseFence {
	releaseCounters.Lock()
	defer releaseCounters.Unlock()
	return releaseFence{
		contextKey: profile.ContextKey,
		agentID:    profile.AgentID,
		global:     releaseCounters.global,
		context:    releaseCounters.contexts[profile.ContextKey],
		agent:      releaseCounters.agents[profile.AgentID],
	}
}

// admits reports whether a process of this scope may still park under the
// fence: same scope, and no release of it since the capture.
func (f releaseFence) admits(scope *residency) bool {
	if scope.contextKey != f.contextKey || scope.agentID != f.agentID {
		return false
	}
	releaseCounters.Lock()
	defer releaseCounters.Unlock()
	return releaseCounters.global == f.global &&
		releaseCounters.contexts[f.contextKey] == f.context &&
		releaseCounters.agents[f.agentID] == f.agent
}

func advanceContextRelease(contextKey string) {
	if contextKey == "" {
		return
	}
	releaseCounters.Lock()
	releaseCounters.contexts[contextKey]++
	releaseCounters.Unlock()
}

func advanceAgentRelease(agentID string) {
	if agentID == "" {
		return
	}
	releaseCounters.Lock()
	releaseCounters.agents[agentID]++
	releaseCounters.Unlock()
}

func advanceGlobalRelease() {
	releaseCounters.Lock()
	releaseCounters.global++
	releaseCounters.Unlock()
}
