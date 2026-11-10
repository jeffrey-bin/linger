package integration_test

import (
	"net/http"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestAgentTemplateSkillImportListsOnlyTheUnavailableReferenceToThePublisher(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "template-source", "instructions": "Publish me.", "runtime": fixtureRuntime("gpt-5"),
	}, "create-template-source")
	if status != 201 {
		t.Fatalf("create: %d %s", status, body)
	}
	var agent httpapi.TenantAgent
	decode(t, body, &agent)
	archive := makeIntegrationSkillZIP(t, "incident-notes", "Private incident Skill.", false, map[string]string{"references/ci.md": "# CI\n"})
	status, _, body = env.uploadAgentSkillPackage(alice, "/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.Id+"/skill-packages", archive, "skill.zip", "upload-private")
	if status != 201 {
		t.Fatalf("upload: %d %s", status, body)
	}
	var binding httpapi.AgentSkillBinding
	decode(t, body, &binding)
	private := httpapi.AgentSkillRegistration{Name: "incident-notes", SkillId: binding.Skill.SkillId, ManifestVersion: binding.Skill.ManifestVersion}
	missing := httpapi.AgentSkillRegistration{Name: "gone", SkillId: "skill_missing", ManifestVersion: "1.0.0"}
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agent-templates", map[string]any{
		"name": "Incident Template", "instructions": "Investigate.",
		"skill_bindings": []httpapi.AgentSkillRegistration{private, missing},
	}, "publish-template")
	if status != 201 {
		t.Fatalf("publish: %d %s", status, body)
	}
	var template httpapi.AgentTemplate
	decode(t, body, &template)
	importsPath := func(tenantID string) string {
		return "/v0/tenants/" + tenantID + "/agent-templates/" + template.TemplateId + "/skill-imports"
	}
	statuses := func(page httpapi.AgentTemplateSkillImportPage) map[string]httpapi.AgentTemplateSkillImportStatus {
		result := map[string]httpapi.AgentTemplateSkillImportStatus{}
		for _, item := range page.Items {
			result[item.Source.SkillId] = item.Status
		}
		return result
	}

	// The publisher already binds their own Skill; only the dangling reference is listed.
	var page httpapi.AgentTemplateSkillImportPage
	status, _, body = env.request(alice, http.MethodGet, importsPath(acmeTenant), nil, "")
	decode(t, body, &page)
	if got := statuses(page); status != 200 || len(got) != 1 || got["skill_missing"] != httpapi.AgentTemplateSkillImportStatusUnavailable {
		t.Fatalf("publisher preview: %d %+v", status, page)
	}
}
