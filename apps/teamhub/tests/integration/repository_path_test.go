package integration_test

import (
	"os"
	"path/filepath"
	"testing"
)

// repositoryPath resolves files from the checkout that is running the test
// binary, rather than from the checkout that compiled it.
func repositoryPath(parts ...string) string {
	root := os.Getenv("CI_PROJECT_DIR")
	if root == "" {
		workingDirectory, err := os.Getwd()
		if err == nil {
			for root = workingDirectory; ; root = filepath.Dir(root) {
				if _, err := os.Stat(filepath.Join(root, "pnpm-workspace.yaml")); err == nil {
					break
				}
				if filepath.Dir(root) == root {
					panic("integration test checkout root is unavailable")
				}
			}
		}
	}
	return filepath.Join(append([]string{root}, parts...)...)
}

func TestRepositoryPathUsesCurrentCheckout(t *testing.T) {
	serialIntegrationTest(t, serialProcessEnv)
	t.Run("migration directory follows the current checkout", func(t *testing.T) {
		checkout := t.TempDir()
		t.Setenv("CI_PROJECT_DIR", checkout)
		if got, want := teamHubMigrationDirectory(t), filepath.Join(checkout, "apps", "teamhub", "migrations"); got != want {
			t.Fatalf("migration directory=%q, want current checkout %q", got, want)
		}
	})
	t.Setenv("CI_PROJECT_DIR", "/current/checkout")
	if got, want := repositoryPath("contracts", "fixtures"), "/current/checkout/contracts/fixtures"; got != want {
		t.Fatalf("repositoryPath() = %q, want %q", got, want)
	}
	t.Setenv("CI_PROJECT_DIR", "")
	if _, err := os.Stat(repositoryPath("apps", "node-services", "package.json")); err != nil {
		t.Fatalf("local test working directory did not resolve the monorepo: %v", err)
	}
}

func teamHubMigrationDirectory(t *testing.T) string {
	t.Helper()
	return repositoryPath("apps", "teamhub", "migrations")
}
