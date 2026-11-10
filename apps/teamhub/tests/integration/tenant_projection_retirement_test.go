package integration_test

import (
	"testing"
)

// Migrations 00428 and 00468 remove the Tenant and Human file projections. Prove
// on the migrated clone that neither their tables nor their trigger functions remain.
func TestProjectionRetirementRemovesFileProjectionObjects(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	var retiredTables int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM unnest(ARRAY['tenant_file_projections','tenant_projection_changes','document_projection_filenames','human_file_projections','projection_file_entries','projection_file_change_wakes']) AS name WHERE to_regclass('public.'||name) IS NOT NULL`).Scan(&retiredTables); err != nil {
		t.Fatal(err)
	}
	if retiredTables != 0 {
		t.Fatalf("%d retired file projection tables remain", retiredTables)
	}
	var remaining int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND (p.prosrc LIKE '%tenant_file_projections%' OR p.prosrc LIKE '%tenant_room%' OR p.prosrc LIKE '%document_projection_filenames%' OR p.prosrc LIKE '%human_file_projections%' OR p.prosrc LIKE '%projection_file_%' OR p.proname IN ('advance_document_file_projections','advance_human_file_projection','initialize_human_file_projection','valid_projection_source_inbox_ids') OR p.proname LIKE 'advance_human_file_projection%')`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("%d functions retain retired file projection state", remaining)
	}
	var triggers int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%file_projection%'`).Scan(&triggers); err != nil {
		t.Fatal(err)
	}
	if triggers != 0 {
		t.Fatalf("%d file projection triggers remain", triggers)
	}
	var tasks int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM work_items`).Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if tasks == 0 {
		t.Fatal("the business fixture must survive the projection retirement")
	}
}
