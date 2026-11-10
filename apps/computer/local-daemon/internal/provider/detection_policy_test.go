package provider

import "testing"

// A Runtime that can be refreshed must have something to re-probe, and one that
// answers authentication first must have an authentication probe at all.
func TestDetectionPolicyIsInternallyConsistent(t *testing.T) {
	for runtimeType, policy := range runtimeDetectionPolicies {
		if policy.authenticationProbe == nil && policy.authenticationRefresh {
			t.Fatalf("%s is refreshed but has no authentication probe", runtimeType)
		}
		if policy.authenticationProbe == nil && policy.authenticationBeforeProtocol {
			t.Fatalf("%s claims authentication precedence but has no authentication probe", runtimeType)
		}
	}
}
