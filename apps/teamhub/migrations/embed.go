// Package migrations embeds the SQL migrations so TeamHub binaries carry
// their schema history and need no migration directory at run time.
package migrations

import "embed"

// Files holds every SQL migration in this directory.
//
//go:embed *.sql
var Files embed.FS
