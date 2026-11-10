package agenttemplates

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
)

func TestBuiltinTemplatesAreValidAndOrdered(t *testing.T) {
	templates, err := Builtin()
	if err != nil {
		t.Fatalf("load built-in Agent templates: %v", err)
	}
	if len(templates) < 2 {
		t.Fatalf("want at least two shipped templates, got %d", len(templates))
	}
	for index := 1; index < len(templates); index++ {
		if templates[index-1].TemplateID >= templates[index].TemplateID {
			t.Fatalf("templates are not ordered by template_id: %q then %q",
				templates[index-1].TemplateID, templates[index].TemplateID)
		}
	}
	for _, template := range templates {
		if template.Name == "" || template.Instructions == "" {
			t.Fatalf("template %q is missing name or instructions", template.TemplateID)
		}
	}
}

func TestLoadRejectsInvalidTemplates(t *testing.T) {
	valid := map[string]any{
		"template_id":  "helper",
		"name":         "Helper",
		"description":  "Does the work.",
		"instructions": "Do the work.",
		"skill_bindings": []any{
			map[string]any{"name": "superpowers", "skill_id": "simplexai_superpowers", "manifest_version": "1.0.0"},
		},
	}
	cases := []struct {
		name    string
		file    string
		mutate  func(map[string]any)
		wantSub string
	}{
		{name: "id must match file name", file: "builtin/other.json", wantSub: "template_id must equal the file name"},
		{
			name: "name is required", file: "builtin/helper.json",
			mutate:  func(value map[string]any) { value["name"] = "  " },
			wantSub: "name must be 1 to 120 characters",
		},
		{
			name: "instructions are required", file: "builtin/helper.json",
			mutate:  func(value map[string]any) { value["instructions"] = "" },
			wantSub: "instructions must be 1 to 50000 characters",
		},
		{
			name: "skill manifest version must be semantic", file: "builtin/helper.json",
			mutate: func(value map[string]any) {
				value["skill_bindings"] = []any{
					map[string]any{"name": "x", "skill_id": "linger_x", "manifest_version": "latest"},
				}
			},
			wantSub: "skill_bindings[0] is invalid",
		},
		{
			name: "unknown fields are rejected", file: "builtin/helper.json",
			mutate:  func(value map[string]any) { value["runtime"] = "codex" },
			wantSub: "decode built-in Agent template",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			document := map[string]any{}
			for key, value := range valid {
				document[key] = value
			}
			if testCase.mutate != nil {
				testCase.mutate(document)
			}
			encoded, err := json.Marshal(document)
			if err != nil {
				t.Fatalf("encode case: %v", err)
			}
			_, err = loadFromFS(fstest.MapFS{testCase.file: {Data: encoded}})
			if err == nil || !strings.Contains(err.Error(), testCase.wantSub) {
				t.Fatalf("want error containing %q, got %v", testCase.wantSub, err)
			}
		})
	}
}

func TestLoadRejectsDuplicateTemplateIdentity(t *testing.T) {
	document := `{"template_id":"helper","name":"Helper","description":"","instructions":"Work.","skill_bindings":[]}`
	_, err := loadFromFS(fstest.MapFS{
		"builtin/helper.json": {Data: []byte(document)},
		"builtin/other.json":  {Data: []byte(document)},
	})
	if err == nil || !strings.Contains(err.Error(), "template_id must equal the file name") {
		t.Fatalf("want a file-name mismatch error, got %v", err)
	}
}

func TestLoadRequiresAtLeastOneTemplate(t *testing.T) {
	if _, err := loadFromFS(fstest.MapFS{"builtin/README.md": {Data: []byte("notes")}}); err == nil ||
		!strings.Contains(err.Error(), "no built-in Agent template was embedded") {
		t.Fatalf("want an empty-catalog error, got %v", err)
	}
}

func TestLoadEncodesAbsentBindingsAsEmptyArrays(t *testing.T) {
	document := `{"template_id":"helper","name":"Helper","description":"","instructions":"Work."}`
	templates, err := loadFromFS(fstest.MapFS{"builtin/helper.json": {Data: []byte(document)}})
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]any{
		"skill_bindings":     templates[0].SkillBindings,
		"connector_bindings": templates[0].ConnectorBindings,
	} {
		encoded, err := json.Marshal(value)
		if err != nil || string(encoded) != "[]" {
			t.Fatalf("%s encoded as %s (error %v), want []", name, encoded, err)
		}
	}
}
