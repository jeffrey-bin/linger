package app

import "testing"

// runnerCredentialVector is also verified by the Runner Gateway's credential
// test in apps/node-services, so both sides agree on the token format.
const runnerCredentialVector = "sr1.eyJjcmVkZW50aWFsX2dlbmVyYXRpb24iOjIsImV4cCI6MjAwMDAwMDAwMCwiaWF0IjoxNzAwMDAwMDAwLCJydW5uZXJfaWQiOiJjb21wdXRlcl8xIiwidGVuYW50X293bmVycyI6W3sib3duZXJfYWN0b3JfaWQiOiJhY3Rvcl9vd25lciIsInRlbmFudF9pZCI6InRlbmFudF8xIn1dLCJ2IjoxfQ.gm_cetXEmBKmoORdn9iy3oBzzcr6zuj70O8Beyw5qMQ"

func TestSignRunnerCredentialMatchesTheGatewayFormat(t *testing.T) {
	token, err := signRunnerCredential("runner-signing-key-that-is-at-least-32-bytes", runnerCredentialClaims{
		CredentialGeneration: 2, Exp: 2_000_000_000, Iat: 1_700_000_000, RunnerID: "computer_1",
		TenantOwners: []runnerCredentialOwner{{OwnerActorID: "actor_owner", TenantID: "tenant_1"}}, V: 1,
	})
	if err != nil || token != runnerCredentialVector {
		t.Fatalf("token=%q err=%v", token, err)
	}
}
