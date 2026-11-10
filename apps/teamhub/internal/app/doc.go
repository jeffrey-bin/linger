// Package app owns TeamHub's HTTP routing, session validation, permission checks, and transactional write orchestration.
// PostgreSQL stores the recoverable collaboration facts; the realtime Broker only wakes online SSE connections.
package app
