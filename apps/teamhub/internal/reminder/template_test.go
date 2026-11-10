package reminder

import "testing"

func TestValidateTemplateRoutineSnapshot(t *testing.T) {
	hours := 2
	valid := TemplateRoutine{Key: "entry", Name: "Check", Instruction: "Check the Room.", Cadence: Cadence{Kind: "every_n_hours", Timezone: "UTC", IntervalHours: &hours}, Enabled: true, CreatedByRole: "agent"}
	if err := ValidateTemplateRoutines([]TemplateRoutine{valid}); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"duplicate key", "missing key", "invalid role", "foreign mention", "invalid timezone"} {
		t.Run(scenario, func(t *testing.T) {
			item := valid
			items := []TemplateRoutine{item}
			switch scenario {
			case "duplicate key":
				items = append(items, item)
			case "missing key":
				items[0].Key = ""
			case "invalid role":
				items[0].CreatedByRole = "publisher"
			case "foreign mention":
				role := "other-agent"
				items[0].MentionRole = &role
			case "invalid timezone":
				items[0].Cadence.Timezone = "Missing/Zone"
			}
			if err := ValidateTemplateRoutines(items); err == nil {
				t.Fatal("invalid portable snapshot accepted")
			}
		})
	}
}
