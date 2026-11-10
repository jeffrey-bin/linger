package voicelive

import "testing"

func TestTaskFilePathIsRelativeToTheTaskFolder(t *testing.T) {
	const task = "workitem_1d098ce43808c5d388b81b791cf335e8"
	for raw, want := range map[string]string{
		"./playground/" + task + "/report.md": "report.md",
		"playground/" + task + "/out/a.md":    "out/a.md",
		"./playground/" + task:                "",
		task + "/report.md":                   "report.md",
		"report.md":                           "report.md",
		" ./report.md ":                       "report.md",
		"":                                    "",
		".":                                   "",
		"playground/workitem_other/report.md": "playground/workitem_other/report.md",
		"../" + task + "/report.md":           "../" + task + "/report.md",
	} {
		if got := TaskFilePath(raw, task); got != want {
			t.Fatalf("%q: %q, want %q", raw, got, want)
		}
	}
}
