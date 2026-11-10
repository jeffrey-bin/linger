package layout_test

import (
	"fmt"
	"go/ast"
	"go/build/constraint"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The layout rules are structural: they keep the shard runner's concurrency
// model honest without counting tests or lines. Each violation names file:line
// and the rule it breaks.

const (
	helperFileName       = "parallel_integration_test.go"
	databaseFileName     = "database_test.go"
	layoutDirName        = "layout"
	migrationHistoryTag  = "integration_migration_history"
	specializedTagPrefix = "integration_"
	reasonTypeName       = "serialIntegrationReason"
	allowParallelMarker  = "allowParallelIntegrationTest"
	serialMarker         = "serialIntegrationTest"
)

// migrationHistoryHelpers may only be used by files tagged integration_migration_history
// (and database_test.go, which defines them).
var migrationHistoryHelpers = map[string]bool{
	"newEmptyDatabase":       true,
	"newMigratedDatabase":    true,
	"openUnmigratedDatabase": true,
}

var gooseRunners = map[string]bool{
	"Up":            true,
	"UpTo":          true,
	"DownTo":        true,
	"UpContext":     true,
	"UpToContext":   true,
	"DownToContext": true,
}

// processGlobalSelectors lists package-qualified calls that mutate process state
// and therefore require a serial marker.
var processGlobalSelectors = map[string]string{
	"t.Setenv":           "process-global environment",
	"os.Setenv":          "process-global environment",
	"os.Unsetenv":        "process-global environment",
	"os.Chdir":           "process-global environment",
	"slog.SetDefault":    "process-global logger",
	"runtime.GOMAXPROCS": "process-global GOMAXPROCS",
}

// sharedQualifiers name packages or values whose every use is process-wide.
var sharedQualifiers = map[string]string{
	"integrationDatabaseSuite": "shared suite lifecycle",
}

var sharedIdentifiers = map[string]string{
	"integrationSkillArtifactRoot":       "shared Skill artifact root",
	"ensureIntegrationSkillArtifactRoot": "shared Skill artifact root",
}

var fixedPortAddress = regexp.MustCompile(`^(127\.0\.0\.1|localhost|\[::1\])?:0$`)

type source struct {
	name string
	fset *token.FileSet
	file *ast.File
	tags []string
}

type summary struct {
	files         int
	parallelTests int
	serialTests   int
}

// checkLayout scans every .go file under root except the layout package itself and
// returns violations in walk order. root is the tests/integration directory.
func checkLayout(root fs.FS) (summary, []string, error) {
	sources, err := loadSources(root)
	if err != nil {
		return summary{}, nil, err
	}
	reasons, err := serialReasons(sources)
	if err != nil {
		return summary{}, nil, err
	}
	c := &layoutChecker{reasons: reasons}
	for _, src := range sources {
		c.checkFile(src)
	}
	return summary{files: len(sources), parallelTests: c.parallelTests, serialTests: c.serialTests}, c.violations, nil
}

func loadSources(root fs.FS) ([]source, error) {
	var sources []source
	err := fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if name == layoutDirName {
				return fs.SkipDir
			}
			return nil
		}
		if path.Ext(name) != ".go" {
			return nil
		}
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, name, data, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("parse %s: %w", name, err)
		}
		tags, err := buildTags(file)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		sources = append(sources, source{name: name, fset: fset, file: file, tags: tags})
		return nil
	})
	return sources, err
}

// buildTags returns the tags of //go:build lines in the file header, the only
// place the go command honours them.
func buildTags(file *ast.File) ([]string, error) {
	var tags []string
	for _, group := range file.Comments {
		if group.Pos() >= file.Package {
			break
		}
		for _, comment := range group.List {
			if !constraint.IsGoBuild(comment.Text) {
				continue
			}
			expr, err := constraint.Parse(comment.Text)
			if err != nil {
				return nil, err
			}
			tags = appendTags(tags, expr)
		}
	}
	return tags, nil
}

func appendTags(tags []string, expr constraint.Expr) []string {
	switch e := expr.(type) {
	case *constraint.TagExpr:
		return append(tags, e.Tag)
	case *constraint.NotExpr:
		return appendTags(tags, e.X)
	case *constraint.AndExpr:
		return appendTags(appendTags(tags, e.X), e.Y)
	case *constraint.OrExpr:
		return appendTags(appendTags(tags, e.X), e.Y)
	}
	return tags
}

func hasTag(tags []string, want string) bool {
	for _, tag := range tags {
		if tag == want {
			return true
		}
	}
	return false
}

// specialized files run only under their own build tag and are outside the default suite.
func specialized(tags []string) bool {
	for _, tag := range tags {
		if strings.HasPrefix(tag, specializedTagPrefix) {
			return true
		}
	}
	return false
}

// serialReasons returns the names of the serialIntegrationReason constants declared
// in the shared helper file.
func serialReasons(sources []source) (map[string]bool, error) {
	reasons := map[string]bool{}
	for _, src := range sources {
		if src.name != helperFileName {
			continue
		}
		for _, decl := range src.file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				value := spec.(*ast.ValueSpec)
				typ, ok := value.Type.(*ast.Ident)
				if !ok || typ.Name != reasonTypeName {
					continue
				}
				for _, name := range value.Names {
					reasons[name.Name] = true
				}
			}
		}
	}
	if len(reasons) == 0 {
		return nil, fmt.Errorf("%s declares no %s constants", helperFileName, reasonTypeName)
	}
	return reasons, nil
}

type layoutChecker struct {
	reasons       map[string]bool
	violations    []string
	parallelTests int
	serialTests   int
}

func (c *layoutChecker) fail(src source, pos token.Pos, format string, args ...any) {
	line := src.fset.Position(pos).Line
	c.violations = append(c.violations, fmt.Sprintf("%s:%d: %s", src.name, line, fmt.Sprintf(format, args...)))
}

func (c *layoutChecker) checkFile(src source) {
	c.checkMigrationHelpers(src)
	c.checkCalls(src)
	if specialized(src.tags) {
		return
	}
	// Markers and body rules apply to the main package's direct files only. The
	// documents package has its own TestMain and database suite.
	if strings.Contains(src.name, "/") {
		return
	}
	for _, decl := range src.file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || !isTestName(fn.Name.Name) || !isTestFunc(fn) {
			continue
		}
		c.checkMarker(src, fn)
	}
}

// checkMigrationHelpers keeps migration-history database helpers and goose runners out
// of every file that is not the database lifecycle or an integration_migration_history suite.
func (c *layoutChecker) checkMigrationHelpers(src source) {
	if src.name == databaseFileName || hasTag(src.tags, migrationHistoryTag) {
		return
	}
	ast.Inspect(src.file, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.Ident:
			if migrationHistoryHelpers[n.Name] {
				c.fail(src, n.Pos(), "only integration_migration_history may use %s", n.Name)
			}
		case *ast.SelectorExpr:
			if isGooseRunner(n) {
				c.fail(src, n.Pos(), "only integration_migration_history may use goose migration")
			}
		}
		return true
	})
}

// checkCalls enforces the rules that apply to every integration file: no raw
// t.Parallel outside the helper, and no top-level Test function invoked from another test.
func (c *layoutChecker) checkCalls(src source) {
	ast.Inspect(src.file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fn := call.Fun.(type) {
		case *ast.SelectorExpr:
			if fn.Sel.Name == "Parallel" && src.name != helperFileName {
				c.fail(src, call.Pos(), "raw t.Parallel is forbidden; use %s(t)", allowParallelMarker)
			}
			if fn.Sel.Name == "Run" && len(call.Args) > 0 {
				if last, ok := call.Args[len(call.Args)-1].(*ast.Ident); ok && isTestName(last.Name) {
					c.fail(src, call.Pos(), "integration tests must not invoke other top-level Test functions: %s", last.Name)
				}
			}
		case *ast.Ident:
			if isTestName(fn.Name) {
				c.fail(src, call.Pos(), "integration tests must not invoke other top-level Test functions: %s", fn.Name)
			}
		}
		return true
	})
}

// checkMarker requires the first statement of every default top-level test to be
// exactly one marker, and applies the body rules to parallel tests.
func (c *layoutChecker) checkMarker(src source, fn *ast.FuncDecl) {
	if fn.Body == nil {
		return
	}
	markers := 0
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok && isMarkerCall(call) {
			markers++
		}
		return true
	})
	var first *ast.CallExpr
	if len(fn.Body.List) > 0 {
		if stmt, ok := fn.Body.List[0].(*ast.ExprStmt); ok {
			first, _ = stmt.X.(*ast.CallExpr)
		}
	}
	if markers != 1 || first == nil || !isMarkerCall(first) {
		c.fail(src, fn.Pos(), "%s must start with exactly one parallel or serial marker", fn.Name.Name)
		return
	}
	if first.Fun.(*ast.Ident).Name == allowParallelMarker {
		c.parallelTests++
		c.checkParallelBody(src, fn)
		return
	}
	reason := first.Args[1].(*ast.Ident).Name
	if !c.reasons[reason] {
		c.fail(src, fn.Pos(), "%s uses unknown serial reason %s", fn.Name.Name, reason)
		return
	}
	c.serialTests++
}

// checkParallelBody rejects process-global state, shared fixtures and fixed listeners
// in a test that may run beside other tests.
func (c *layoutChecker) checkParallelBody(src source, fn *ast.FuncDecl) {
	name := fn.Name.Name
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.SelectorExpr:
			qualifier, ok := n.X.(*ast.Ident)
			if !ok {
				return true
			}
			key := qualifier.Name + "." + n.Sel.Name
			if label, ok := processGlobalSelectors[key]; ok {
				c.fail(src, n.Pos(), "%s uses serial-only %s", name, label)
			} else if label, ok := sharedQualifiers[qualifier.Name]; ok {
				c.fail(src, n.Pos(), "%s uses serial-only %s", name, label)
			}
		case *ast.Ident:
			if label, ok := sharedIdentifiers[n.Name]; ok {
				c.fail(src, n.Pos(), "%s uses serial-only %s", name, label)
			}
			if migrationHistoryHelpers[n.Name] {
				c.fail(src, n.Pos(), "%s uses serial-only migration-history database", name)
			}
		case *ast.CallExpr:
			if isGooseRunnerCall(n) {
				c.fail(src, n.Pos(), "%s uses serial-only direct migration runner", name)
			}
			if isListenCall(n) && !listensOnEphemeralPort(n) {
				c.fail(src, n.Pos(), "%s listens on a fixed port", name)
			}
		}
		return true
	})
}

func isMarkerCall(call *ast.CallExpr) bool {
	fn, ok := call.Fun.(*ast.Ident)
	if !ok {
		return false
	}
	switch fn.Name {
	case allowParallelMarker:
		return len(call.Args) == 1 && isIdent(call.Args[0], "t")
	case serialMarker:
		if len(call.Args) != 2 || !isIdent(call.Args[0], "t") {
			return false
		}
		_, ok := call.Args[1].(*ast.Ident)
		return ok
	}
	return false
}

func isIdent(expr ast.Expr, name string) bool {
	ident, ok := expr.(*ast.Ident)
	return ok && ident.Name == name
}

func isGooseRunner(sel *ast.SelectorExpr) bool {
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "goose" && gooseRunners[sel.Sel.Name]
}

func isGooseRunnerCall(call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	return ok && isGooseRunner(sel)
}

func isListenCall(call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || !isIdent(sel.X, "net") {
		return false
	}
	switch sel.Sel.Name {
	case "Listen", "ListenTCP", "ListenPacket":
		return len(call.Args) == 2
	}
	return false
}

// listensOnEphemeralPort accepts only literal loopback or wildcard addresses with port 0.
// Any other address, including a variable, is treated as a fixed port.
func listensOnEphemeralPort(call *ast.CallExpr) bool {
	lit, ok := call.Args[1].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return false
	}
	address, err := strconv.Unquote(lit.Value)
	return err == nil && fixedPortAddress.MatchString(address)
}

// isTestName follows the go test rule: Test followed by a non-lowercase rune.
func isTestName(name string) bool {
	rest, ok := strings.CutPrefix(name, "Test")
	if !ok {
		return false
	}
	if rest == "" {
		return true
	}
	r, _ := utf8.DecodeRuneInString(rest)
	return !unicode.IsLower(r)
}

// isTestFunc reports whether fn has the signature func(t *testing.T).
func isTestFunc(fn *ast.FuncDecl) bool {
	if fn.Type.Params == nil || len(fn.Type.Params.List) != 1 || fn.Type.Results != nil {
		return false
	}
	star, ok := fn.Type.Params.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	return ok && isIdent(sel.X, "testing") && sel.Sel.Name == "T"
}
