package personalprofile

import (
	"embed"
	"strings"
)

//go:embed prompts/*.md skill
var promptFS embed.FS

func promptFile(name string) string {
	raw, err := promptFS.ReadFile("prompts/" + name)
	if err != nil {
		panic("missing prompt file prompts/" + name + ": " + err.Error())
	}
	return strings.TrimSpace(string(raw))
}

func UserProfileSystemPrompt(version string) string {
	entries, err := promptFS.ReadDir("skill/personal-profile/references")
	if err != nil {
		panic(err)
	}
	main, err := promptFS.ReadFile("skill/personal-profile/SKILL.md")
	if err != nil {
		panic(err)
	}
	parts := []string{"Prompt version: " + version, string(main)}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		name := "references/" + entry.Name()
		body, readErr := promptFS.ReadFile("skill/personal-profile/" + name)
		if readErr != nil {
			panic(readErr)
		}
		parts = append(parts, "<skill-reference path=\""+name+"\">\n"+string(body)+"\n</skill-reference>")
	}
	parts = append(parts, promptFile("user-profile-adapter.md"))
	return strings.Join(parts, "\n\n")
}
