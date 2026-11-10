package integration_test

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// whitelistPDF assembles a one-page PDF that either draws text or only an
// image, with a correct cross-reference table. It is ASCII, so the fixture
// normalizer can keep it as text.
func whitelistPDF(withText bool) []byte {
	page := "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
	content := "q 200 0 0 200 0 0 cm /Im0 Do Q"
	extra := "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nA\nendstream"
	if withText {
		page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
		content = "BT /F1 12 Tf 20 100 Td (Quarterly plan for the customer pilot) Tj ET"
		extra = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
	}
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		page,
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
		extra,
	}
	var file bytes.Buffer
	file.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for index, object := range objects {
		offsets[index] = file.Len()
		fmt.Fprintf(&file, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	start := file.Len()
	fmt.Fprintf(&file, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&file, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&file, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, start)
	return file.Bytes()
}

// The Wiki reads prose and PDFs with a text layer, however short, and a text
// over one source budget when no line of it is, so a transcript without
// headings still enters. Everything else stays out with its reason, and
// search still reads it.
func TestWikiSourceWhitelistAdmitsAndSkipsWithReasons(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	_, pool := newUnifiedWikiFixture(t, `
		UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'`)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(context.Context, document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
		return document.ExportRuntimeResult{}, fmt.Errorf("no native Documents here")
	}}, objects)
	upload := func(name, format, media string, content []byte) string {
		t.Helper()
		value, err := service.Upload(ctx, document.UploadDocumentInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "whitelist-" + name,
			Filename: name, RepresentationFormat: format, MediaType: media, Content: bytes.NewReader(content),
		})
		if err != nil {
			t.Fatal(err)
		}
		return value.Document.ID
	}
	// 3,000 turns of 57 bytes: over the 144,000-byte budget, with no heading.
	transcript := strings.Repeat("Speaker 1: the pilot plan keeps every open item visible.\n", 3000)
	admitted := map[string]string{
		"notes":      upload("notes.txt", "plain_text", "text/plain", []byte("# Notes\n\nThe pilot plan keeps every open item visible.\n")),
		"short":      upload("short.txt", "plain_text", "text/plain", []byte("Only a line.")),
		"transcript": upload("transcript.txt", "plain_text", "text/plain", []byte(transcript)),
		"report":     upload("report.pdf", "pdf", "application/pdf", whitelistPDF(true)),
	}
	skipped := map[string]string{
		upload("empty.txt", "plain_text", "text/plain", []byte{}):                                              "no_text",
		upload("data.csv", "csv", "text/csv", []byte("team,owner\n"+strings.Repeat("pilot,alice\n", 40))):      "unsupported_type",
		upload("script.py", "code", "text/plain", []byte(strings.Repeat("print('the quarterly plan')\n", 20))): "unsupported_type",
		upload("photo.png", "png", "image/png", []byte("Recognized screenshot words")):                         "unsupported_type",
		upload("flat.txt", "plain_text", "text/plain", []byte(strings.Repeat("x", 150000))):                    "too_large",
		upload("scan.pdf", "pdf", "application/pdf", whitelistPDF(false)):                                      "scanned",
	}
	// Imported mail is admitted as well.
	mail, err := service.UpsertMailWikiSource(ctx, document.UpsertWikiSourceInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", SourceKey: "mail:connection:message:short",
		Filename: "gmail-message-short.md", Content: []byte("# Re: pilot\n\nYes, Friday works.\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	admitted["mail"] = mail.DocumentID
	readyDocumentTexts(t, pool, objects, service)

	refresh, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "whitelist-refresh",
	})
	if err != nil || refresh.Status != document.WikiRefreshAccepted {
		t.Fatalf("refresh=%+v err=%v", refresh, err)
	}
	rows, err := pool.Query(ctx, `SELECT document_id FROM document_wiki_refresh_sources WHERE refresh_id=$1 ORDER BY document_id`, refresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	frozen := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		frozen[id] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for name, id := range admitted {
		if !frozen[id] {
			t.Errorf("%s was not admitted; frozen=%v", name, frozen)
		}
	}
	if len(frozen) != len(admitted) {
		t.Fatalf("frozen %d sources, want %d: %v", len(frozen), len(admitted), frozen)
	}

	rows, err = pool.Query(ctx, `SELECT document_id, reason, source FROM wiki_document_verdicts
		WHERE tenant_id='tenant_document_a' AND reason IS NOT NULL`)
	if err != nil {
		t.Fatal(err)
	}
	listed := 0
	for rows.Next() {
		var id, reason, source string
		if err := rows.Scan(&id, &reason, &source); err != nil {
			t.Fatal(err)
		}
		listed++
		if skipped[id] != reason || source != "my_pages" {
			t.Errorf("verdict %s=%q from %s, want reason %q", id, reason, source, skipped[id])
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if listed != len(skipped) {
		t.Fatalf("whitelist kept out %d sources, want %d", listed, len(skipped))
	}
	// Search and Memory still read every text the Wiki leaves out; the empty
	// file has none.
	var withText []string
	for id, reason := range skipped {
		if reason != "no_text" {
			withText = append(withText, id)
		}
	}
	var searchable int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM memory_source.personal_documents('tenant_document_a','actor_human_a')
		WHERE document_id = ANY($1)`, withText).Scan(&searchable); err != nil || searchable != len(withText) {
		t.Fatalf("searchable skipped sources=%d want %d err=%v", searchable, len(withText), err)
	}
}
