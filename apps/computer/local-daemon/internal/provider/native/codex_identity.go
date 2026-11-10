package native

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// A parked app-server keeps the credentials it loaded at launch. The account
// fingerprint lets a take notice a re-login or account change on disk, so the
// process is recycled instead of serving with stale identity. Token refreshes
// Codex writes itself are left out.

// codexAuthFingerprint identifies the account behind <home>/auth.json.
// Access and refresh tokens are left out: Codex refreshes them itself, and
// that must not recycle the process.
func codexAuthFingerprint(home string) string {
	if home == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(codexAuthIdentity(data))
	return hex.EncodeToString(sum[:])
}

// codexAuthIdentity is a deterministic encoding of auth_mode,
// OPENAI_API_KEY and tokens.account_id, or the raw bytes when the file is
// not a JSON object.
func codexAuthIdentity(data []byte) []byte {
	var document map[string]json.RawMessage
	if json.Unmarshal(data, &document) != nil || document == nil {
		return data
	}
	var tokens map[string]json.RawMessage
	_ = json.Unmarshal(document["tokens"], &tokens)
	var identity bytes.Buffer
	codexIdentityValue(&identity, document["auth_mode"])
	codexIdentityValue(&identity, document["OPENAI_API_KEY"])
	account := tokens["account_id"]
	if codexJSONAbsent(account) {
		account = json.RawMessage(`""`)
	}
	codexIdentityValue(&identity, account)
	return identity.Bytes()
}

// codexIdentityValue writes one tagged, length-prefixed value. Absent and
// JSON null share a tag; a non-string value keeps its compact JSON text.
func codexIdentityValue(out *bytes.Buffer, raw json.RawMessage) {
	if codexJSONAbsent(raw) {
		out.WriteString("absent\n")
		return
	}
	var text string
	tag := "string"
	if json.Unmarshal(raw, &text) != nil {
		var compact bytes.Buffer
		if json.Compact(&compact, raw) == nil {
			text = compact.String()
		} else {
			text = string(raw)
		}
		tag = "json"
	}
	_, _ = fmt.Fprintf(out, "%s %d:%s\n", tag, len(text), text)
}

func codexJSONAbsent(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}
