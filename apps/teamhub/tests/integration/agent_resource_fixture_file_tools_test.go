package integration_test

import (
	"crypto/sha256"
	"encoding/hex"
)

func mcpFileInvocationID(label string) string {
	digest := sha256.Sum256([]byte("MCP file Tool JSON-RPC invocation:" + label))
	return "agent-invocation-sha256:" + hex.EncodeToString(digest[:])
}
