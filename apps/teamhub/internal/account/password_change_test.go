package account

import (
	"errors"
	"strings"
	"testing"
)

func TestPasswordChangeValidation(t *testing.T) {
	for _, tc := range []struct {
		name, current, next string
		want                bool
	}{
		{"minimum", "x", "12345678", true},
		{"maximum", strings.Repeat("x", 1024), strings.Repeat("x", 1024), true},
		{"empty current", "", "12345678", false},
		{"long current", strings.Repeat("x", 1025), "12345678", false},
		{"short new", "x", "1234567", false},
		{"long new", "x", strings.Repeat("x", 1025), false},
		{"existing byte policy", "x", "Größe€✓", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validPasswordChange(PasswordChange{AccountID: "account", SessionID: "session", CurrentPassword: tc.current, NewPassword: tc.next}); got != tc.want {
				t.Fatalf("valid=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestNormalizeEmailLimitsTheLocalPart(t *testing.T) {
	for _, tc := range []struct {
		email string
		want  error
	}{
		{" Owner@Example.com ", nil},
		{strings.Repeat("a", maxEmailLocalPart) + "@example.com", nil},
		{strings.Repeat("a", maxEmailLocalPart+1) + "@example.com", ErrInvalidEmail},
		{"not-an-email", ErrInvalidEmail},
	} {
		if _, err := normalizeEmail(tc.email); !errors.Is(err, tc.want) {
			t.Fatalf("normalizeEmail(%q) err=%v want %v", tc.email, err, tc.want)
		}
	}
}
