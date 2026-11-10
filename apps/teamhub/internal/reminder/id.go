package reminder

import (
	"strings"
	"time"
)

func encodeCursor(createdAt time.Time, id string) string {
	return createdAt.UTC().Format(time.RFC3339Nano) + "|" + id
}

func decodeCursor(cursor string) (time.Time, string, error) {
	createdAtRaw, id, found := strings.Cut(cursor, "|")
	if !found || id == "" {
		return time.Time{}, "", ErrInvalid
	}
	createdAt, err := time.Parse(time.RFC3339Nano, createdAtRaw)
	if err != nil {
		return time.Time{}, "", ErrInvalid
	}
	return createdAt, id, nil
}
