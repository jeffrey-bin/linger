package permissionreview

import (
	"context"
	"strings"
	"testing"
)

// Without a judge model the review is off, so deploying it changes nothing
// until a model is configured.
func TestReviewWithoutAJudgeAllowsEveryCall(t *testing.T) {
	t.Parallel()
	outcome, err := (&Service{}).Review(context.Background(), ReviewInput{Action: Action{Tool: "Bash", Command: "git push"}})
	if err != nil || outcome.Decision != DecisionAllow {
		t.Fatalf("outcome=%+v err=%v", outcome, err)
	}
}

func TestActionDigestIgnoresJSONLayoutButNotContent(t *testing.T) {
	t.Parallel()
	base := Action{Surface: "browser", Tool: "mcp__browser__browser_click", Input: `{"ref":"e42","element":"Send"}`}
	reordered := base
	reordered.Input = `{ "element": "Send", "ref": "e42" }`
	if ActionDigest(base, Evidence{}) != ActionDigest(reordered, Evidence{}) {
		t.Fatal("key order and spacing must not change the digest")
	}
	otherTarget := base
	otherTarget.Input = `{"ref":"e43","element":"Send"}`
	if ActionDigest(base, Evidence{}) == ActionDigest(otherTarget, Evidence{}) {
		t.Fatal("a different target must be a different action")
	}

	shell := Action{Surface: "shell", Tool: "Bash", Command: "python scripts/notify.py"}
	before := ActionDigest(shell, Evidence{Script: &ScriptEvidence{Path: "scripts/notify.py", Body: "print('preview')"}})
	after := ActionDigest(shell, Evidence{Script: &ScriptEvidence{Path: "scripts/notify.py", Body: "send_all()"}})
	if before == after {
		t.Fatal("an approval must not carry over to a changed script")
	}
	if ActionDigest(shell, Evidence{Patch: "a"}) == ActionDigest(shell, Evidence{Patch: "b"}) {
		t.Fatal("an approval must not carry over to a changed patch")
	}
	if !strings.HasPrefix(before, "sha256:") || len(before) != len("sha256:")+64 {
		t.Fatalf("digest %q does not match the stored format", before)
	}
}
