package daemon

import (
	"encoding/json"
	"errors"
	"slices"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
)

func runtimeEnabled(scope []string, kind string) bool {
	return scope == nil || slices.Contains(scope, kind)
}

func (d *Daemon) runtimeEnabled(kind string) bool {
	return runtimeEnabled(d.enabledRuntimes, kind)
}

func validateRuntimeInventoryScope(scope, runtimes []string, diagnostics json.RawMessage, observations []transport.RegistrationObservation) error {
	if scope == nil {
		return nil
	}
	for _, kind := range runtimes {
		if !runtimeEnabled(scope, kind) {
			return errors.New("Runtime is not enabled on this Computer")
		}
	}
	if len(diagnostics) != 0 {
		var rows []struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(diagnostics, &rows); err != nil {
			return errors.New("Runtime diagnostic inventory is invalid")
		}
		for _, row := range rows {
			if !runtimeEnabled(scope, row.Type) {
				return errors.New("Runtime is not enabled on this Computer")
			}
		}
	}
	for _, row := range observations {
		if !runtimeEnabled(scope, row.ProviderType) {
			return errors.New("Runtime is not enabled on this Computer")
		}
	}
	return nil
}

func (d *Daemon) enabledRegistrationObservations(rows []transport.RegistrationObservation) []transport.RegistrationObservation {
	return slices.DeleteFunc(rows, func(row transport.RegistrationObservation) bool { return !d.runtimeEnabled(row.ProviderType) })
}
