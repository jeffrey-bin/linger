package personalinsight

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

const testSubjectID = "subject:synthetic"

func TestSyntheticFixtureCallsModelWithSelfEvidence(t *testing.T) {
	routed := routeSyntheticFixture(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(request.Body)
		owner := `"owner":{"ownerActorId":"` + testSubjectID + `","tenantId":"tenant_1"}`
		if request.URL.Path != "/v1/model-calls" || strings.Contains(string(raw), `"route"`) || !strings.Contains(string(raw), owner) {
			http.Error(response, "unexpected request "+string(raw), http.StatusBadRequest)
			return
		}
		writeModelCallOutput(response, `{"insights":[]}`)
	}))
	defer server.Close()
	generator := newTestGenerator(t, server.URL)
	result, err := generator.GenerateEvidence(context.Background(), "tenant_1", testSubjectID, EmailGroundingEvidence(testSubjectID, routed))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Insights) != 0 || len(result.Rejections) != 0 || calls.Load() != 1 {
		t.Fatalf("Synthetic evidence with a self-authored message must call the model once: result=%+v calls=%d", result, calls.Load())
	}
}

func TestGeneratorSkipsModelWithoutAttributablePersonEvidence(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "direct", MessageID: "peer", Direction: emailevidence.DirectionInbound, Body: "Please share the plan."},
		{DatasetID: "synthetic-v1", ThreadID: "status", MessageID: "system", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{Category: "updates"}, Body: "A service status changed."},
	})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	generator := newTestGenerator(t, server.URL)
	result, err := generator.GenerateEvidence(context.Background(), "tenant_1", testSubjectID, EmailGroundingEvidence(testSubjectID, routed))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Insights) != 0 || len(result.Rejections) != 0 || calls.Load() != 0 {
		t.Fatalf("automated or unattributed messages must not trigger personal Insight generation: result=%+v calls=%d", result, calls.Load())
	}
}

func TestGeneratorSkipsCrossSubjectEmailEvidence(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{{
		DatasetID: "synthetic-v1", ThreadID: "preference", MessageID: "self",
		Direction: emailevidence.DirectionOutbound, Body: "I prefer written proposals.",
	}})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	generator := newTestGenerator(t, server.URL)
	result, err := generator.GenerateEvidence(context.Background(), "tenant_1", testSubjectID, EmailGroundingEvidence("subject:other", routed))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Insights) != 0 || len(result.Rejections) != 0 || calls.Load() != 0 {
		t.Fatalf("cross-subject email evidence must be removed before the model call: result=%+v calls=%d", result, calls.Load())
	}
}

func TestGeneratorAcceptsOneAttributableHumanReport(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{{
		DatasetID: "synthetic-v1", ThreadID: "review", MessageID: "peer",
		Direction: emailevidence.DirectionInbound, SenderLocal: "colleague",
		Body: "You consistently turn ambiguous review comments into concrete questions before making a decision.",
	}})
	evidenceID := routed[0].Message.Evidence.EvidenceID
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writeModelCallOutput(response, fmt.Sprintf(
			`{"insights":[{"dimension":"decision approach","basis":"reported","statement":"A colleague describes the user as turning ambiguous review comments into concrete questions before deciding.","evidence_ids":[%q]}]}`,
			evidenceID,
		))
	}))
	defer server.Close()
	generator := newTestGenerator(t, server.URL)
	result, err := generator.GenerateEvidence(context.Background(), "tenant_1", testSubjectID, EmailGroundingEvidence(testSubjectID, routed))
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || len(result.Insights) != 1 || result.Insights[0].Basis != InsightBasisReported ||
		len(result.Insights[0].Evidence) != 1 || result.Insights[0].Evidence[0].Authorship != EvidenceAuthorshipOtherHuman {
		t.Fatalf("one attributable human report should reach the model and retain attribution: result=%+v calls=%d", result, calls.Load())
	}
}

func TestGeneratorPersistsPurposeWeightedEvidence(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "planning", MessageID: "m1", Direction: emailevidence.DirectionInbound, Body: "Could you document the deployment plan?"},
		{DatasetID: "synthetic-v1", ThreadID: "review", MessageID: "m2", Direction: emailevidence.DirectionOutbound, Body: "I prefer to turn repeated release questions into runbooks."},
		{DatasetID: "synthetic-v1", ThreadID: "retrospective", MessageID: "m3", Direction: emailevidence.DirectionOutbound, Body: "I write down incident decisions so the next response is repeatable."},
		{DatasetID: "synthetic-v1", ThreadID: "status", MessageID: "m4", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{Category: "CATEGORY_UPDATES"}, Body: "The deployment check needs attention."},
		{DatasetID: "synthetic-v1", ThreadID: "newsletter", MessageID: "m5", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{ListID: true}, Body: "Release engineering weekly."},
	})
	evidenceIDs := make([]string, 0, len(routed))
	for _, item := range routed {
		evidenceIDs = append(evidenceIDs, item.Message.Evidence.EvidenceID)
	}

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/model-calls" || request.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(response, "unexpected request", http.StatusBadRequest)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			http.Error(response, err.Error(), http.StatusBadRequest)
			return
		}
		rawPayload, _ := json.Marshal(payload)
		if strings.Contains(string(rawPayload), "maxItems") || strings.Contains(string(rawPayload), "minItems") {
			http.Error(response, "provider-incompatible array constraint", http.StatusBadRequest)
			return
		}
		output, _ := json.Marshal(map[string]any{"insights": []map[string]any{{
			"dimension":    "work patterns",
			"basis":        "inferred",
			"statement":    "The user turns operational decisions into reusable written guidance so future work is repeatable.",
			"evidence_ids": evidenceIDs,
		}}})
		writeModelCallOutput(response, string(output))
	}))
	defer server.Close()

	generator := newTestGenerator(t, server.URL)
	result, err := generator.GenerateEvidence(context.Background(), "tenant_1", testSubjectID, EmailGroundingEvidence(testSubjectID, routed))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Insights) != 1 || len(result.Rejections) != 0 {
		t.Fatalf("expected one grounded Insight: %+v", result)
	}
	insight := result.Insights[0]
	if insight.ID == "" || insight.Dimension != "work patterns" || insight.Basis != InsightBasisInferred || len(insight.Evidence) != 5 {
		t.Fatalf("Insight must retain its open dimension, basis, and all cited evidence: %+v", insight)
	}
	strengths := map[emailevidence.MessageClass]emailevidence.Strength{}
	for _, reference := range insight.Evidence {
		if reference.Source.DatasetID != "synthetic-v1" || reference.Source.ThreadID == "" || reference.Source.MessageID == "" || reference.Source.ContentSHA256 == "" || reference.Source.Excerpt == "" {
			t.Fatalf("incomplete evidence reference: %+v", reference)
		}
		strengths[reference.Source.EmailClass] = reference.Strength
	}
	if strengths[emailevidence.MessageClassSelfSent] != emailevidence.StrengthPrimary || strengths[emailevidence.MessageClassDirectInbound] != emailevidence.StrengthSupporting || strengths[emailevidence.MessageClassSystemNotification] != emailevidence.StrengthSupporting || strengths[emailevidence.MessageClassSubscription] != emailevidence.StrengthWeak {
		t.Fatalf("unexpected persisted evidence strengths: %+v", strengths)
	}
}

func TestValidateDraftsRejectsUngroundedPersonalClaims(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "one", MessageID: "self", Direction: emailevidence.DirectionOutbound, Body: "I write runbooks."},
		{DatasetID: "synthetic-v1", ThreadID: "one", MessageID: "peer", Direction: emailevidence.DirectionInbound, Body: "Please share the runbook."},
		{DatasetID: "synthetic-v1", ThreadID: "two", MessageID: "system", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{Category: "updates"}, Body: "A service status changed."},
		{DatasetID: "synthetic-v1", ThreadID: "three", MessageID: "subscription", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{ListID: true}, Body: "A weekly digest."},
		{DatasetID: "synthetic-v1", ThreadID: "four", MessageID: "peer-2", Direction: emailevidence.DirectionInbound, Body: "A second direct request."},
		{DatasetID: "synthetic-v1", ThreadID: "five", MessageID: "marketing", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{Category: "promotions"}, Body: "Buy now."},
	})
	byMessageID := map[string]string{}
	for _, item := range routed {
		byMessageID[item.Message.MessageID] = item.Message.Evidence.EvidenceID
	}

	result := ValidateDrafts(testSubjectID, testSubjectID, routed, []InsightDraft{
		{Dimension: "work patterns", Basis: InsightBasisInferred, Statement: "One self-authored thread cannot establish an inferred pattern.", EvidenceIDs: []string{byMessageID["self"], byMessageID["peer"], byMessageID["system"]}},
		{Dimension: "preferences", Basis: InsightBasisExplicit, Statement: "External messages cannot establish a user preference.", EvidenceIDs: []string{byMessageID["system"], byMessageID["subscription"]}},
		{Dimension: "interests", Basis: InsightBasisExplicit, Statement: "Marketing evidence is excluded.", EvidenceIDs: []string{"gmail:synthetic-v1:five:marketing"}},
		{Dimension: "communication", Basis: InsightBasis("observed"), Statement: "Unknown bases are rejected.", EvidenceIDs: []string{byMessageID["self"]}},
		{Dimension: "", Basis: InsightBasisExplicit, Statement: "A dimension is required.", EvidenceIDs: []string{byMessageID["self"]}},
	})
	if len(result.Insights) != 0 || len(result.Rejections) != 5 {
		t.Fatalf("ungrounded drafts must all be rejected: %+v", result)
	}
	wantCodes := []string{
		"inferred_requires_multiple_contexts",
		"explicit_requires_owner_evidence",
		"ineligible_evidence",
		"invalid_basis",
		"invalid_dimension",
	}
	for index, want := range wantCodes {
		if result.Rejections[index].Code != want {
			t.Fatalf("rejection[%d]=%s, want %s", index, result.Rejections[index].Code, want)
		}
	}
	reported := ValidateDrafts(testSubjectID, testSubjectID, routed, []InsightDraft{{
		Dimension: "collaboration", Basis: InsightBasisReported,
		Statement: "An unattributed message cannot establish a reported observation.", EvidenceIDs: []string{byMessageID["peer"]},
	}})
	if len(reported.Insights) != 0 || len(reported.Rejections) != 1 || reported.Rejections[0].Code != "reported_requires_attributable_human_evidence" {
		t.Fatalf("reported Insight must require an attributable human author: %+v", reported)
	}
}

func TestValidateDraftsRejectsInboundOnlyInference(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "review", MessageID: "alice", Direction: emailevidence.DirectionInbound, SenderLocal: "alice", Body: "You ask for concrete examples when a proposal is ambiguous."},
		{DatasetID: "synthetic-v1", ThreadID: "planning", MessageID: "bob", Direction: emailevidence.DirectionInbound, SenderLocal: "bob", Body: "Your first question was which measurable outcome the plan should change."},
	})
	evidenceIDs := []string{routed[0].Message.Evidence.EvidenceID, routed[1].Message.Evidence.EvidenceID}
	result := ValidateDrafts(testSubjectID, testSubjectID, routed, []InsightDraft{{
		Dimension: "decision approach", Basis: InsightBasisInferred,
		Statement:   "Across collaborators, the user appears to clarify ambiguous proposals by asking for concrete examples and measurable outcomes.",
		EvidenceIDs: evidenceIDs,
	}})
	if len(result.Insights) != 0 || len(result.Rejections) != 1 || result.Rejections[0].Code != "inferred_requires_owner_evidence" {
		t.Fatalf("inbound-only inference must fail closed even with independent human authors: %+v", result)
	}

	sameAuthor := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "review", MessageID: "alice-1", Direction: emailevidence.DirectionInbound, SenderLocal: "alice", Body: "You asked for an example."},
		{DatasetID: "synthetic-v1", ThreadID: "planning", MessageID: "alice-2", Direction: emailevidence.DirectionInbound, SenderLocal: "alice", Body: "You asked for an outcome."},
	})
	result = ValidateDrafts(testSubjectID, testSubjectID, sameAuthor, []InsightDraft{{
		Dimension: "decision approach", Basis: InsightBasisInferred, Statement: "One reporter cannot establish a cross-person pattern.",
		EvidenceIDs: []string{sameAuthor[0].Message.Evidence.EvidenceID, sameAuthor[1].Message.Evidence.EvidenceID},
	}})
	if len(result.Insights) != 0 || len(result.Rejections) != 1 || result.Rejections[0].Code != "inferred_requires_owner_evidence" {
		t.Fatalf("inbound-only inference must fail closed before author-count checks: %+v", result)
	}
}

func TestValidateDraftsAcceptsOneExplicitSelfStatement(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "preference", MessageID: "self", Direction: emailevidence.DirectionOutbound, Body: "I prefer written proposals before a decision meeting."},
		{DatasetID: "synthetic-v1", ThreadID: "preference", MessageID: "peer", Direction: emailevidence.DirectionInbound, Body: "I will send the proposal first."},
	})
	evidenceIDs := []string{routed[0].Message.Evidence.EvidenceID, routed[1].Message.Evidence.EvidenceID}
	result := ValidateDrafts(testSubjectID, testSubjectID, routed, []InsightDraft{{
		Dimension: "decision preferences", Basis: InsightBasisExplicit,
		Statement: "The user prefers to review a written proposal before discussing a decision in a meeting.", EvidenceIDs: evidenceIDs,
	}})
	if len(result.Insights) != 1 || len(result.Rejections) != 0 || result.Insights[0].Basis != InsightBasisExplicit || len(result.Insights[0].Evidence) != 2 {
		t.Fatalf("one explicit self-authored statement should ground an Insight: %+v", result)
	}
}

func TestValidateDraftsAcceptsInferenceAcrossSelfAuthoredThreads(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{
		{DatasetID: "synthetic-v1", ThreadID: "release", MessageID: "self-1", Direction: emailevidence.DirectionOutbound, Body: "I added the release decision to the runbook."},
		{DatasetID: "synthetic-v1", ThreadID: "incident", MessageID: "self-2", Direction: emailevidence.DirectionOutbound, Body: "I captured the incident decision so we can reuse it next time."},
	})
	result := ValidateDrafts(testSubjectID, testSubjectID, routed, []InsightDraft{{
		Dimension: "work patterns", Basis: InsightBasisInferred,
		Statement:   "The user routinely records operational decisions for future reuse.",
		EvidenceIDs: []string{routed[0].Message.Evidence.EvidenceID, routed[1].Message.Evidence.EvidenceID},
	}})
	if len(result.Insights) != 1 || len(result.Rejections) != 0 || result.Insights[0].Basis != InsightBasisInferred {
		t.Fatalf("two self-authored threads should ground an inferred Insight: %+v", result)
	}
}

func TestValidateDraftsDeduplicatesEvidenceAndRejectsTooManyCandidates(t *testing.T) {
	routed := routeForTest(t, []emailevidence.MessageInput{{
		DatasetID: "synthetic-v1", ThreadID: "one", MessageID: "self", Direction: emailevidence.DirectionOutbound, Body: "I write runbooks.",
	}})
	selfID := routed[0].Message.Evidence.EvidenceID
	duplicate := ValidateDrafts(testSubjectID, testSubjectID, routed, []InsightDraft{{
		Dimension: "work habits", Basis: InsightBasisExplicit, Statement: "Duplicate evidence is normalized.", EvidenceIDs: []string{selfID, selfID},
	}})
	if len(duplicate.Insights) != 1 || len(duplicate.Rejections) != 0 || len(duplicate.Insights[0].Evidence) != 1 {
		t.Fatalf("duplicate evidence must be stored once before applying evidence thresholds: %+v", duplicate)
	}

	tooMany := make([]InsightDraft, maxInsights+1)
	result := ValidateDrafts(testSubjectID, testSubjectID, routed, tooMany)
	if len(result.Insights) != 0 || len(result.Rejections) != 1 || result.Rejections[0].Code != "too_many_insights" {
		t.Fatalf("too many candidates must be rejected before per-candidate validation: %+v", result)
	}
}

func TestSyntheticFixtureLiveGeneration(t *testing.T) {
	generator := configuredLiveGenerator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := generator.GenerateEvidence(ctx, "", testSubjectID, EmailGroundingEvidence(testSubjectID, routeSyntheticFixture(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Insights) != 0 || len(result.Rejections) != 0 {
		t.Fatalf("Synthetic fixture contains only Profile and Todo/Issue facts, want grounded abstention: %+v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Synthetic email Insight fixture with model %s: %s", result.Model, encoded)
}

func TestExplicitSelfStatementLiveEvaluation(t *testing.T) {
	generator := configuredLiveGenerator(t)
	routed := routeForTest(t, []emailevidence.MessageInput{{
		DatasetID: "explicit-self-sanitized-v1", ThreadID: "decision", MessageID: "self",
		Direction: emailevidence.DirectionOutbound,
		Body:      "I prefer to read a written proposal before a decision meeting because it gives me time to compare tradeoffs.",
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := generator.GenerateEvidence(ctx, "", testSubjectID, EmailGroundingEvidence(testSubjectID, routed))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rejections) != 0 {
		t.Fatalf("explicit self-statement evaluation produced invalid candidates: %+v", result)
	}
	for _, insight := range result.Insights {
		if insight.Basis != InsightBasisExplicit || len(insight.Evidence) != 1 {
			t.Fatalf("single-source result must be explicit and cite the self-authored source: %+v", insight)
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Explicit self-statement Insight fixture with model %s: %s", result.Model, encoded)
}

func configuredLiveGenerator(t *testing.T) *HTTPGenerator {
	t.Helper()
	if os.Getenv("REPLAY_EMAIL_INSIGHT") != "1" {
		t.Skip("set REPLAY_EMAIL_INSIGHT=1 to call the Agent Service model calls on the only Another Me Runtime")
	}
	seed := strings.TrimSpace(os.Getenv("LINGER_SECRET_SEED"))
	if seed == "" {
		t.Fatal("missing LINGER_SECRET_SEED for the Agent Service model calls")
	}
	models, err := roomagent.NewModelCallClient(cmp.Or(strings.TrimSpace(os.Getenv("TEAMHUB_NODE_SERVICES_URL")), "http://localhost:4319"), config.ServiceCredential(seed, "node-services-internal"))
	if err != nil {
		t.Fatal(err)
	}
	return NewHTTPGenerator(models, 90*time.Second)
}

func newTestGenerator(t *testing.T, agentServiceURL string) *HTTPGenerator {
	t.Helper()
	models, err := roomagent.NewModelCallClient(agentServiceURL, "test-key")
	if err != nil {
		t.Fatal(err)
	}
	return NewHTTPGenerator(models, time.Minute)
}

func writeModelCallOutput(response http.ResponseWriter, output string) {
	response.Header().Set("Content-Type", "application/json")
	_, _ = response.Write([]byte(`{"model":"codex","output":` + output + `}`))
}

func TestParseInsightDraftsRejectsExtraFieldsAndTrailingContent(t *testing.T) {
	for _, output := range []string{
		`{}`,
		`{"insights":null}`,
		`{"insights":[],"explanation":"none"}`,
		`{"insights":[]} trailing`,
		`{"insights":[{"dimension":"work patterns","basis":"explicit","statement":"x","evidence_ids":[],"confidence":1}]}`,
	} {
		if _, err := parseInsightDrafts([]byte(output)); err == nil {
			t.Fatalf("expected invalid output error for %q", output)
		}
	}
}

func TestInsightPromptDefinesOpenPersonalUnderstandingAndEvidenceThresholds(t *testing.T) {
	prompt := insightSystemPrompt()
	for _, required := range []string{
		"evidence-linked, correctable understanding",
		`An "aha" reaction is a possible result, never a reason to invent novelty`,
		"Choose a short, open dimension that fits the evidence",
		"These are not a template; do not fill categories",
		`Basis is "explicit", "reported", or "inferred"`,
		`Use "explicit" when an owner-attributable source directly states`,
		`Behavior visible in a self_sent message is never "explicit" merely because the user authored the message`,
		`never label behavior "explicit" to bypass that threshold`,
		`An "explicit" statement may contain only the personal proposition the source actually states`,
		`Do not use one explicit clause as an anchor to add an observed behavior`,
		`Use "reported" when an attributable direct_inbound message explicitly describes the user`,
		"at least two materially different contexts or recurring episodes",
		"grounded in at least one owner-attributable source",
		"inbound-only evidence can never establish an inferred Insight",
		"Messages to several employers during one active job search are one context",
		"They cannot establish a stable job-search strategy, relationship-maintenance habit, or communication style by themselves",
		"Brief, courteous, appreciative, or next-step-oriented messages within one recruiting or job-search episode",
		"does not establish proactive outreach or a relationship-maintenance pattern",
		"Automated content never proves what the user believes, prefers, read, or cares about",
		"identify who made the claim, whom it describes, which person or group it addresses, and the situation in which it applies",
		"A criterion listed for students, candidates, employees, or collaborators remains an expectation for that group",
		"Every candidate derived from criteria for another person or group must name both that group and the relevant selection, mentoring, or collaboration situation",
		"It is invalid to drop that scope and rewrite the criterion as a universal value, personal standard, or collaborator preference",
		"Do not combine claims about different people, groups, or situations",
		"A list of distinct selection criteria is not one Insight",
		"Stable identity, biography, role, research topics, publications, projects, awards, achievements, availability, recruiting, contact details, and invitations to collaborate belong to Profile",
		`Never emit "collaboration openness" from it unless a separate owner statement explains a specific, durable way the user prefers collaboration to work`,
		`Do not relabel those facts as Insight by saying they "signal", "suggest", "indicate", "reflect", or "demonstrate"`,
		"Current requests, commitments, deadlines, risks, alerts, interruptions, and completed actions belong to Todo/Issue",
		"Multiple applications in one job search do not establish that the user is proactive, strategic, or prefers a multi-channel search",
		"Never add a cause, motive, result, opposite, comparison, example, object, unit, or measurement",
		"Do not translate shorthand or metaphor into a more specific factual claim",
		"The statement is user-facing and may be shown unchanged",
		"Never write an instruction to an Agent or system",
		"Let output count and length follow the material",
		"specifically supported, useful for future collaboration, and distinct from Profile and Todo/Issue",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("Insight prompt missing quality boundary %q", required)
		}
	}
}

func TestInsightPromptUsesNaturalUserVisibleVoice(t *testing.T) {
	prompt := insightSystemPrompt()
	for _, required := range []string{
		`Never refer to the profile owner as "the user", "this user", "the profile owner", or by name in the statement`,
		"When writing Chinese, omit the profile-owner subject when the meaning remains clear",
		"begin with the specific situation, behavior, preference, or expectation",
		`Use "you" only when omitting the subject would make the statement ambiguous or unnatural`,
		"In languages that require an explicit subject, use natural direct address",
		"Never drop a grammatically required subject",
		"Never substitute a nearby group from another sentence or section for the source-stated group",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("Insight prompt missing user-visible voice rule %q", required)
		}
	}
}

func routeSyntheticFixture(t *testing.T) []emailevidence.WeightedEvidence {
	t.Helper()
	raw, err := os.ReadFile("../emailevidence/testdata/synthetic_gmail_generation.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Messages []emailevidence.MessageInput `json:"messages"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return routeForTest(t, fixture.Messages)
}

func routeForTest(t *testing.T, inputs []emailevidence.MessageInput) []emailevidence.WeightedEvidence {
	t.Helper()
	classified, err := emailevidence.Classify(inputs)
	if err != nil {
		t.Fatal(err)
	}
	return emailevidence.InsightEvidence(classified)
}
