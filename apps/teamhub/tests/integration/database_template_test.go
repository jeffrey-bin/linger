package integration_test

import (
	"bytes"
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/tests/testsupport/database"
)

func TestDatabaseTemplateIsPreparedOnceAndRejectsConnections(t *testing.T) {
	serialIntegrationTest(t, serialSuiteMeta)
	requireTestDatabase(t)
	ctx := context.Background()
	if err := integrationDatabaseSuite.prepareTemplate(ctx); err != nil {
		t.Fatalf("prepare integration database template again: %v", err)
	}

	control := connectTestControlDatabase(t)
	var databaseCount int
	var allowsConnections bool
	if err := control.QueryRow(ctx, `
		select count(*), bool_and(datallowconn)
		from pg_database
		where datname = $1
	`, integrationDatabaseSuite.templateDatabaseName()).Scan(&databaseCount, &allowsConnections); err != nil {
		t.Fatalf("inspect integration database template: %v", err)
	}
	if databaseCount != 1 {
		t.Fatalf("integration database template count = %d, want 1", databaseCount)
	}
	if allowsConnections {
		t.Fatal("integration database template still allows connections")
	}

	templateURL := databaseURLWithName(t, integrationDatabaseSuite.templateDatabaseName())
	connectCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	connection, err := pgx.Connect(connectCtx, templateURL)
	if err == nil {
		if closeErr := connection.Close(ctx); closeErr != nil {
			t.Errorf("close unexpected integration database template connection: %v", closeErr)
		}
		t.Fatal("connected directly to the integration database template")
	}
}

func TestDatabaseTemplateClonesIncludeBuiltinSkills(t *testing.T) {
	serialIntegrationTest(t, serialSuiteMeta)
	requireTestDatabase(t)
	ctx := context.Background()
	cloneURL, err := integrationDatabaseSuite.cloneDatabase(ctx, "skills")
	if err != nil {
		t.Fatalf("clone integration database: %v", err)
	}
	registerDatabaseCleanup(t, cloneURL)
	connection, err := pgx.Connect(ctx, cloneURL)
	if err != nil {
		t.Fatalf("connect Skill-seeded clone: %v", err)
	}
	defer connection.Close(ctx)
	var skillCount int
	if err := connection.QueryRow(ctx, `
		select count(*) from skills where owner_kind = 'platform'
	`).Scan(&skillCount); err != nil {
		t.Fatalf("count template platform Skills: %v", err)
	}
	if skillCount < builtinCatalogSkillCount {
		t.Fatalf("template platform Skills=%d, want at least %d", skillCount, builtinCatalogSkillCount)
	}
	rows, err := connection.Query(ctx, `
		select email,password_hash
		from accounts
		order by email
	`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	accountCount := 0
	for rows.Next() {
		var email, passwordHash string
		if err := rows.Scan(&email, &passwordHash); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(passwordHash, "$argon2id$v=19$m=64,t=1,p=1$") {
			t.Fatalf("integration account %s uses unexpected password parameters", email)
		}
		accountCount++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if accountCount != 1 {
		t.Fatalf("integration accounts=%d want=1", accountCount)
	}
	entries, err := os.ReadDir(integrationSkillArtifactRoot())
	if err != nil {
		t.Fatalf("read shared Skill artifact store: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("shared Skill artifact store has no warmed objects")
	}

	pool, err := pgxpool.New(ctx, cloneURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	firstRoot := copyTemplateSkillObjects(t, pool)
	secondRoot := copyTemplateSkillObjects(t, pool)
	copied, err := os.ReadDir(firstRoot)
	if err != nil || len(copied) == 0 {
		t.Fatalf("copied objects=%d error=%v", len(copied), err)
	}
	for _, entry := range copied {
		first, err := os.ReadFile(filepath.Join(firstRoot, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		second, err := os.ReadFile(filepath.Join(secondRoot, entry.Name()))
		if err != nil || !bytes.Equal(first, second) {
			t.Fatalf("private copy differs: %s error=%v", entry.Name(), err)
		}
	}
	key := copied[0].Name()
	original, err := os.ReadFile(filepath.Join(secondRoot, key))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(firstRoot, key), []byte("isolated mutation"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{secondRoot, integrationSkillArtifactRoot()} {
		content, err := os.ReadFile(filepath.Join(root, key))
		if err != nil || !bytes.Equal(content, original) {
			t.Fatalf("one fixture mutated another object root: %v", err)
		}
	}
}

func TestDatabaseBareTemplateClonesHaveNoPlatformSkills(t *testing.T) {
	serialIntegrationTest(t, serialSuiteMeta)
	requireTestDatabase(t)
	ctx := context.Background()
	cloneURL, err := integrationDatabaseSuite.cloneBareDatabase(ctx, "bareskills")
	if err != nil {
		t.Fatalf("clone Skill-free integration database: %v", err)
	}
	registerDatabaseCleanup(t, cloneURL)
	connection, err := pgx.Connect(ctx, cloneURL)
	if err != nil {
		t.Fatalf("connect Skill-free clone: %v", err)
	}
	defer connection.Close(ctx)
	var builtinCount int
	if err := connection.QueryRow(ctx, `
		select count(*) from skills where skill_id like 'linger_builtin_%'
	`).Scan(&builtinCount); err != nil {
		t.Fatalf("count Skill-free clone catalog Skills: %v", err)
	}
	if builtinCount != 0 {
		t.Fatalf("Skill-free clone imported catalog Skills=%d, want 0", builtinCount)
	}
}

func TestDatabaseTemplateClonesAreDistinctAndIsolated(t *testing.T) {
	serialIntegrationTest(t, serialSuiteMeta)
	requireTestDatabase(t)
	ctx := context.Background()
	type cloneResult struct {
		databaseURL string
		err         error
	}
	results := make([]cloneResult, 2)
	var clones sync.WaitGroup
	for index := range results {
		clones.Add(1)
		go func() {
			defer clones.Done()
			results[index].databaseURL, results[index].err = integrationDatabaseSuite.cloneDatabase(ctx, "parallel")
		}()
	}
	clones.Wait()
	for _, result := range results {
		if result.err != nil {
			t.Fatalf("clone integration database concurrently: %v", result.err)
		}
		registerDatabaseCleanup(t, result.databaseURL)
	}
	firstURL := results[0].databaseURL
	secondURL := results[1].databaseURL
	if databaseNameFromURL(t, firstURL) == databaseNameFromURL(t, secondURL) {
		t.Fatal("integration database clones reused the same database name")
	}

	first, err := pgx.Connect(ctx, firstURL)
	if err != nil {
		t.Fatalf("connect first integration database clone: %v", err)
	}
	defer first.Close(ctx)
	second, err := pgx.Connect(ctx, secondURL)
	if err != nil {
		t.Fatalf("connect second integration database clone: %v", err)
	}
	defer second.Close(ctx)

	if _, err := first.Exec(ctx, "insert into accounts(id, email, password_hash) values ('account_clone_isolation', 'clone-isolation@example.com', 'x')"); err != nil {
		t.Fatalf("write first integration database clone: %v", err)
	}
	var visibleInSecond bool
	if err := second.QueryRow(ctx, "select exists(select 1 from accounts where id = 'account_clone_isolation')").Scan(&visibleInSecond); err != nil {
		t.Fatalf("query second integration database clone: %v", err)
	}
	if visibleInSecond {
		t.Fatal("data written to one integration database clone appeared in another")
	}
}

func TestDatabaseSuiteCleanupRemovesTemplateAndClones(t *testing.T) {
	serialIntegrationTest(t, serialSuiteMeta)
	requireTestDatabase(t)
	ctx := context.Background()
	suite := newTestDatabaseSuite()
	databaseControlPool, err := suite.testControlPool(ctx)
	if err != nil {
		t.Fatalf("load disposable integration database control pool: %v", err)
	}
	templateName, err := randomDatabaseName("cleanup-template")
	if err != nil {
		t.Fatalf("name disposable integration database template: %v", err)
	}
	cloneName, err := randomDatabaseName("cleanup-clone")
	if err != nil {
		t.Fatalf("name disposable integration database clone: %v", err)
	}
	if err := createDatabase(ctx, databaseControlPool, templateName, ""); err != nil {
		t.Fatalf("create disposable integration database template: %v", err)
	}
	suite.mu.Lock()
	suite.bareTemplateName = templateName
	suite.mu.Unlock()
	t.Cleanup(func() {
		if err := suite.close(context.Background()); err != nil {
			t.Errorf("clean disposable integration database suite: %v", err)
		}
	})
	if err := createDatabase(ctx, databaseControlPool, cloneName, ""); err != nil {
		t.Fatalf("create disposable integration database clone: %v", err)
	}
	suite.registerDatabase(cloneName)

	databaseNames := []string{templateName, cloneName}
	if err := suite.close(ctx); err != nil {
		t.Fatalf("clean disposable integration database suite: %v", err)
	}

	control := connectTestControlDatabase(t)
	var remaining int
	if err := control.QueryRow(ctx, "select count(*) from pg_database where datname = any($1)", databaseNames).Scan(&remaining); err != nil {
		t.Fatalf("inspect disposable integration database cleanup: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("integration database suite cleanup left %d databases", remaining)
	}
}

func connectTestControlDatabase(t *testing.T) *pgx.Conn {
	t.Helper()
	config, err := database.ControlConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	connection, err := pgx.ConnectConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("connect test control database: %v", err)
	}
	t.Cleanup(func() {
		if err := connection.Close(context.Background()); err != nil {
			t.Errorf("close test control database: %v", err)
		}
	})
	return connection
}

func databaseURLWithName(t *testing.T, databaseName string) string {
	t.Helper()
	parsed, err := url.Parse(testControlDatabaseURL())
	if err != nil {
		t.Fatalf("parse test control database URL: %v", err)
	}
	parsed.Path = "/" + databaseName
	return parsed.String()
}

func databaseNameFromURL(t *testing.T, databaseURL string) string {
	t.Helper()
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse integration database URL: %v", err)
	}
	return config.Database
}
