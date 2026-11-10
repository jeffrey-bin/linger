package permissionreview

import "fmt"

// Validate turns the model's output into the verdict. The model's decision is
// final, as Codex guardian's reviewer's outcome is: every outcome rule lives in
// policy.md, so code only rejects an output outside the schema's enums.
func Validate(output ModelOutput) (Verdict, error) {
	if !validRisk(output.RiskLevel) {
		return Verdict{}, fmt.Errorf("invalid risk_level %q", output.RiskLevel)
	}
	if !validAuthorization(output.UserAuthorization) {
		return Verdict{}, fmt.Errorf("invalid user_authorization %q", output.UserAuthorization)
	}
	switch output.Decision {
	case DecisionAllow, DecisionNeedsApproval, DecisionDeny:
	default:
		return Verdict{}, fmt.Errorf("invalid decision %q", output.Decision)
	}
	return Verdict{
		Decision:          output.Decision,
		RiskLevel:         output.RiskLevel,
		UserAuthorization: output.UserAuthorization,
		Rationale:         output.Rationale,
	}, nil
}

func validRisk(risk Risk) bool {
	switch risk {
	case RiskLow, RiskMedium, RiskHigh, RiskCritical:
		return true
	}
	return false
}

func validAuthorization(authorization Authorization) bool {
	switch authorization {
	case AuthHigh, AuthMedium, AuthLow, AuthUnknown:
		return true
	}
	return false
}
