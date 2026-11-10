package app

import (
	"encoding/json"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

func writeResultResponse(c *gin.Context, result idempotency.Result) {
	if result.Replay {
		c.Header("Idempotent-Replay", "true")
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func convertJSON[T any](value any) (T, error) {
	var result T
	encoded, err := json.Marshal(value)
	if err != nil {
		return result, err
	}
	return result, json.Unmarshal(encoded, &result)
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func pointerSlice[T any](value *[]T) []T {
	if value == nil {
		return nil
	}
	return *value
}

func ptr[T any](value T) *T { return &value }
