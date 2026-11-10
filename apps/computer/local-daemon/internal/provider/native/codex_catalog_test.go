package native

import (
	"context"
	"strings"
	"testing"
)

func codexCatalogFake(t *testing.T, pages string, modes string) Invocation {
	t.Helper()
	fake := newCodexFake(t, nil, map[string]string{"FAKE_MODEL_PAGES": pages, "FAKE_MODES": modes})
	return NewInvocation(fake.program, nil).WithEnvironment(fake.env)
}

func TestCodexProtocolCatalog(t *testing.T) {
	pages := `[{"data":[{"id":"a","model":"gpt-a","displayName":"A","isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high","description":"deep"}]},{"id":"h","hidden":true}],"nextCursor":"c1"},` +
		`{"data":[{"id":"gpt-b"},{"model":"gpt-a"}],"nextCursor":null}]`
	models, err := discoverCodexProtocolCatalog(context.Background(), codexCatalogFake(t, pages, ""), "0.100.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(models.Models) != 2 || models.Models[0].ID != "gpt-a" || !models.Models[0].Default || models.Models[0].Effort.Default != "high" ||
		models.Models[1].ID != "gpt-b" || models.Models[1].Label != "gpt-b" || models.Models[1].Provider != "openai" {
		t.Fatalf("models = %+v", models)
	}
	for name, tc := range map[string]struct{ pages, want string }{
		"repeated cursor": {`[{"data":[{"id":"a"}],"nextCursor":"c"},{"data":[],"nextCursor":"c"}]`, "Codex catalog pagination did not terminate"},
		"empty":           {`[{"data":[{"id":"h","hidden":true}],"nextCursor":null}]`, "Codex model/list returned no selectable models"},
		"invalid":         {`[{"nope":1}]`, "Codex model/list returned invalid data"},
		"rejected":        {`[]`, "Codex catalog RPC was rejected"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := discoverCodexProtocolCatalog(context.Background(), codexCatalogFake(t, tc.pages, ""), "0.100.0")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestCodexCatalogUsesNativeSelectableModels(t *testing.T) {
	pages := `[{"data":[
  {"id":"gpt-6.1-sol","model":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","isDefault":true},
  {"id":"hidden","hidden":true},
  {"id":"custom-future","model":"custom-future","displayName":"Organization future"}
 ],"nextCursor":"second"},{"data":[{"id":"gpt-6-astra","displayName":"GPT-6-Astra"}],"nextCursor":null}]`
	list, err := DiscoverModels(context.Background(), "codex", codexCatalogFake(t, pages, ""))
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Models) != 3 || list.Models[0].ID != "gpt-6.1-sol" || list.Models[0].Label != "GPT-6.1-Sol" || !list.Models[0].Default || list.Models[1].ID != "custom-future" || list.Models[2].ID != "gpt-6-astra" {
		t.Fatalf("models = %+v", list.Models)
	}
	// An unusable native catalog must not be replaced by bundled models.
	if _, err := DiscoverModels(context.Background(), "codex", codexCatalogFake(t, `[]`, "")); err == nil {
		t.Fatal("rejected native catalog was accepted")
	}
}
