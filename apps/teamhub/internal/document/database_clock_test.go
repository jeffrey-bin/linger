package document

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestDocumentDatabaseClockSQLRemainsShadowable(t *testing.T) {
	// The exact Document clock and advancing Wiki lease clock both shadow only
	// unqualified clock_timestamp() through the connection search_path. Guard
	// all production Go files in this package so moving SQL cannot evade it.
	// This does not guard the whole database:
	// migrations, already-bound DEFAULTs/triggers, and generated SQL are outside
	// this check. Go time.Now calls and source comments are not SQL literals.
	filenames, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	// Also recognize clock-only fragments used to compose a larger SQL query.
	sqlLiteral := regexp.MustCompile(`(?i)\b(select|insert|update|delete|with|create|alter|set|reset|clock_timestamp|now|current_timestamp|transaction_timestamp|statement_timestamp|localtimestamp|set_config)\b`)
	bypass := regexp.MustCompile(`(?i)\b(?:now|transaction_timestamp|statement_timestamp)\s*\(|\b(?:current_timestamp|localtimestamp)\b|(?:[a-z_][a-z0-9_]*|"[^"]+")\s*\.\s*"?clock_timestamp"?\s*\(|\b(?:set|reset)\s+(?:(?:local|session)\s+)?"?search_path"?\b|\bset_config\s*\(\s*'search_path'`)
	checked := 0
	for _, filename := range filenames {
		if strings.HasSuffix(filename, "_test.go") {
			continue
		}
		// Latest filesystem projection has its own real-time scheduler. Its
		// now() queries are outside the Document/Wiki clock scenarios above.
		if filename == "latest_projection.go" {
			continue
		}
		positions := token.NewFileSet()
		source, err := parser.ParseFile(positions, filename, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(source, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			query, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			if !sqlLiteral.MatchString(query) {
				return true
			}
			checked++
			if matched := bypass.FindString(query); matched != "" {
				t.Errorf("%s: SQL %q bypasses the integration database clock; retain unqualified clock_timestamp() and the connection search_path", positions.Position(literal.Pos()), matched)
			}
			return true
		})
	}
	if checked == 0 {
		t.Fatal("database clock guard did not inspect any SQL literals")
	}
}
