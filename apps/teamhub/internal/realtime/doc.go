// Package realtime turns PostgreSQL commit notifications (NOTIFY) into in-process wake-up hints,
// delivering them to online subscribers of Rooms, browser event streams, recordings, and Agent Inbox, as well as the Agent Runtime
// status projection worker.
// PostgreSQL is the authoritative source of content and recovery cursors; the Broker does no persistence or replay.
package realtime
