// Package builtinskills exposes the versioned Skill assets shipped with the
// product. Persistence and lifecycle policy remain owned by TeamHub.
package builtinskills

import "embed"

// FS contains the built-in catalog and every referenced immutable package.
//
//go:embed all:builtin
var FS embed.FS
