package migrations_test

import (
	"math"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestMigrationVersionsAreUnique(t *testing.T) {
	// Exercise Goose discovery without a database so branch-merge collisions
	// fail in the fast unit gate, before any integration suite starts.
	migrations, err := goose.CollectMigrations(".", 0, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrations) == 0 {
		t.Fatal("no migrations discovered")
	}
}
