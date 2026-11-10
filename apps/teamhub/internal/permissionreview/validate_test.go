package permissionreview

import "testing"

func TestValidateKeepsTheModelVerdict(t *testing.T) {
	t.Parallel()
	for _, output := range []ModelOutput{
		{RiskLevel: RiskLow, UserAuthorization: AuthUnknown, Decision: DecisionAllow, Rationale: "a read"},
		{RiskLevel: RiskHigh, UserAuthorization: AuthHigh, Decision: DecisionAllow, Rationale: "the sponsor asked for this send"},
		{RiskLevel: RiskHigh, UserAuthorization: AuthLow, Decision: DecisionNeedsApproval, Rationale: "the sponsor did not name the recipient"},
		{RiskLevel: RiskCritical, UserAuthorization: AuthUnknown, Decision: DecisionDeny, Rationale: "uploads a private key"},
	} {
		verdict, err := Validate(output)
		if err != nil {
			t.Fatalf("Validate(%+v): %v", output, err)
		}
		if verdict != (Verdict{Decision: output.Decision, RiskLevel: output.RiskLevel, UserAuthorization: output.UserAuthorization, Rationale: output.Rationale}) {
			t.Errorf("Validate(%+v) = %+v", output, verdict)
		}
	}
}

func TestValidateRejectsUnknownEnums(t *testing.T) {
	t.Parallel()
	for _, output := range []ModelOutput{
		{RiskLevel: "severe", UserAuthorization: AuthHigh, Decision: DecisionAllow},
		{RiskLevel: RiskLow, UserAuthorization: "yes", Decision: DecisionAllow},
		{RiskLevel: RiskLow, UserAuthorization: AuthHigh, Decision: "ask"},
	} {
		if _, err := Validate(output); err == nil {
			t.Fatalf("Validate(%+v) accepted an invalid enum", output)
		}
	}
}
