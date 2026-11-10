package native

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The test binary runs with residency off; a test that needs it raises its
// provider's cap for its own duration.
func init() {
	codexResidents.setCap(0)
	claudeResidents.setCap(0)
	piResidents.setCap(0)
}

func withResidentCap[P residentProcess](t *testing.T, table *residentTable[P], limit int) {
	t.Helper()
	previous := table.setCap(limit)
	t.Cleanup(func() { table.setCap(previous) })
}

// holdsPrestart reports whether a live, non-retiring prestart of any
// provider is parked.
func holdsPrestart() bool {
	return tableHoldsPrestart(codexResidents) || tableHoldsPrestart(claudeResidents) || tableHoldsPrestart(piResidents)
}

func tableHoldsPrestart[P residentProcess](table *residentTable[P]) bool {
	table.mu.Lock()
	defer table.mu.Unlock()
	for _, entry := range table.entries {
		if !entry.retiring && entry.proc.residency().isPrestart() && table.live(entry.proc) {
			return true
		}
	}
	return false
}

// residentEntryOf returns the process under key and whether it is retiring.
func residentEntryOf[P residentProcess](table *residentTable[P], key string) (P, bool, bool) {
	table.mu.Lock()
	defer table.mu.Unlock()
	entry := table.entries[key]
	if entry == nil {
		var zero P
		return zero, false, false
	}
	return entry.proc, entry.retiring, true
}

// fakeResident is a provider-free resident. Its stop optionally blocks on
// gate, then marks it dead and confirms.
type fakeResident struct {
	res   residency
	dead  atomic.Bool
	gate  chan struct{}
	stops atomic.Int32
}

func (f *fakeResident) residency() *residency { return &f.res }
func (f *fakeResident) alive() bool           { return !f.dead.Load() }
func (f *fakeResident) residentAttrs() []any  { return []any{"pid", 0} }
func (f *fakeResident) stop() bool {
	return f.res.stop(func() bool {
		f.stops.Add(1)
		if f.gate != nil {
			<-f.gate
		}
		f.dead.Store(true)
		return true
	})
}

func newFakeResident(key string, gate chan struct{}) *fakeResident {
	f := &fakeResident{gate: gate}
	f.res.bind(key, Profile{ContextKey: "ctx", AgentID: "agent"})
	return f
}

func newFakeTable(limit int) *residentTable[*fakeResident] {
	table := newResidentTable[*fakeResident]("fake")
	table.setCap(limit)
	return table
}

func fakeFence() releaseFence {
	return captureReleaseFence(Profile{ContextKey: "ctx", AgentID: "agent"})
}

func compatible(*fakeResident) []string { return nil }

func quietLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

func awaitTrue(t *testing.T, what string, budget time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestResidentCapEvictsLeastRecentlyParked(t *testing.T) {
	table := newFakeTable(2)
	a, b, c := newFakeResident("a", nil), newFakeResident("b", nil), newFakeResident("c", nil)
	for _, p := range []*fakeResident{a, b, c} {
		if !table.park(p, fakeFence(), false, quietLogger(), nil) {
			t.Fatal("park refused")
		}
		time.Sleep(time.Millisecond)
	}
	awaitTrue(t, "a stopped", 5*time.Second, func() bool { return a.dead.Load() })
	for key, want := range map[string]*fakeResident{"b": b, "c": c} {
		got, _, err := table.take(key, compatible, quietLogger(), nil)
		if err != nil || got != want {
			t.Fatalf("take %s = %v %v", key, got, err)
		}
	}
}

func TestResidentCapZeroDisables(t *testing.T) {
	table := newFakeTable(0)
	if table.park(newFakeResident("a", nil), fakeFence(), false, quietLogger(), nil) {
		t.Fatal("cap 0 parked")
	}
}

func TestResidentDeadProcessIsNotTaken(t *testing.T) {
	table := newFakeTable(2)
	p := newFakeResident("a", nil)
	table.park(p, fakeFence(), false, quietLogger(), nil)
	p.dead.Store(true)
	if got, _, err := table.take("a", compatible, quietLogger(), nil); got != nil || err != nil {
		t.Fatalf("take = %v %v", got, err)
	}
	if live, _ := table.peek("a", compatible); live {
		t.Fatal("dead process is live")
	}
}

func TestResidentPeekDoesNotTake(t *testing.T) {
	table := newFakeTable(2)
	p := newFakeResident("a", nil)
	table.park(p, fakeFence(), false, quietLogger(), nil)
	live, fields := table.peek("a", func(*fakeResident) []string { return []string{"cwd"} })
	if !live || len(fields) != 1 {
		t.Fatalf("peek = %v %v", live, fields)
	}
	if got, _, err := table.take("a", compatible, quietLogger(), nil); got != p || err != nil {
		t.Fatalf("take = %v %v", got, err)
	}
}

func TestResidentCapVictimBlocksSpawnOnItsKey(t *testing.T) {
	table := newFakeTable(1)
	gate := make(chan struct{})
	victim := newFakeResident("victim", gate)
	table.park(victim, fakeFence(), false, quietLogger(), nil)
	table.park(newFakeResident("other", nil), fakeFence(), false, quietLogger(), nil)
	if _, retiring, ok := residentEntryOf(table, "victim"); !ok || !retiring {
		t.Fatal("victim is not retiring")
	}
	done := make(chan struct{})
	started := time.Now()
	var took time.Duration
	go func() {
		defer close(done)
		got, _, err := table.take("victim", compatible, quietLogger(), nil)
		took = time.Since(started)
		if got != nil || err != nil {
			t.Errorf("take = %v %v", got, err)
		}
	}()
	time.Sleep(150 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("take did not wait for the victim's stop")
	default:
	}
	close(gate)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("take did not return after the stop")
	}
	if took < 100*time.Millisecond {
		t.Fatalf("take returned after %v", took)
	}
}

func TestResidentReleaseByScope(t *testing.T) {
	table := newFakeTable(4)
	mine := newFakeResident("mine", nil)
	other := &fakeResident{}
	other.res.bind("other", Profile{ContextKey: "other", AgentID: "agent"})
	table.park(mine, fakeFence(), false, quietLogger(), nil)
	table.park(other, captureReleaseFence(Profile{ContextKey: "other", AgentID: "agent"}), false, quietLogger(), nil)
	count, wait := table.retireScope(func(r *residency) bool { return r.contextKey == "ctx" })
	if err := wait(); count != 1 || err != nil {
		t.Fatalf("release = %d %v", count, err)
	}
	if live, _ := table.peek("mine", compatible); live {
		t.Fatal("released key is live")
	}
	if live, _ := table.peek("other", compatible); !live {
		t.Fatal("other Context's key was released")
	}
}

func TestResidentReleaseMarksRetiringBeforeWait(t *testing.T) {
	table := newFakeTable(4)
	gate := make(chan struct{})
	p := newFakeResident("a", gate)
	table.park(p, fakeFence(), false, quietLogger(), nil)
	count, wait := table.retireScope(func(r *residency) bool { return r.contextKey == "ctx" })
	if live, _ := table.peek("a", compatible); live {
		t.Fatal("marked entry is live")
	}
	taken := make(chan *fakeResident, 1)
	go func() {
		got, _, _ := table.take("a", compatible, quietLogger(), nil)
		taken <- got
	}()
	time.Sleep(50 * time.Millisecond)
	close(gate)
	if err := wait(); count != 1 || err != nil {
		t.Fatalf("wait = %d %v", count, err)
	}
	if got := <-taken; got != nil {
		t.Fatal("a concurrent take returned the released entry")
	}
}

func TestResidentSlowStopDoesNotBlockOtherKeys(t *testing.T) {
	table := newFakeTable(4)
	gate := make(chan struct{})
	oldA := newFakeResident("home-a", gate)
	b := newFakeResident("home-b", nil)
	table.park(oldA, fakeFence(), false, quietLogger(), nil)
	table.park(b, fakeFence(), false, quietLogger(), nil)
	newA := newFakeResident("home-a", nil)
	parked := make(chan bool, 1)
	go func() { parked <- table.park(newA, fakeFence(), false, quietLogger(), nil) }()
	awaitTrue(t, "old home-a stopping", 5*time.Second, func() bool { return oldA.stops.Load() == 1 })
	takeDone := make(chan *fakeResident, 1)
	go func() {
		got, _, _ := table.take("home-b", compatible, quietLogger(), nil)
		takeDone <- got
	}()
	select {
	case got := <-takeDone:
		if got != b {
			t.Fatalf("take home-b = %v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("take on another key waited for the slow stop")
	}
	close(gate)
	if !<-parked {
		t.Fatal("new home-a park refused")
	}
	if got, _, _ := residentEntryOf(table, "home-a"); got != newA {
		t.Fatal("home-a is not the new process")
	}
}

// A prestart lives like any parked process: no deadline retires it, and
// the take that adopts it clears the mark.
func TestResidentPrestartHasNoDeadlineAndAdoptionClearsIt(t *testing.T) {
	table := newFakeTable(8)
	p := newFakeResident("a", nil)
	table.park(p, fakeFence(), true, quietLogger(), nil)
	time.Sleep(100 * time.Millisecond)
	if live, _ := table.peek("a", compatible); !live || !p.res.isPrestart() {
		t.Fatal("the prestart did not stay parked")
	}
	got, adopted, err := table.take("a", compatible, quietLogger(), nil)
	if got != p || !adopted || err != nil || p.res.isPrestart() {
		t.Fatalf("take = %v %v %v", got, adopted, err)
	}
	table.park(p, fakeFence(), false, quietLogger(), nil)
	if _, adopted, _ := table.take("a", compatible, quietLogger(), nil); adopted {
		t.Fatal("a run-parked process was taken as a prestart")
	}
}

// Only a prestart no Run has taken is reclaimed when idle; a process a Run
// parked, including a prestart a Run adopted and parked again, stays.
func TestResidentIdleReclaimsOnlyPrestarts(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	table := newFakeTable(8)
	table.setIdle(40 * time.Millisecond)
	prepared := newFakeResident("prepared", nil)
	table.park(prepared, fakeFence(), true, quietLogger(), nil)
	ran := newFakeResident("ran", nil)
	table.park(ran, fakeFence(), false, quietLogger(), nil)
	adopted := newFakeResident("adopted", nil)
	table.park(adopted, fakeFence(), true, quietLogger(), nil)
	if got, wasPrestart, err := table.take("adopted", compatible, quietLogger(), nil); got != adopted || !wasPrestart || err != nil {
		t.Fatalf("take = %v %v %v", got, wasPrestart, err)
	}
	table.park(adopted, fakeFence(), false, quietLogger(), nil)
	awaitTrue(t, "prestart idle reclaim", 5*time.Second, func() bool { return prepared.dead.Load() })
	time.Sleep(200 * time.Millisecond)
	// The reclaim runs outside any Operation, so it must reach the Daemon log.
	if !strings.Contains(logs.String(), "resident recycled") || !strings.Contains(logs.String(), "reason=idle") {
		t.Fatalf("idle reclaim missing from the Daemon log: %q", logs.String())
	}
	for _, p := range []*fakeResident{ran, adopted} {
		if p.dead.Load() {
			t.Fatalf("%s: a run-parked process was reclaimed when idle", p.res.key)
		}
		if got, _, err := table.take(p.res.key, compatible, quietLogger(), nil); got != p || err != nil {
			t.Fatalf("%s: take = %v %v", p.res.key, got, err)
		}
	}
}

// The cap evicts a prestart no Run has used before a process a Run parked.
func TestResidentCapEvictsPrestartsFirst(t *testing.T) {
	table := newFakeTable(2)
	ran := newFakeResident("ran", nil)
	table.park(ran, fakeFence(), false, quietLogger(), nil)
	prepared := newFakeResident("prepared", nil)
	table.park(prepared, fakeFence(), true, quietLogger(), nil)
	table.park(newFakeResident("next", nil), fakeFence(), false, quietLogger(), nil)
	awaitTrue(t, "cap eviction", 5*time.Second, func() bool { return prepared.dead.Load() })
	if ran.dead.Load() {
		t.Fatal("the cap evicted the process a Run parked")
	}
}

// Every recycle of the process an Operation would have used is counted for
// it; evicting another Context's process to fit the cap is not.
func TestResidentRecyclesAreCounted(t *testing.T) {
	table := newFakeTable(1)
	counters := &ReadinessCounters{}
	table.park(newFakeResident("a", nil), fakeFence(), false, quietLogger(), nil)
	table.park(newFakeResident("b", nil), fakeFence(), false, quietLogger(), counters)
	if _, _, err := table.take("b", func(*fakeResident) []string { return []string{"skills"} }, quietLogger(), counters); err != nil {
		t.Fatal(err)
	}
	table.park(newFakeResident("c", nil), fakeFence(), false, quietLogger(), nil)
	if err := table.stopKey("c", quietLogger(), counters); err != nil {
		t.Fatal(err)
	}
	attrs := counters.LogAttrs()
	if attrs[len(attrs)-1] != "incompatible:skills=1,spawn=1" {
		t.Fatalf("attrs = %v", attrs)
	}
}

func TestResidentFenceRefusesAfterRelease(t *testing.T) {
	table := newFakeTable(8)
	scope := Profile{ContextKey: "fence-ctx", AgentID: "fence-agent"}
	for name, release := range map[string]func(){
		"context": func() { advanceContextRelease(scope.ContextKey) },
		"agent":   func() { advanceAgentRelease(scope.AgentID) },
		"all":     advanceGlobalRelease,
	} {
		t.Run(name, func(t *testing.T) {
			fence := captureReleaseFence(scope)
			p := &fakeResident{}
			p.res.bind("fenced-"+name, scope)
			release()
			if table.park(p, fence, false, quietLogger(), nil) {
				t.Fatal("parked after a release")
			}
			other := &fakeResident{}
			other.res.bind("other-"+name, Profile{ContextKey: "fence-other", AgentID: "fence-other"})
			otherFence := captureReleaseFence(Profile{ContextKey: "fence-other", AgentID: "fence-other"})
			if !table.park(other, otherFence, false, quietLogger(), nil) {
				t.Fatal("another scope could not park")
			}
		})
	}
	mismatched := &fakeResident{}
	mismatched.res.bind("mismatched", Profile{ContextKey: "a"})
	if table.park(mismatched, captureReleaseFence(Profile{ContextKey: "b"}), false, quietLogger(), nil) {
		t.Fatal("parked under another scope's fence")
	}
}

func TestResidentStopSerializesAndConfirmsOnce(t *testing.T) {
	gate := make(chan struct{})
	p := newFakeResident("a", gate)
	var wg sync.WaitGroup
	results := make([]bool, 2)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = p.stop()
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(gate)
	wg.Wait()
	if !results[0] || !results[1] || p.stops.Load() != 1 || !p.stop() || p.stops.Load() != 1 {
		t.Fatalf("results %v stops %d", results, p.stops.Load())
	}
}

func TestResidentUnconfirmedStopHoldsKey(t *testing.T) {
	table := newResidentTable[*stubbornResident]("stubborn")
	var confirm atomic.Bool
	p := &stubbornResident{confirm: &confirm}
	p.res.bind("a", Profile{})
	table.park(p, captureReleaseFence(Profile{}), false, quietLogger(), nil)
	if _, _, err := table.take("a", func(*stubbornResident) []string { return []string{"cwd"} }, quietLogger(), nil); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("take = %v", err)
	}
	if got, retiring, ok := residentEntryOf(table, "a"); !ok || !retiring || got != p {
		t.Fatal("unconfirmed entry left the table")
	}
	confirm.Store(true)
	if got, _, err := table.take("a", nil, quietLogger(), nil); got != nil || err != nil {
		t.Fatalf("retry = %v %v", got, err)
	}
	if _, _, ok := residentEntryOf(table, "a"); ok {
		t.Fatal("confirmed entry stayed")
	}
}

type stubbornResident struct {
	res     residency
	confirm *atomic.Bool
}

func (s *stubbornResident) residency() *residency { return &s.res }
func (s *stubbornResident) alive() bool           { return true }
func (s *stubbornResident) residentAttrs() []any  { return nil }
func (s *stubbornResident) stop() bool {
	return s.res.stop(func() bool { return s.confirm.Load() })
}
