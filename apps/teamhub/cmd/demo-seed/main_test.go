package main

import "testing"

func TestDevelopmentSeedEnabled(t *testing.T) {
	for _, test := range []struct {
		name      string
		value     string
		want      bool
		wantError bool
	}{
		{name: "unset is disabled"},
		{name: "false is disabled", value: "false"},
		{name: "true is enabled", value: "true", want: true},
		{name: "invalid is rejected", value: "sometimes", wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := developmentSeedEnabled(test.value)
			if (err != nil) != test.wantError || got != test.want {
				t.Fatalf("developmentSeedEnabled(%q)=(%t,%v) want=(%t,error=%t)", test.value, got, err, test.want, test.wantError)
			}
		})
	}
}
