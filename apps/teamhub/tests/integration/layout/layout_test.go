package layout_test

import (
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

// TestIntegrationLayoutRealTree enforces the layout rules on the checked-in
// tests/integration tree. The package directory is tests/integration/layout.
func TestIntegrationLayoutRealTree(t *testing.T) {
	summary, violations, err := checkLayout(os.DirFS(".."))
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("integration layout violations:\n%s", strings.Join(violations, "\n"))
	}
	if summary.parallelTests == 0 || summary.serialTests == 0 {
		t.Fatalf("layout scan found no markers: %+v", summary)
	}
}

const helperSource = `package integration_test

import "testing"

type serialIntegrationReason string

const (
	serialProcessEnv     serialIntegrationReason = "processEnv"
	serialWallClockBound serialIntegrationReason = "wallClockBound"
)

func allowParallelIntegrationTest(t *testing.T) {
	t.Parallel()
}

func serialIntegrationTest(t *testing.T, reason serialIntegrationReason) {}
`

// baseDecls are the top-level tests of the synthetic core_test.go fixture. The
// file header occupies lines 1-4, so the first declaration starts at line 5.
const baseDecls = `func TestAlphaParallel(t *testing.T) {
	allowParallelIntegrationTest(t)
}

func TestBetaSerial(t *testing.T) {
	serialIntegrationTest(t, serialProcessEnv)
}
`

// coreFile wraps declarations in a core_test.go header that imports only testing.
func coreFile(pkg, decls string) string {
	return "package " + pkg + "\n\nimport \"testing\"\n\n" + decls
}

type layoutRuleCase struct {
	name  string
	decls string
	// files adds or replaces fixture files besides helper and core_test.go.
	files map[string]string
	// want is a substring of the expected violation; empty means the fixture must pass.
	want string
}

var layoutRuleCases = []layoutRuleCase{
	{name: "marked parallel and serial tests pass", decls: baseDecls},
	{
		name:  "missing marker reports file, line and rule",
		decls: "func TestMissing(t *testing.T) {\n\t_ = t\n}\n",
		want:  "core_test.go:5: TestMissing must start with exactly one parallel or serial marker",
	},
	{
		name: "two markers fail",
		decls: `func TestTwo(t *testing.T) {
	allowParallelIntegrationTest(t)
	serialIntegrationTest(t, serialProcessEnv)
}
`,
		want: "TestTwo must start with exactly one parallel or serial marker",
	},
	{
		name: "marker after another statement fails",
		decls: `func TestLate(t *testing.T) {
	_ = t
	allowParallelIntegrationTest(t)
}
`,
		want: "TestLate must start with exactly one parallel or serial marker",
	},
	{
		name: "unknown serial reason fails",
		decls: `func TestUnknown(t *testing.T) {
	serialIntegrationTest(t, serialMadeUp)
}
`,
		want: "TestUnknown uses unknown serial reason serialMadeUp",
	},
	{
		name: "raw t.Parallel fails",
		decls: `func TestRaw(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Parallel()
}
`,
		want: "raw t.Parallel is forbidden",
	},
	{
		name: "parallel test with t.Setenv fails",
		decls: `func TestEnv(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Setenv("TEAMHUB_FIXTURE", "1")
}
`,
		want: "TestEnv uses serial-only process-global environment",
	},
	{
		name: "parallel test with slog.SetDefault fails",
		decls: `func TestLogger(t *testing.T) {
	allowParallelIntegrationTest(t)
	slog.SetDefault(nil)
}
`,
		want: "TestLogger uses serial-only process-global logger",
	},
	{
		name: "parallel test with the shared Skill artifact root fails",
		decls: `func TestSkillRoot(t *testing.T) {
	allowParallelIntegrationTest(t)
	_ = integrationSkillArtifactRoot()
}
`,
		want: "TestSkillRoot uses serial-only shared Skill artifact root",
	},
	{
		name: "parallel test with the shared database suite fails",
		decls: `func TestSuite(t *testing.T) {
	allowParallelIntegrationTest(t)
	_ = integrationDatabaseSuite.Pool(t)
}
`,
		want: "TestSuite uses serial-only shared suite lifecycle",
	},
	{
		name: "parallel test with a migration-history database fails",
		decls: `func TestHistoryDB(t *testing.T) {
	allowParallelIntegrationTest(t)
	_ = newEmptyDatabase(t)
}
`,
		want: "TestHistoryDB uses serial-only migration-history database",
	},
	{
		name: "parallel test with a goose runner fails",
		decls: `func TestGoose(t *testing.T) {
	allowParallelIntegrationTest(t)
	_ = goose.Up(nil, "migrations")
}
`,
		want: "TestGoose uses serial-only direct migration runner",
	},
	{
		name: "parallel test with a per-test artifact root passes",
		decls: `func TestArtifactRoot(t *testing.T) {
	allowParallelIntegrationTest(t)
	_ = integrationArtifactRoot(t)
}
`,
	},
	{
		name: "port-zero listener passes in a parallel test",
		decls: `func TestEphemeral(t *testing.T) {
	allowParallelIntegrationTest(t)
	listener, _ := net.Listen("tcp", "127.0.0.1:0")
	_ = listener
}
`,
	},
	{
		name: "fixed-port listener fails in a parallel test",
		decls: `func TestFixed(t *testing.T) {
	allowParallelIntegrationTest(t)
	listener, _ := net.Listen("tcp", "127.0.0.1:8080")
	_ = listener
}
`,
		want: "TestFixed listens on a fixed port",
	},
	{
		name: "listener with a non-literal address fails in a parallel test",
		decls: `func TestVariableAddress(t *testing.T) {
	allowParallelIntegrationTest(t)
	listener, _ := net.Listen("tcp", addr)
	_ = listener
}
`,
		want: "TestVariableAddress listens on a fixed port",
	},
	{
		name:  "parallel lock-order test with database-scoped introspection passes",
		decls: "func TestXLockOrderConcurrent(t *testing.T) {\n\tallowParallelIntegrationTest(t)\n\t_ = `select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()`\n}\n",
	},
	{
		name: "serial test may mutate process state",
		decls: `func TestSerialEnv(t *testing.T) {
	serialIntegrationTest(t, serialProcessEnv)
	t.Setenv("TEAMHUB_FIXTURE", "1")
}
`,
	},
	{
		name: "top-level test calling another top-level test fails",
		decls: baseDecls + `
func TestCaller(t *testing.T) {
	allowParallelIntegrationTest(t)
	TestBetaSerial(t)
}
`,
		want: "integration tests must not invoke other top-level Test functions: TestBetaSerial",
	},
	{
		name: "t.Run with a top-level test value fails",
		decls: baseDecls + `
func TestRunner(t *testing.T) {
	serialIntegrationTest(t, serialProcessEnv)
	t.Run("nested", TestBetaSerial)
}
`,
		want: "integration tests must not invoke other top-level Test functions: TestBetaSerial",
	},
	{
		name: "migration-history helper in a default file fails",
		decls: `func TestMigrationDefault(t *testing.T) {
	serialIntegrationTest(t, serialProcessEnv)
	_ = newMigratedDatabase(t)
}
`,
		want: "core_test.go:7: only integration_migration_history may use newMigratedDatabase",
	},
	{
		name: "goose runner in a default file fails",
		decls: `func TestGooseDefault(t *testing.T) {
	serialIntegrationTest(t, serialProcessEnv)
	_ = goose.UpTo(nil, "migrations", 3)
}
`,
		want: "only integration_migration_history may use goose migration",
	},
	{
		name:  "migration-history file may use migration helpers",
		decls: baseDecls,
		files: map[string]string{
			"history_test.go": "//go:build integration_migration_history\n\npackage integration_test\n\nimport \"testing\"\n\nfunc TestHistory(t *testing.T) {\n\t_ = newEmptyDatabase(t)\n}\n",
		},
	},
	{
		name:  "integration_process test needs no marker",
		decls: baseDecls,
		files: map[string]string{
			"process_test.go": "//go:build integration_process\n\npackage integration_test\n\nimport \"testing\"\n\nfunc TestProcess(t *testing.T) {\n\tt.Setenv(\"TEAMHUB_FIXTURE\", \"1\")\n}\n",
		},
	},
	{
		name:  "documents subpackage passes without markers",
		decls: baseDecls,
		files: map[string]string{
			"documents/doc_test.go": "package documents_test\n\nimport \"testing\"\n\nfunc TestDocument(t *testing.T) {\n\t_ = t\n}\n",
		},
	},
	{
		name:  "documents subpackage still forbids raw t.Parallel",
		decls: baseDecls,
		files: map[string]string{
			"documents/doc_test.go": "package documents_test\n\nimport \"testing\"\n\nfunc TestDocument(t *testing.T) {\n\tt.Parallel()\n}\n",
		},
		want: "documents/doc_test.go:6: raw t.Parallel is forbidden",
	},
	{
		name:  "layout package itself is not scanned",
		decls: baseDecls,
		files: map[string]string{
			"layout/self_test.go": "package layout_test\n\nimport \"testing\"\n\nfunc TestSelf(t *testing.T) {\n\tt.Parallel()\n\t_ = newEmptyDatabase\n}\n",
		},
	},
}

func TestIntegrationLayoutRules(t *testing.T) {
	for _, tc := range layoutRuleCases {
		t.Run(tc.name, func(t *testing.T) {
			fixture := fstest.MapFS{
				"parallel_integration_test.go": {Data: []byte(helperSource)},
				"core_test.go":                 {Data: []byte(coreFile("integration_test", tc.decls))},
			}
			for name, content := range tc.files {
				fixture[name] = &fstest.MapFile{Data: []byte(content)}
			}
			_, violations, err := checkLayout(fixture)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "" {
				if len(violations) > 0 {
					t.Fatalf("expected no violations, got:\n%s", strings.Join(violations, "\n"))
				}
				return
			}
			for _, violation := range violations {
				if strings.Contains(violation, tc.want) {
					return
				}
			}
			t.Fatalf("no violation contains %q; got:\n%s", tc.want, strings.Join(violations, "\n"))
		})
	}
}

func TestIntegrationLayoutRequiresReasonConstants(t *testing.T) {
	fixture := fstest.MapFS{
		"core_test.go": {Data: []byte(coreFile("integration_test", baseDecls))},
	}
	if _, _, err := checkLayout(fixture); err == nil || !strings.Contains(err.Error(), "declares no serialIntegrationReason constants") {
		t.Fatalf("missing reason constants: got error %v", err)
	}
}
