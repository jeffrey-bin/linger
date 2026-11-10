package skill

import "strings"

// policyConflict contains only diagnostic policy facts, never config values or credentials.
type policyConflict struct{ description string }

func (e *policyConflict) Error() string { return e.description }
func (e *policyConflict) Unwrap() error { return ErrConflict }

func newPolicyConflict(reason string, references ...string) error {
	if len(references) > 10 {
		references = references[:10]
	}
	description := "Skill configuration requires repair: " + reason
	if len(references) > 0 {
		description += " (" + strings.Join(references, ", ") + ")"
	}
	return &policyConflict{description: description}
}
