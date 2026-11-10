package native

import "errors"

// residentStore is the provider-independent view of one resident table
// that the cross-provider stop functions use.
type residentStore interface {
	// retireScope marks every matching entry retiring (reason "release")
	// and returns the count and a wait that stops them.
	retireScope(match func(*residency) bool) (int, func() error)
	// parkedFor reports a live, non-retiring entry of a Context.
	parkedFor(contextKey string) bool
}

// residentStores lists the provider tables in stop order: Codex, Claude,
// Pi. A provider without a table yet contributes nil.
func residentStores() []residentStore {
	stores := []residentStore{codexResidents, claudeResidents, piResidentStore()}
	out := stores[:0]
	for _, store := range stores {
		if store != nil {
			out = append(out, store)
		}
	}
	return out
}

// retireScopes marks the matching entries of every provider and returns
// the wait that stops them all. A failure in one provider never skips the
// others.
func retireScopes(match func(*residency) bool) func() (int, error) {
	type pending struct {
		count int
		wait  func() error
	}
	var marked []pending
	for _, store := range residentStores() {
		count, wait := store.retireScope(match)
		marked = append(marked, pending{count, wait})
	}
	return func() (int, error) {
		total := 0
		var errs []error
		for _, entry := range marked {
			total += entry.count
			if err := entry.wait(); err != nil {
				errs = append(errs, err)
			}
		}
		return total, errors.Join(errs...)
	}
}

// RetireParkedResidentsForContext stops reuse of a Context's parked
// processes at once and returns the wait that confirms their exit. A turn
// of the Context that settles later refuses to park.
func RetireParkedResidentsForContext(contextKey string) func() (int, error) {
	if contextKey == "" {
		return func() (int, error) { return 0, nil }
	}
	advanceContextRelease(contextKey)
	return retireScopes(func(r *residency) bool { return r.contextKey == contextKey })
}

// StopParkedResidentsForContext stops a Context's parked processes of every
// provider and waits for their exit.
func StopParkedResidentsForContext(contextKey string) (int, error) {
	if contextKey == "" {
		return 0, nil
	}
	return RetireParkedResidentsForContext(contextKey)()
}

// StopParkedResidentsForAgent stops an Agent's parked processes of every
// provider and waits for their exit.
func StopParkedResidentsForAgent(agentID string) (int, error) {
	if agentID == "" {
		return 0, nil
	}
	advanceAgentRelease(agentID)
	return retireScopes(func(r *residency) bool { return r.agentID == agentID })()
}

// ContextHasParkedResident reports whether a live process of any provider is
// parked for a Context, ready for its next Run.
func ContextHasParkedResident(contextKey string) bool {
	if contextKey == "" {
		return false
	}
	for _, store := range residentStores() {
		if store.parkedFor(contextKey) {
			return true
		}
	}
	return false
}

// StopAllParkedResidents stops every parked process of every provider. The
// Daemon calls it at shutdown.
func StopAllParkedResidents() (int, error) {
	advanceGlobalRelease()
	return retireScopes(func(*residency) bool { return true })()
}
