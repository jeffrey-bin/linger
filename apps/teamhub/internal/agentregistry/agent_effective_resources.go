package agentregistry

import (
	"crypto/sha256"
	"encoding/hex"
)

// EffectiveResourcesDigest folds the connected app capability into the Skill
// digest, so saving a Composio key changes it and the Agent Service rebuilds
// the next Run's instructions. With connected apps it stays the Skill digest.
func EffectiveResourcesDigest(skillDigest string, connectedApps bool) string {
	if connectedApps {
		return skillDigest
	}
	sum := sha256.Sum256([]byte(skillDigest + "\nconnected_apps=false"))
	return hex.EncodeToString(sum[:])
}
