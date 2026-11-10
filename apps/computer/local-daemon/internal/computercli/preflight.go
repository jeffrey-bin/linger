package computercli

import (
	"maps"
	"slices"
)

// resolveUsableRuntimePaths pins the executable of every enabled Runtime that
// can back an Agent. Login may proceed before any Runtime is installed.
func resolveUsableRuntimePaths(diagnostics []runtimeDiagnostic, requested map[string]string, enabled []string) (map[string]string, error) {
	if enabled == nil {
		enabled = runtimeTypes
	}
	diagnostics = slices.DeleteFunc(slices.Clone(diagnostics), func(diagnostic runtimeDiagnostic) bool {
		return !slices.Contains(runtimeTypes, diagnostic.Type) || !slices.Contains(enabled, diagnostic.Type)
	})
	paths := maps.Clone(requested)
	if paths == nil {
		paths = map[string]string{}
	}
	usable := false
	for _, runtimeType := range enabled {
		index := slices.IndexFunc(diagnostics, func(diagnostic runtimeDiagnostic) bool { return diagnostic.Type == runtimeType })
		var diagnostic *runtimeDiagnostic
		if index != -1 {
			diagnostic = &diagnostics[index]
		}
		canBack := canBackAgent(diagnostic)
		if requested[runtimeType] != "" && !canBack {
			detail := "runtime unavailable"
			if diagnostic != nil && diagnostic.ErrorMessage != "" {
				detail = diagnostic.ErrorMessage
			}
			return nil, newError(categoryCapabilityProbe, runtimeType+" capability probe failed: "+detail)
		}
		if canBack && diagnostic.EntryPath != "" && requested[runtimeType] == "" {
			paths[runtimeType] = diagnostic.EntryPath
		}
	}
	for index := range diagnostics {
		usable = usable || canBackAgent(&diagnostics[index])
	}
	allAbsent := len(diagnostics) > 0 && len(enabled) > 0
	for _, runtimeType := range enabled {
		allAbsent = allAbsent && slices.ContainsFunc(diagnostics, func(diagnostic runtimeDiagnostic) bool {
			return diagnostic.Type == runtimeType && diagnostic.Status == "not_installed"
		})
	}
	if !usable && !allAbsent {
		category := categoryRuntimeUnavailable
		if slices.ContainsFunc(diagnostics, func(diagnostic runtimeDiagnostic) bool { return diagnostic.ExecutablePath != "" }) {
			category = categoryCapabilityProbe
		}
		return nil, newError(category, "No supported Runtime passed capability probing (codex, claude, pi)")
	}
	return paths, nil
}

func canBackAgent(diagnostic *runtimeDiagnostic) bool {
	return diagnostic != nil && diagnostic.ExecutablePath != "" && (diagnostic.Status == "ready" || diagnostic.Status == "authentication_required")
}
