// Package agenttemplates reconciles the Agent templates shipped with the
// deployment into TeamHub. Persistence and lifecycle policy stay with TeamHub;
// this package only owns the embedded asset format and its validation.
package agenttemplates

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

//go:embed all:builtin
var builtinFS embed.FS

const builtinDirectory = "builtin"

var (
	templateIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	identifierPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)
	manifestVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$`)
	avatarKeyPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$`)
	externalAppKeyPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,119}$`)
	catalogOnce            sync.Once
	catalogValue           []Template
	catalogErr             error
)

// Template is one embedded built-in definition. It mirrors the published
// contract so a template exported from a running Agent can be shipped here
// without reshaping it.
type Template struct {
	TemplateID    string                           `json:"template_id"`
	Name          string                           `json:"name"`
	Description   string                           `json:"description"`
	Instructions  string                           `json:"instructions"`
	AvatarKey     string                           `json:"avatar_key"`
	SkillBindings []httpapi.AgentSkillRegistration `json:"skill_bindings"`
	// Connected App keys the consumer is asked to authorize. A built-in
	// template names Apps only; it never carries anyone's connection.
	ConnectorBindings []httpapi.ExternalAppKey   `json:"connector_bindings"`
	Routines          []reminder.TemplateRoutine `json:"routines"`
}

// Builtin returns every embedded template in stable template_id order.
func Builtin() ([]Template, error) {
	catalogOnce.Do(func() {
		catalogValue, catalogErr = loadFromFS(builtinFS)
	})
	return catalogValue, catalogErr
}

func loadFromFS(source fs.FS) ([]Template, error) {
	entries, err := fs.ReadDir(source, builtinDirectory)
	if err != nil {
		return nil, fmt.Errorf("read built-in Agent template directory: %w", err)
	}
	templates := make([]Template, 0, len(entries))
	seen := map[string]struct{}{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, err := fs.ReadFile(source, path.Join(builtinDirectory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read built-in Agent template %s: %w", entry.Name(), err)
		}
		decoder := json.NewDecoder(strings.NewReader(string(content)))
		decoder.DisallowUnknownFields()
		var template Template
		if err := decoder.Decode(&template); err != nil {
			return nil, fmt.Errorf("decode built-in Agent template %s: %w", entry.Name(), err)
		}
		if err := validate(&template, entry.Name()); err != nil {
			return nil, err
		}
		if _, duplicate := seen[template.TemplateID]; duplicate {
			return nil, fmt.Errorf("built-in Agent template %s repeats template_id %q", entry.Name(), template.TemplateID)
		}
		seen[template.TemplateID] = struct{}{}
		templates = append(templates, template)
	}
	if len(templates) == 0 {
		return nil, fmt.Errorf("no built-in Agent template was embedded")
	}
	sort.Slice(templates, func(left, right int) bool {
		return templates[left].TemplateID < templates[right].TemplateID
	})
	return templates, nil
}

func validate(template *Template, file string) error {
	fail := func(reason string) error {
		return fmt.Errorf("built-in Agent template %s: %s", file, reason)
	}
	template.Name = strings.TrimSpace(template.Name)
	template.Instructions = strings.TrimSpace(template.Instructions)
	switch {
	case !templateIDPattern.MatchString(template.TemplateID):
		return fail("template_id is not a valid identifier")
	case strings.TrimSuffix(file, ".json") != template.TemplateID:
		return fail("template_id must equal the file name")
	case template.Name == "" || len([]rune(template.Name)) > 120:
		return fail("name must be 1 to 120 characters")
	case len([]rune(template.Description)) > 1000:
		return fail("description exceeds 1000 characters")
	case template.Instructions == "" || len(template.Instructions) > 50000:
		return fail("instructions must be 1 to 50000 characters")
	case template.AvatarKey != "" && !avatarKeyPattern.MatchString(template.AvatarKey):
		return fail("avatar_key is not a valid avatar selection")
	case len(template.SkillBindings) > 100:
		return fail("skill_bindings exceeds 100 entries")
	case len(template.ConnectorBindings) > 20:
		return fail("connector_bindings exceeds 20 entries")
	}
	if err := reminder.ValidateTemplateRoutines(template.Routines); err != nil {
		return fail(fmt.Sprintf("routines: %v", err))
	}
	if template.Routines == nil {
		template.Routines = []reminder.TemplateRoutine{}
	}
	if template.SkillBindings == nil {
		template.SkillBindings = []httpapi.AgentSkillRegistration{}
	}
	if template.ConnectorBindings == nil {
		template.ConnectorBindings = []httpapi.ExternalAppKey{}
	}
	seenConnectors := map[httpapi.ExternalAppKey]struct{}{}
	for index, key := range template.ConnectorBindings {
		if !externalAppKeyPattern.MatchString(key) {
			return fail(fmt.Sprintf("connector_bindings[%d] is not a valid App key", index))
		}
		if _, duplicate := seenConnectors[key]; duplicate {
			return fail(fmt.Sprintf("connector_bindings repeats App key %q", key))
		}
		seenConnectors[key] = struct{}{}
	}
	seenSkills := map[string]struct{}{}
	for index := range template.SkillBindings {
		skill := &template.SkillBindings[index]
		skill.Name = strings.TrimSpace(skill.Name)
		if skill.Name == "" || !identifierPattern.MatchString(skill.SkillId) ||
			!manifestVersionPattern.MatchString(skill.ManifestVersion) {
			return fail(fmt.Sprintf("skill_bindings[%d] is invalid", index))
		}
		if _, duplicate := seenSkills[skill.SkillId]; duplicate {
			return fail(fmt.Sprintf("skill_bindings repeats skill_id %q", skill.SkillId))
		}
		seenSkills[skill.SkillId] = struct{}{}
	}
	return nil
}
