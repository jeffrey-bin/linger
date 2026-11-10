package app

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
)

// Saving or removing a Composio key changes the effective resources digest, so
// the Agent Service rebuilds the next Run's instructions; with a key the digest
// is the Skill digest unchanged.
func TestEffectiveResourcesDigestFollowsConnectedApps(t *testing.T) {
	skills := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if got := agentregistry.EffectiveResourcesDigest(skills, true); got != skills {
		t.Fatalf("digest with connected apps = %s, want the Skill digest", got)
	}
	without := agentregistry.EffectiveResourcesDigest(skills, false)
	if without == skills || len(without) != 64 {
		t.Fatalf("digest without connected apps = %s", without)
	}
	if again := agentregistry.EffectiveResourcesDigest(skills, false); again != without {
		t.Fatal("digest is not deterministic")
	}
	if (&App{}).connectedAppsConfigured() {
		t.Fatal("an App without external sources has no connected apps")
	}
}
