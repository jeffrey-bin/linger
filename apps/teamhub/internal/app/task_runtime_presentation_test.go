package app

import (
	"encoding/base64"
	"strconv"
	"testing"
	"time"
)

func TestTaskActivityCursorIsScopedAndPositive(t *testing.T) {
	for _, raw := range []string{
		"other-task\n3\nrun-1", "task\n0\nrun-1", "task\n-1\nrun-1", "task\nbad\nrun-1",
		"task\n9223372036854775808\nrun-1", "task\n42\n", "task\n42",
	} {
		cursor := base64.RawURLEncoding.EncodeToString([]byte(raw))
		if _, valid := taskPresentationCursor("task", &cursor); valid {
			t.Fatalf("accepted cursor %q", raw)
		}
	}
	created := time.Date(2026, 11, 3, 10, 0, 0, 123456000, time.UTC)
	cursor := base64.RawURLEncoding.EncodeToString([]byte("task\n" + strconv.FormatInt(created.UnixMicro(), 10) + "\nrun-1"))
	position, valid := taskPresentationCursor("task", &cursor)
	if !valid || !position.createdAt.Time.Equal(created) || position.runID != "run-1" {
		t.Fatalf("cursor %+v %v", position, valid)
	}
	if position, valid := taskPresentationCursor("task", nil); !valid || position.createdAt.Valid {
		t.Fatalf("first page cursor %+v %v", position, valid)
	}
}
