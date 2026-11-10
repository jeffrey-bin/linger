package database

import (
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestWithDatabaseOverridesControlDatabaseOptions(t *testing.T) {
	for _, query := range []string{"dbname=teamhub_test_control", "database=teamhub_test_control", "dbname=old&database=older"} {
		t.Run(query, func(t *testing.T) {
			result, err := WithDatabase("postgres://user:password@localhost/teamhub_test_control?"+query+"&sslmode=disable&application_name=isolated", "teamhub_test_clone")
			if err != nil {
				t.Fatal(err)
			}
			config, err := pgx.ParseConfig(result)
			if err != nil {
				t.Fatal(err)
			}
			if config.Database != "teamhub_test_clone" {
				t.Fatalf("connected database = %q", config.Database)
			}
			parsed, err := url.Parse(result)
			if err != nil {
				t.Fatal(err)
			}
			if parsed.Query().Get("application_name") != "isolated" || parsed.Query().Get("sslmode") != "disable" {
				t.Fatal("connection options lost")
			}
			if parsed.Query().Has("dbname") || parsed.Query().Has("database") {
				t.Fatal("database override retained")
			}
		})
	}
}
