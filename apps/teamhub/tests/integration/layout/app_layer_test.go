package layout_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
)

// The app layer only routes, authenticates, decodes, encodes and maps errors.
// Transactions and data access live in the domain packages under internal/.

// appTaskFiles are the Task and Work Item handlers whose business stays in
// internal/app until the Task and Work Item owners move it.
var appTaskFiles = map[string]bool{
	"contract_server_agent_tasks.go":               true,
	"contract_server_task_runtime_presentation.go": true,
	"contract_server_work_items.go":                true,
	"handlers_agent_task_executions.go":            true,
	"handlers_agent_work_items.go":                 true,
	"handlers_task_execution.go":                   true,
	"handlers_work_item_comments.go":               true,
	"handlers_work_items.go":                       true,
}

// appCompositionRoot reports the files that build the domain services from
// the pool and register the optional features; only they may hold the pool
// or the query set.
func appCompositionRoot(base string) bool {
	return base == "app.go" || strings.HasPrefix(base, "feature")
}

// appTransactionMethods are pgx calls that open a transaction or run SQL.
var appTransactionMethods = map[string]bool{
	"Begin": true, "BeginTx": true, "BeginFunc": true, "BeginTxFunc": true,
	"Exec": true, "QueryRow": true, "SendBatch": true, "CopyFrom": true,
}

func TestAppLayerHoldsNoTransactionsOrQueries(t *testing.T) {
	violations, err := checkAppLayer(os.DirFS("../../../internal/app"))
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("internal/app data access violations:\n%s", strings.Join(violations, "\n"))
	}
}

func TestAppLayerRuleReportsDataAccess(t *testing.T) {
	source := func(body string) *fstest.MapFile {
		return &fstest.MapFile{Data: []byte("package app\n\n" + body)}
	}
	cases := map[string]string{
		"begin":        "func f(a *App) { a.db.Begin(ctx) }\n",
		"exec":         "func f(tx T) { tx.Exec(ctx, `UPDATE x SET y=1`) }\n",
		"query":        "func f(tx T) { tx.Query(ctx, `SELECT 1`) }\n",
		"store new":    "func f(tx T) { _ = store.New(tx) }\n",
		"queries type": "func f(q *store.Queries) {}\n",
		"pgx tx":       "func f(tx pgx.Tx) {}\n",
		"pool field":   "func f(a *App) { _ = a.pool }\n",
		"query field":  "func f(a *App) { _ = a.queries }\n",
	}
	for name, body := range cases {
		violations, err := checkAppLayer(fstest.MapFS{"handlers_x.go": source(body)})
		if err != nil {
			t.Fatal(err)
		}
		if len(violations) != 1 {
			t.Fatalf("%s: violations=%v, want one", name, violations)
		}
	}
	// The composition root may hold the query set but not call it.
	rootCall := fstest.MapFS{"app.go": source("func f(a *App) { a.queries.GetRoom(ctx, id) }\n")}
	if violations, err := checkAppLayer(rootCall); err != nil || len(violations) != 1 {
		t.Fatalf("composition root query call: violations=%v err=%v, want one", violations, err)
	}
	allowed := fstest.MapFS{
		"handlers_x.go":          source("func f(c *gin.Context) { _ = c.Query(\"cursor\"); _ = errors.Is(err, pgx.ErrNoRows) }\n"),
		"app.go":                 source("func f(a *App) { _ = a.pool; _ = a.queries; _ = store.New(a.pool) }\n"),
		"handlers_x_test.go":     source("func f(tx pgx.Tx) { tx.Exec(ctx, `SELECT 1`) }\n"),
		"handlers_work_items.go": source("func f(a *App) { a.pool.Begin(ctx) }\n"),
	}
	violations, err := checkAppLayer(allowed)
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("allowed sources reported: %v", violations)
	}
}

func checkAppLayer(root fs.FS) ([]string, error) {
	var violations []string
	fset := token.NewFileSet()
	err := fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if name != "." {
				return fs.SkipDir
			}
			return nil
		}
		base := path.Base(name)
		if !strings.HasSuffix(base, ".go") || strings.HasSuffix(base, "_test.go") || appTaskFiles[base] {
			return nil
		}
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		file, err := parser.ParseFile(fset, name, data, 0)
		if err != nil {
			return err
		}
		report := func(node ast.Node, rule string) {
			violations = append(violations, fmt.Sprintf("%s: %s", fset.Position(node.Pos()), rule))
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.CallExpr:
				selector, ok := value.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if appTransactionMethods[selector.Sel.Name] || (selector.Sel.Name == "Query" && len(value.Args) >= 2) {
					report(value, "runs SQL or opens a transaction; move it into a domain package")
				}
				if inner, ok := selector.X.(*ast.SelectorExpr); ok && inner.Sel.Name == "queries" {
					report(value, "calls store queries; call a domain package instead")
				}
				if isPackageSelector(selector, "store", "New") && !appCompositionRoot(base) {
					report(value, "builds a store query set; call a domain package instead")
				}
			case *ast.SelectorExpr:
				if appCompositionRoot(base) {
					return true
				}
				if isPackageSelector(value, "store", "Queries") || isPackageSelector(value, "store", "DBTX") {
					report(value, "names store queries; data access belongs in a domain package")
				}
				if isPackageSelector(value, "pgx", "Tx") {
					report(value, "passes a transaction; transactions belong in a domain package")
				}
				if value.Sel.Name == "pool" || value.Sel.Name == "queries" {
					report(value, "reads the database handle outside the composition root")
				}
			}
			return true
		})
		return nil
	})
	sort.Strings(violations)
	return violations, err
}

func isPackageSelector(selector *ast.SelectorExpr, pkg, name string) bool {
	ident, ok := selector.X.(*ast.Ident)
	return ok && ident.Name == pkg && selector.Sel.Name == name
}
