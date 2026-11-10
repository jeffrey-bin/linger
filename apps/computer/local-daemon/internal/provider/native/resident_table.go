package native

import (
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultResidentCap is how many parked processes each provider keeps in
// one Computer process. A cap of 0 turns residency off for a provider.
const DefaultResidentCap = 8

// DefaultPrestartIdle is how long a process a prepare parked waits for a Run
// before it is reclaimed. A process a Run parked has no idle limit: it stays
// until the cap needs room or a release stops it, so a later Run or session
// compaction still finds it.
const DefaultPrestartIdle = 20 * time.Minute

// errResidentRecycleUnconfirmed is shared by every provider: a parked or
// held process could not be confirmed gone, so its key stays fenced.
var errResidentRecycleUnconfirmed = errors.New("provider resident recycle: process tree exit could not be confirmed")

// residentProcess is a provider process that can park in a residentTable.
// Providers never hold their own process lock while they call the table;
// the table may call alive and residentAttrs under its lock.
type residentProcess interface {
	comparable
	residency() *residency
	// alive is the provider's own liveness test.
	alive() bool
	// stop confirms the process tree is gone. Implementations route it
	// through residency.stop so that stops of one process are serialized.
	stop() bool
	// residentAttrs are the provider fields of resident log events.
	residentAttrs() []any
}

// residency is the table-facing state every provider process carries.
// key, contextKey and agentID are fixed at spawn.
type residency struct {
	key        string
	contextKey string
	agentID    string

	mu sync.Mutex
	// prestart marks a process a provider prepare parked that no Run has
	// taken yet. Only adoption and the idle reclaim treat it differently.
	prestart bool
	owner    *slog.Logger

	stopping  atomic.Bool
	stopMu    sync.Mutex
	confirmed bool
	inFlight  *residentStopCall
}

type residentStopCall struct {
	done      chan struct{}
	confirmed bool
}

// bind fixes the process's key and its Context and Agent scope.
func (r *residency) bind(key string, profile Profile) {
	r.key, r.contextKey, r.agentID = key, profile.ContextKey, profile.AgentID
}

// stop runs tree at most once at a time. A confirmed stop is final; a stop
// that overlaps a running one waits for it and reports its result.
func (r *residency) stop(tree func() bool) bool {
	r.stopMu.Lock()
	if r.confirmed {
		r.stopMu.Unlock()
		return true
	}
	if call := r.inFlight; call != nil {
		r.stopMu.Unlock()
		<-call.done
		return call.confirmed
	}
	call := &residentStopCall{done: make(chan struct{})}
	r.inFlight = call
	r.stopping.Store(true)
	r.stopMu.Unlock()

	confirmed := tree()

	r.stopMu.Lock()
	call.confirmed = confirmed
	r.confirmed = r.confirmed || confirmed
	r.inFlight = nil
	r.stopMu.Unlock()
	close(call.done)
	return confirmed
}

func (r *residency) isStopping() bool { return r.stopping.Load() }

// isPrestart reports a parked provider prepare no Run has taken yet.
func (r *residency) isPrestart() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.prestart
}

func (r *residency) setOwner(logger *slog.Logger) {
	if logger == nil {
		return
	}
	r.mu.Lock()
	r.owner = logger
	r.mu.Unlock()
}

// loggerOr is the owner logger, else fallback (which may be nil).
func (r *residency) loggerOr(fallback *slog.Logger) *slog.Logger {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.owner != nil {
		return r.owner
	}
	return fallback
}

type residentEntry[P residentProcess] struct {
	proc     P
	parkSeq  uint64
	retiring bool
}

// residentTable keeps at most one process per key for one provider: parked
// and reusable, or retiring until its exit is confirmed.
type residentTable[P residentProcess] struct {
	provider string

	mu      sync.Mutex
	limit   int
	idle    time.Duration
	seq     uint64
	entries map[string]*residentEntry[P]
}

func newResidentTable[P residentProcess](provider string) *residentTable[P] {
	return &residentTable[P]{provider: provider, limit: DefaultResidentCap, idle: DefaultPrestartIdle, entries: map[string]*residentEntry[P]{}}
}

// setIdle replaces the prestart idle reclaim delay and returns the previous one. It is
// the test seam for the idle reclaim.
func (t *residentTable[P]) setIdle(idle time.Duration) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	previous := t.idle
	t.idle = idle
	return previous
}

// setCap replaces the cap and returns the previous one. It is the test seam
// for residency; production keeps DefaultResidentCap.
func (t *residentTable[P]) setCap(limit int) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	previous := t.limit
	t.limit = limit
	return previous
}

func (t *residentTable[P]) enabled() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.limit > 0
}

func (t *residentTable[P]) live(p P) bool {
	return !p.residency().isStopping() && p.alive()
}

// note logs one resident event. withMismatch adds the mismatch attribute,
// which take recycles carry.
func (t *residentTable[P]) note(logger *slog.Logger, p P, event, reason string, mismatch []string, withMismatch bool) {
	if logger == nil {
		return
	}
	attrs := append([]any{"reason", reason}, p.residentAttrs()...)
	if withMismatch {
		attrs = append(attrs, "mismatch", strings.Join(mismatch, ","))
	}
	logger.Info(t.provider+" resident "+event, attrs...)
}

// noteUnowned records a recycle no running Operation caused in the Daemon log,
// where it can be found without knowing the Operation, and in the
// diagnostics of the Operation that last owned the process.
func (t *residentTable[P]) noteUnowned(p P, reason string) {
	t.note(slog.Default(), p, "recycled", reason, nil, false)
	if owner := p.residency().loggerOr(nil); owner != nil && owner != slog.Default() {
		t.note(owner, p, "recycled", reason, nil, false)
	}
}

// peek reports whether a live entry is parked under key and, when it is,
// the fields that keep it from serving the caller. It changes nothing.
func (t *residentTable[P]) peek(key string, mismatch func(P) []string) (bool, []string) {
	t.mu.Lock()
	entry := t.entries[key]
	if t.limit <= 0 || entry == nil || entry.retiring {
		t.mu.Unlock()
		return false, nil
	}
	p := entry.proc
	t.mu.Unlock()
	if !t.live(p) {
		return false, nil
	}
	return true, mismatch(p)
}

// take removes and returns a live compatible process parked under key.
// adopted is true when the process was an unadopted prepare. A dead or
// incompatible entry is retired before take returns; an unconfirmed stop
// fails the take.
func (t *residentTable[P]) take(key string, mismatch func(P) []string, logger *slog.Logger, counters *ReadinessCounters) (proc P, adopted bool, err error) {
	var zero P
	for {
		t.mu.Lock()
		entry := t.entries[key]
		if t.limit <= 0 || entry == nil {
			t.mu.Unlock()
			return zero, false, nil
		}
		p, wasRetiring := entry.proc, entry.retiring
		p.residency().setOwner(logger)
		t.mu.Unlock()

		// Liveness and the mismatch rules may read files; keep them outside
		// the lock and check the entry again afterwards.
		expired := wasRetiring || !t.live(p)
		var fields []string
		if !expired {
			fields = mismatch(p)
		}

		t.mu.Lock()
		if t.entries[key] != entry || entry.retiring != wasRetiring {
			t.mu.Unlock()
			continue
		}
		res := p.residency()
		if !expired && len(fields) == 0 {
			delete(t.entries, key)
			res.mu.Lock()
			adopted, res.prestart = res.prestart, false
			res.mu.Unlock()
			t.mu.Unlock()
			if adopted {
				t.note(res.loggerOr(logger), p, "adopted", "run_started", nil, false)
			} else {
				t.note(res.loggerOr(logger), p, "reused", "turn_started", nil, false)
			}
			return p, adopted, nil
		}
		entry.retiring = true
		t.mu.Unlock()
		reason := "incompatible"
		if expired {
			reason, fields = "expired", nil
		}
		t.note(res.loggerOr(logger), p, "recycled", reason, fields, true)
		// A process another release already retires is not this Operation's work.
		if !wasRetiring {
			counters.recycled(reason, fields)
		}
		if !t.retire(p) {
			return zero, false, errResidentRecycleUnconfirmed
		}
		return zero, false, nil
	}
}

// takeContext removes and returns the live process parked for a Context,
// with the release fence a later park must pass. An unadopted prepare is
// left alone: a Run is about to adopt it.
func (t *residentTable[P]) takeContext(contextKey string, logger *slog.Logger) (proc P, fence releaseFence, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.limit <= 0 || contextKey == "" {
		return proc, fence, false
	}
	for key, entry := range t.entries {
		res := entry.proc.residency()
		if entry.retiring || res.contextKey != contextKey || res.isPrestart() || !t.live(entry.proc) {
			continue
		}
		fence = captureReleaseFence(Profile{ContextKey: res.contextKey, AgentID: res.agentID})
		delete(t.entries, key)
		res.setOwner(logger)
		t.note(logger, entry.proc, "taken", "compaction", nil, false)
		return entry.proc, fence, true
	}
	return proc, fence, false
}

// park registers p under its key for a later take. prestart marks a process
// a provider prepare parked; only such a process is reclaimed when idle.
func (t *residentTable[P]) park(p P, fence releaseFence, prestart bool, logger *slog.Logger, counters *ReadinessCounters) bool {
	res := p.residency()
	if res.key == "" || !t.enabled() || !t.live(p) {
		return false
	}
	t.mu.Lock()
	if other := t.entries[res.key]; other != nil && other.proc != p {
		// The other owner's exit path takes the table lock, so retire it
		// without holding the lock.
		other.retiring = true
		t.mu.Unlock()
		t.note(other.proc.residency().loggerOr(logger), other.proc, "recycled", "spawn", nil, false)
		counters.recycled("spawn", nil)
		if !t.retire(other.proc) {
			return false
		}
		t.mu.Lock()
		if again := t.entries[res.key]; again != nil && again.proc != p {
			t.mu.Unlock()
			return false
		}
	}
	if !fence.admits(res) {
		t.mu.Unlock()
		t.note(res.loggerOr(logger), p, "recycled", "released", nil, false)
		counters.recycled("released", nil)
		return false
	}
	res.mu.Lock()
	res.prestart = prestart
	if logger != nil {
		res.owner = logger
	}
	res.mu.Unlock()
	t.seq++
	parkSeq := t.seq
	t.entries[res.key] = &residentEntry[P]{proc: p, parkSeq: parkSeq}
	victims := t.capVictimsLocked(p)
	idle := t.idle
	t.mu.Unlock()

	t.note(res.loggerOr(logger), p, "parked", "turn_completed", nil, false)
	// Cap victims are other Contexts' processes; their recycle is not work
	// this Operation did to get its own.
	for _, victim := range victims {
		t.noteUnowned(victim, "cap")
		go t.retire(victim)
	}
	if prestart && idle > 0 {
		time.AfterFunc(idle, func() { t.reclaimIdle(p, parkSeq) })
	}
	return true
}

// reclaimIdle retires the prestart p when it is still the parking parkSeq
// made. A Run that takes the prestart and parks it again gives it a new
// parkSeq and no idle delay, so the earlier delay passes it by.
func (t *residentTable[P]) reclaimIdle(p P, parkSeq uint64) {
	key := p.residency().key
	t.mu.Lock()
	entry := t.entries[key]
	if entry == nil || entry.proc != p || entry.retiring || entry.parkSeq != parkSeq {
		t.mu.Unlock()
		return
	}
	entry.retiring = true
	t.mu.Unlock()
	t.noteUnowned(p, "idle")
	t.retire(p)
}

// capVictimsLocked marks entries retiring until the non-retiring count fits
// the cap: prestarts no Run has used go first, then the least recently
// parked. The process just parked is spared.
func (t *residentTable[P]) capVictimsLocked(parked P) []P {
	var victims []P
	for {
		var oldest *residentEntry[P]
		count := 0
		for _, entry := range t.entries {
			if entry.retiring {
				continue
			}
			count++
			if entry.proc == parked {
				continue
			}
			prestart := entry.proc.residency().isPrestart()
			if oldest == nil {
				oldest = entry
				continue
			}
			oldestPrestart := oldest.proc.residency().isPrestart()
			if prestart != oldestPrestart {
				if prestart {
					oldest = entry
				}
				continue
			}
			if entry.parkSeq < oldest.parkSeq {
				oldest = entry
			}
		}
		if count <= t.limit || oldest == nil {
			return victims
		}
		oldest.retiring = true
		victims = append(victims, oldest.proc)
	}
}

// retire stops p while its entry stays in the table. A confirmed stop
// removes the entry; an unconfirmed one holds p as retiring.
func (t *residentTable[P]) retire(p P) bool {
	if p.stop() {
		t.forget(p)
		return true
	}
	t.hold(p)
	return false
}

// forget removes p's entry when the key still maps to p.
func (t *residentTable[P]) forget(p P) {
	key := p.residency().key
	t.mu.Lock()
	defer t.mu.Unlock()
	if entry := t.entries[key]; entry != nil && entry.proc == p {
		delete(t.entries, key)
	}
}

// hold keeps p as retiring under its key, unless another process owns the
// key, so that no spawn on the key starts before p's exit is confirmed.
func (t *residentTable[P]) hold(p P) {
	key := p.residency().key
	if key == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	switch entry := t.entries[key]; {
	case entry == nil:
		t.seq++
		t.entries[key] = &residentEntry[P]{proc: p, parkSeq: t.seq, retiring: true}
	case entry.proc == p:
		entry.retiring = true
	}
}

// markWhere marks every matching entry retiring and logs it. Nothing is
// stopped yet.
func (t *residentTable[P]) markWhere(reason string, match func(P) bool, fallback *slog.Logger) []P {
	t.mu.Lock()
	var marked []P
	for _, entry := range t.entries {
		if match(entry.proc) {
			entry.retiring = true
			marked = append(marked, entry.proc)
		}
	}
	t.mu.Unlock()
	for _, p := range marked {
		t.note(p.residency().loggerOr(fallback), p, "recycled", reason, nil, false)
	}
	return marked
}

// retireAll retires every process concurrently. It fails with the shared
// recycle error when any stop was unconfirmed.
func (t *residentTable[P]) retireAll(procs []P) error {
	var wg sync.WaitGroup
	var unconfirmed atomic.Bool
	for _, p := range procs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !t.retire(p) {
				unconfirmed.Store(true)
			}
		}()
	}
	wg.Wait()
	if unconfirmed.Load() {
		return errResidentRecycleUnconfirmed
	}
	return nil
}

// stopWhere marks and retires every matching entry and returns the count.
func (t *residentTable[P]) stopWhere(reason string, match func(P) bool, fallback *slog.Logger) (int, error) {
	marked := t.markWhere(reason, match, fallback)
	return len(marked), t.retireAll(marked)
}

// stopKey stops whatever holds key before a fresh spawn on it.
func (t *residentTable[P]) stopKey(key string, logger *slog.Logger, counters *ReadinessCounters) error {
	if key == "" {
		return nil
	}
	stopped, err := t.stopWhere("spawn", func(p P) bool { return p.residency().key == key }, logger)
	for range stopped {
		counters.recycled("spawn", nil)
	}
	return err
}

// retireScope implements residentStore.
func (t *residentTable[P]) retireScope(match func(*residency) bool) (int, func() error) {
	marked := t.markWhere("release", func(p P) bool { return match(p.residency()) }, slog.Default())
	return len(marked), func() error { return t.retireAll(marked) }
}

// parkedFor implements residentStore.
func (t *residentTable[P]) parkedFor(contextKey string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, entry := range t.entries {
		if !entry.retiring && entry.proc.residency().contextKey == contextKey && t.live(entry.proc) {
			return true
		}
	}
	return false
}
