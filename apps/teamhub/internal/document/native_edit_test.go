package document

import (
	"encoding/json"
	"testing"
)

func TestNativeEditValidatesBeforeAdmission(t *testing.T) {
	for _, body := range []string{
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"append","content":"Evidence"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"str_replace","pattern":"Draft","content":""}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"block_delete","start_block_id":"first","end_block_id":"last"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"image_replace","block_id":"picture","asset_id":"document_asset_new"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"image_insert_after","block_id":"first","asset_id":"document_asset_new","caption":"Card"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"file_insert_after","block_id":"first","asset_id":"document_asset_plan","name":"プラン.pdf"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"file_insert_after","block_id":"first","asset_id":"document_asset_plan"}`,
	} {
		if err := validateSemanticOperation(json.RawMessage(body)); err != nil {
			t.Errorf("valid action rejected: %v", err)
		}
	}
	for _, body := range []string{
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"append","content":"Evidence","block_id":"first"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"str_replace","pattern":"a\nb","content":"x"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"block_delete","start_block_id":"first"}`,
		`{"kind":"edit_document","parser_version":"markdown-v2","command":"append","content":"x"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"block_delete","block_id":"0"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"image_replace","block_id":"picture"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"image_replace","block_id":"picture","asset_id":"document_asset_new","content":"x"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"image_insert_after","asset_id":"document_asset_new"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"image_insert_after","block_id":"first","asset_id":"document_asset_new","caption":"a\nb"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"file_insert_after","block_id":"first","asset_id":"document_asset_plan","caption":"x"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"file_insert_after","block_id":"first","asset_id":"document_asset_plan","name":"a\nb"}`,
		`{"kind":"edit_document","parser_version":"markdown-v1","command":"file_insert_after","asset_id":"document_asset_plan"}`,
	} {
		if err := validateSemanticOperation(json.RawMessage(body)); err == nil {
			t.Errorf("invalid action accepted: %s", body)
		}
	}
}

func TestSemanticChangeAssetOnlyNamesASingleImageOrFileEdit(t *testing.T) {
	for body, want := range map[string]struct {
		asset string
		image bool
	}{
		`[{"kind":"edit_document","parser_version":"markdown-v1","command":"image_replace","block_id":"picture","asset_id":"document_asset_new"}]`:    {"document_asset_new", true},
		`[{"kind":"edit_document","parser_version":"markdown-v1","command":"file_insert_after","block_id":"first","asset_id":"document_asset_plan"}]`: {"document_asset_plan", false},
		`[{"kind":"edit_document","parser_version":"markdown-v1","command":"append","content":"x","asset_id":"document_asset_new"}]`:                  {},
		`[{"kind":"set_title","title":"x"}]`: {},
		`not json`:                           {},
	} {
		if asset, image := semanticChangeAsset(json.RawMessage(body)); asset != want.asset || image != want.image {
			t.Errorf("semanticChangeAsset(%s)=%q,%v, want %+v", body, asset, image, want)
		}
	}
}

func TestAgentAssetTypesComeFromTheBytes(t *testing.T) {
	zip := []byte("PK\x03\x04\x14\x00\x00\x00\x08\x00")
	for _, c := range []struct {
		name     string
		contents []byte
		filename string
		want     string
	}{
		{"png", []byte("\x89PNG\r\n\x1a\n0000"), "card.png", "image/png"},
		{"pdf", []byte("%PDF-1.7\n"), "plan.pdf", "application/pdf"},
		{"docx", zip, "プラン.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"zip named pdf stays zip", zip, "fake.pdf", "application/zip"},
		{"csv", []byte("name,amount\nA,1\n"), "costs.csv", "text/csv"},
		{"text named docx stays text", []byte("hello"), "note.docx", "text/plain"},
		{"html", []byte("<html><body>x</body></html>"), "page.html", ""},
		{"binary", []byte{0, 1, 2, 3, 0xff, 0xfe}, "tool.exe", ""},
	} {
		if got := agentAssetMediaType(c.contents, c.filename); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	if got := agentAssetMediaType(append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, MaxAgentImageBytes)...), "huge.png"); got != "" {
		t.Errorf("an image over 10 MiB was accepted as %q", got)
	}
}
