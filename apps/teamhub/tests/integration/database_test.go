package integration_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/demodata"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/migrations"
	"github.com/simplexai-labs/linger/apps/teamhub/tests/testsupport/database"
	"github.com/simplexai-labs/linger/apps/teamhub/tests/testsupport/dbmetrics"
	"golang.org/x/crypto/argon2"
)

var integrationDatabaseSuite = newTestDatabaseSuite()
var errTestDatabaseSuiteClosed = errors.New("integration database suite is closed")

type databaseControl interface {
	Exec(context.Context, string) error
	Close()
}

type databaseControlPoolFactory func(context.Context, *pgxpool.Config) (databaseControl, error)

type pgxDatabaseControl struct {
	pool *pgxpool.Pool
}

func (control *pgxDatabaseControl) Exec(ctx context.Context, statement string) error {
	_, err := control.pool.Exec(ctx, statement)
	return err
}

func (control *pgxDatabaseControl) Close() {
	control.pool.Close()
}

type testDatabaseSuite struct {
	controlOnce       sync.Once
	controlPoolMu     sync.Mutex
	templateOnce      sync.Once
	mu                sync.Mutex
	controlConfig     *pgx.ConnConfig
	controlErr        error
	controlPool       databaseControl
	controlPoolClosed bool
	newControlPool    databaseControlPoolFactory
	templateName      string
	bareTemplateName  string
	templateErr       error
	databases         map[string]struct{}
	metrics           dbmetrics.Metrics
}

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	goose.SetLogger(goose.NopLogger())
	// Failing runs dump app warn/error logs; discarding them hid server-side causes.
	slog.SetDefault(slog.New(slog.NewTextHandler(integrationAppLogs, &slog.HandlerOptions{Level: slog.LevelWarn})))
	// Control pool sizing reads the effective -parallel value, so flags must be parsed first.
	flag.Parse()

	if testControlDatabaseURL() != "" {
		if err := integrationDatabaseSuite.prepareTemplate(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "FAIL: prepare integration database template: %v\n", err)
			if cleanupErr := integrationDatabaseSuite.close(context.Background()); cleanupErr != nil {
				fmt.Fprintf(os.Stderr, "FAIL: clean integration databases after template preparation failure: %v\n", cleanupErr)
			}
			os.Exit(1)
		}
	}

	status := m.Run()
	cleanupErr := integrationDatabaseSuite.close(context.Background())
	if cleanupErr != nil {
		fmt.Fprintf(os.Stderr, "FAIL: clean integration database suite: %v\n", cleanupErr)
		if status == 0 {
			status = 1
		}
	}
	if err := removeIntegrationSkillArtifactRoot(); err != nil {
		fmt.Fprintf(os.Stderr, "FAIL: clean integration Skill artifact store: %v\n", err)
		if status == 0 {
			status = 1
		}
	}
	if testControlDatabaseURL() != "" {
		fmt.Fprintln(os.Stderr, integrationDatabaseSuite.metrics.Report())
	}
	dumpIntegrationAppLogsOnFailure(status)
	os.Exit(status)
}

func newTestDatabaseSuite() *testDatabaseSuite {
	return &testDatabaseSuite{
		newControlPool: func(ctx context.Context, config *pgxpool.Config) (databaseControl, error) {
			pool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				return nil, err
			}
			return &pgxDatabaseControl{pool: pool}, nil
		},
		databases: make(map[string]struct{}),
	}
}

func (suite *testDatabaseSuite) prepareTemplate(ctx context.Context) error {
	suite.templateOnce.Do(func() {
		templateStarted := time.Now()
		defer func() {
			suite.metrics.RecordTemplatePhase("total", time.Since(templateStarted))
		}()

		phaseStarted := time.Now()
		control, err := suite.testControlPool(ctx)
		suite.metrics.RecordTemplatePhase("control", time.Since(phaseStarted))
		if err != nil {
			suite.templateErr = err
			return
		}
		bareName, err := randomDatabaseName("templatebare")
		if err != nil {
			suite.templateErr = fmt.Errorf("name Skill-free integration database template: %w", err)
			return
		}
		suite.mu.Lock()
		suite.bareTemplateName = bareName
		suite.mu.Unlock()

		if err := suite.measureTemplatePhase("bare_create", func() error {
			return createDatabase(ctx, control, bareName, "")
		}); err != nil {
			suite.templateErr = fmt.Errorf("create Skill-free integration database template: %w", err)
			return
		}
		bareURL, err := databaseURL(testControlDatabaseURL(), bareName)
		if err != nil {
			suite.templateErr = fmt.Errorf("build Skill-free integration database template URL: %w", err)
			return
		}
		if err := suite.measureTemplatePhase("migrate", func() error {
			return migrations.Up(ctx, bareURL)
		}); err != nil {
			suite.templateErr = fmt.Errorf("migrate Skill-free integration database template: %w", err)
			return
		}
		if err := suite.measureTemplatePhase("seed_identities", func() error {
			return demodata.SeedIdentities(ctx, bareURL)
		}); err != nil {
			suite.templateErr = fmt.Errorf("seed Skill-free integration database template: %w", err)
			return
		}
		if err := suite.measureTemplatePhase("password_hashes", func() error {
			return installLowCostIntegrationPasswordHashes(ctx, bareURL)
		}); err != nil {
			suite.templateErr = fmt.Errorf("install low-cost integration password hashes: %w", err)
			return
		}
		if err := suite.measureTemplatePhase("bare_seal", func() error {
			return preventDatabaseConnections(ctx, control, bareName)
		}); err != nil {
			suite.templateErr = fmt.Errorf("make Skill-free integration database template read-only: %w", err)
			return
		}
		templateName, err := randomDatabaseName("template")
		if err != nil {
			suite.templateErr = fmt.Errorf("name integration database template: %w", err)
			return
		}
		suite.mu.Lock()
		suite.templateName = templateName
		suite.mu.Unlock()
		if err := suite.measureTemplatePhase("skill_template_clone", func() error {
			return createDatabase(ctx, control, templateName, bareName)
		}); err != nil {
			suite.templateErr = fmt.Errorf("clone Skill-seeded integration database template: %w", err)
			return
		}
		templateURL, err := databaseURL(testControlDatabaseURL(), templateName)
		if err != nil {
			suite.templateErr = fmt.Errorf("build integration database template URL: %w", err)
			return
		}
		if err := suite.measureTemplatePhase("skill_install", func() error {
			return installTemplateSkills(ctx, templateURL)
		}); err != nil {
			suite.templateErr = fmt.Errorf("install built-in Skills into integration database template: %w", err)
			return
		}
		if err := suite.measureTemplatePhase("skill_seal", func() error {
			return preventDatabaseConnections(ctx, control, templateName)
		}); err != nil {
			suite.templateErr = fmt.Errorf("make integration database template read-only: %w", err)
		}
	})
	return suite.templateErr
}

func (suite *testDatabaseSuite) measureTemplatePhase(name string, operation func() error) error {
	started := time.Now()
	err := operation()
	suite.metrics.RecordTemplatePhase(name, time.Since(started))
	return err
}

func installLowCostIntegrationPasswordHashes(ctx context.Context, databaseURL string) error {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, "update accounts set password_hash=$1 where email=$2",
		lowCostIntegrationPasswordHash("alice@example.com", alicePassword), "alice@example.com")
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("update integration password hash: rows=%d", result.RowsAffected())
	}
	return tx.Commit(ctx)
}

// lowCostIntegrationPasswordHash derives a deterministic argon2id hash with
// minimal cost so logins do not dominate integration test time.
func lowCostIntegrationPasswordHash(email, password string) string {
	saltDigest := sha256.Sum256([]byte("teamhub-integration-password:" + email))
	salt := saltDigest[:16]
	key := argon2.IDKey([]byte(password), salt, 1, 64, 1, 32)
	return fmt.Sprintf(
		"$argon2id$v=19$m=64,t=1,p=1$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
}

func (suite *testDatabaseSuite) templateDatabaseName() string {
	suite.mu.Lock()
	defer suite.mu.Unlock()
	return suite.templateName
}

func (suite *testDatabaseSuite) bareTemplateDatabaseName() string {
	suite.mu.Lock()
	defer suite.mu.Unlock()
	return suite.bareTemplateName
}

func (suite *testDatabaseSuite) cloneDatabase(ctx context.Context, purpose string) (string, error) {
	return suite.cloneFromTemplate(ctx, purpose, suite.templateDatabaseName, "clone integration database from template")
}

func (suite *testDatabaseSuite) cloneBareDatabase(ctx context.Context, purpose string) (string, error) {
	return suite.cloneFromTemplate(ctx, purpose, suite.bareTemplateDatabaseName, "clone Skill-free integration database from template")
}

func (suite *testDatabaseSuite) cloneFromTemplate(
	ctx context.Context,
	purpose string,
	templateName func() string,
	cloneError string,
) (string, error) {
	if err := suite.prepareTemplate(ctx); err != nil {
		return "", fmt.Errorf("prepare template for clone: %w", err)
	}
	source := templateName()
	if source == "" {
		return "", fmt.Errorf("%s: template is not prepared", cloneError)
	}
	control, err := suite.testControlPool(ctx)
	if err != nil {
		return "", err
	}
	databaseName, err := randomDatabaseName(purpose)
	if err != nil {
		return "", fmt.Errorf("name integration database clone: %w", err)
	}
	cloneStarted := time.Now()
	// Reserve ownership before DDL, including an ambiguous connection failure.
	suite.registerDatabase(databaseName)
	if err := createDatabase(ctx, control, databaseName, source); err != nil {
		return "", fmt.Errorf("%s: %w", cloneError, err)
	}
	suite.metrics.RecordClone(time.Since(cloneStarted))
	return databaseURL(testControlDatabaseURL(), databaseName)
}

func (suite *testDatabaseSuite) registerDatabase(databaseName string) {
	suite.mu.Lock()
	defer suite.mu.Unlock()
	suite.databases[databaseName] = struct{}{}
}

func (suite *testDatabaseSuite) cleanupDatabase(ctx context.Context, databaseName string) error {
	suite.mu.Lock()
	_, registered := suite.databases[databaseName]
	suite.mu.Unlock()
	if !registered {
		return fmt.Errorf("refusing cleanup of unregistered integration database %q", databaseName)
	}
	control, err := suite.testControlPool(ctx)
	if err != nil {
		return err
	}
	cleanupStarted := time.Now()
	if err := dropDatabase(ctx, control, databaseName); err != nil {
		return err
	}
	suite.metrics.RecordCleanup(time.Since(cleanupStarted))
	suite.mu.Lock()
	delete(suite.databases, databaseName)
	suite.mu.Unlock()
	return nil
}

func (suite *testDatabaseSuite) close(ctx context.Context) error {
	suite.mu.Lock()
	databaseNames := make([]string, 0, len(suite.databases))
	for databaseName := range suite.databases {
		databaseNames = append(databaseNames, databaseName)
	}
	templateName := suite.templateName
	bareTemplateName := suite.bareTemplateName
	suite.mu.Unlock()
	if len(databaseNames) == 0 && templateName == "" && bareTemplateName == "" {
		suite.closeControlPool()
		return nil
	}

	control, err := suite.testControlPool(ctx)
	if err != nil {
		suite.closeControlPool()
		return err
	}
	defer suite.closeControlPool()
	var cleanupErrors []error
	for _, databaseName := range databaseNames {
		cleanupStarted := time.Now()
		if err := dropDatabase(ctx, control, databaseName); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("drop integration database %s: %w", databaseName, err))
			continue
		}
		suite.metrics.RecordCleanup(time.Since(cleanupStarted))
		suite.mu.Lock()
		delete(suite.databases, databaseName)
		suite.mu.Unlock()
	}
	for _, named := range []struct {
		name  string
		clear func()
	}{
		{templateName, func() { suite.templateName = "" }},
		{bareTemplateName, func() { suite.bareTemplateName = "" }},
	} {
		if named.name == "" {
			continue
		}
		if err := dropDatabase(ctx, control, named.name); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("drop integration database template %s: %w", named.name, err))
			continue
		}
		suite.mu.Lock()
		named.clear()
		suite.mu.Unlock()
	}
	return errors.Join(cleanupErrors...)
}

func (suite *testDatabaseSuite) testControlConfig(ctx context.Context) (*pgx.ConnConfig, error) {
	suite.controlOnce.Do(func() {
		suite.controlConfig, suite.controlErr = database.ControlConfig(ctx)
	})
	if suite.controlErr != nil {
		return nil, suite.controlErr
	}
	return suite.controlConfig.Copy(), nil
}

func (suite *testDatabaseSuite) testControlPool(ctx context.Context) (databaseControl, error) {
	suite.controlPoolMu.Lock()
	defer suite.controlPoolMu.Unlock()
	if suite.controlPoolClosed {
		return nil, errTestDatabaseSuiteClosed
	}
	if suite.controlPool != nil {
		return suite.controlPool, nil
	}
	controlConfig, err := suite.testControlConfig(ctx)
	if err != nil {
		return nil, err
	}
	poolConfig, err := pgxpool.ParseConfig(controlConfig.ConnString())
	if err != nil {
		return nil, fmt.Errorf("build test control database pool config: %w", err)
	}
	poolConfig.ConnConfig = controlConfig.Copy()
	poolConfig.MaxConns = integrationControlPoolSize()
	poolConfig.MinConns = 0
	control, err := suite.newControlPool(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create test control database pool: %w", err)
	}
	suite.controlPool = control
	return control, nil
}

func (suite *testDatabaseSuite) closeControlPool() {
	suite.controlPoolMu.Lock()
	if suite.controlPoolClosed {
		suite.controlPoolMu.Unlock()
		return
	}
	suite.controlPoolClosed = true
	control := suite.controlPool
	suite.controlPool = nil
	suite.controlPoolMu.Unlock()
	if control != nil {
		control.Close()
	}
}

func newIntegrationDatabase(t *testing.T) string {
	t.Helper()
	return newPreactivationIntegrationDatabase(t)
}

func newIntegrationDatabaseWithoutSkills(t *testing.T) string {
	t.Helper()
	requireTestDatabase(t)
	databaseURL, err := integrationDatabaseSuite.cloneBareDatabase(context.Background(), "noskills")
	if err != nil {
		t.Fatalf("clone Skill-free integration database: %v", err)
	}
	registerDatabaseCleanup(t, databaseURL)
	return databaseURL
}

func newPreactivationIntegrationDatabase(t *testing.T) string {
	t.Helper()
	requireTestDatabase(t)
	databaseURL, err := integrationDatabaseSuite.cloneDatabase(context.Background(), "integration")
	if err != nil {
		t.Fatalf("clone isolated integration database: %v", err)
	}
	registerDatabaseCleanup(t, databaseURL)
	return databaseURL
}

func registerDatabaseCleanup(t *testing.T, databaseURL string) {
	t.Helper()
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse isolated database cleanup URL: %v", err)
	}
	databaseName := config.Database
	t.Cleanup(func() {
		err := integrationDatabaseSuite.cleanupDatabase(context.Background(), databaseName)
		if err != nil {
			t.Errorf("clean isolated database %s: %v", databaseName, err)
		}
	})
}

func requireTestDatabase(t *testing.T) {
	t.Helper()
	if testControlDatabaseURL() == "" {
		t.Skip("integration tests require the managed test database runner")
	}
}

func testControlDatabaseURL() string {
	return os.Getenv("TEST_DATABASE_URL")
}

func createDatabase(ctx context.Context, control databaseControl, databaseName, templateName string) error {
	statement := "create database " + pgx.Identifier{databaseName}.Sanitize()
	if templateName != "" {
		statement += " template " + pgx.Identifier{templateName}.Sanitize()
	}
	return control.Exec(ctx, statement)
}

func preventDatabaseConnections(ctx context.Context, control databaseControl, databaseName string) error {
	return control.Exec(ctx, "alter database "+pgx.Identifier{databaseName}.Sanitize()+" with allow_connections false")
}

func dropDatabase(ctx context.Context, control databaseControl, databaseName string) error {
	return control.Exec(ctx, "drop database if exists "+pgx.Identifier{databaseName}.Sanitize()+" with (force)")
}

func databaseURL(controlURL, databaseName string) (string, error) {
	return database.WithDatabase(controlURL, databaseName)
}

func randomDatabaseName(purpose string) (string, error) {
	suffix, err := randomDatabaseSuffix()
	if err != nil {
		return "", err
	}
	return "teamhub_test_" + sanitizeDatabasePart(purpose) + "_" + suffix, nil
}

func randomDatabaseSuffix() (string, error) {
	value := make([]byte, 8)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func sanitizeDatabasePart(value string) string {
	value = strings.ToLower(value)
	var result strings.Builder
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			result.WriteRune(char)
		}
	}
	if result.Len() == 0 {
		return "case"
	}
	return result.String()
}
