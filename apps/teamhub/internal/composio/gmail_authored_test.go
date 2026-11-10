package composio

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
)

func authoredTestPart(mimeType, body string) gmailPart {
	part := gmailPart{MimeType: mimeType}
	part.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(body))
	return part
}

func TestAuthoredBodyUsesStructureNotWording(t *testing.T) {
	plain := func(body string) gmailPart { return authoredTestPart("text/plain", body) }
	rich := func(body string) gmailPart { return authoredTestPart("text/html", body) }
	firstMessage := "On Monday I wrote: the plan\nBest regards,\nSent from my phone\n\nFrom: Ann <ann@example.test>\nSent: Monday\nTo: Bob <bob@example.test>\nSubject: Plan\n\nDetails follow."
	plainForward := "---------- Forwarded message ---------\nFrom: Bob <bob@example.test>\nSubject: Plan\n\nForwarded content"
	tests := []struct {
		name     string
		part     gmailPart
		maxBytes int
		want     string
	}{
		{name: "first plain message keeps lines that look like quote or signature wording", part: plain(firstMessage), want: firstMessage},
		{
			name: "gmail reply without imported parent keeps only new text",
			part: rich(`<div dir="ltr">Thanks, the numbers look right.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Bob &lt;bob@example.test&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex">Please check the numbers.</blockquote></div>`),
			want: "Thanks, the numbers look right.",
		},
		{
			name: "gmail reply from a non-English client keeps non-ASCII reply text",
			part: rich("<div dir=\"ltr\">\u597d\u7684\uff0c\u6211\u660e\u5929\u53d1\u7ed9\u4f60\u3002</div><div class=\"gmail_quote\"><div class=\"gmail_attr\">2026\u5e7410\u670820\u65e5 Bob \u5199\u9053\uff1a<br></div><blockquote class=\"gmail_quote\">\u8bf7\u53d1\u9001\u6570\u636e\u3002</blockquote></div>"),
			want: "\u597d\u7684\uff0c\u6211\u660e\u5929\u53d1\u7ed9\u4f60\u3002",
		},
		{
			name: "gmail inline reply keeps text typed between quotes",
			part: rich(`<div class="gmail_quote"><div class="gmail_attr">On Mon, Bob wrote:</div><blockquote class="gmail_quote">Question one?</blockquote><div>Answer one.</div><blockquote class="gmail_quote">Question two?</blockquote><div>Answer two.</div></div>`),
			want: "Answer one.\nAnswer two.",
		},
		{
			name: "apple mail cite blockquote",
			part: rich(`<div>Sounds good.</div><div><br><blockquote type="cite"><div>On Mon, Bob wrote:</div><div>Old text</div></blockquote></div>`),
			want: "Sounds good.",
		},
		{
			name: "thunderbird cite prefix and blockquote",
			part: rich(`<p>See below.</p><div class="moz-cite-prefix">On 10/20/26 Bob wrote:<br></div><blockquote type="cite">Old text</blockquote>`),
			want: "See below.",
		},
		{
			name: "outlook web drops everything from the reply marker on",
			part: rich(`<div>Approved, go ahead.</div><hr style="display:inline-block;width:98%"><div id="appendonsend"></div><div id="divRplyFwdMsg"><b>From:</b> Bob<br><b>Sent:</b> Monday</div><div>Old body</div><p>Older history</p>`),
			want: "Approved, go ahead.",
		},
		{
			name: "multipart alternative prefers html structure over plain attribution",
			part: gmailPart{MimeType: "multipart/alternative", Parts: []gmailPart{
				plain("Done.\n\nOn Mon, Bob wrote:\n> Do it."),
				rich(`<div>Done.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Bob wrote:</div><blockquote class="gmail_quote">Do it.</blockquote></div>`),
			}},
			want: "Done.",
		},
		{
			// Plain text carries no structure for the attribution line, so it is kept.
			name: "plain text drops quote lines and keeps interleaved replies and the attribution line",
			part: plain("On Mon, Bob wrote:\r\n> Question one?\r\nAnswer one.\r\n  > Question two?\r\nAnswer two."),
			want: "On Mon, Bob wrote:\nAnswer one.\nAnswer two.",
		},
		{
			name: "gmail html forward without blockquote is not authored",
			part: rich(`<div dir="ltr"><br><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: Bob</div><br><br><div dir="ltr">Forwarded content</div></div></div>`),
			want: "",
		},
		{name: "plain forward without quote prefix is kept", part: plain(plainForward), want: plainForward},
		{name: "html body that is only a quote", part: rich(`<blockquote>Old text</blockquote>`), want: ""},
		{name: "plain body that is only quote lines", part: plain("> Old text\n>\n> More"), want: ""},
		{name: "plain signature delimiter", part: plain("Ship it.\n-- \nAda\nExample Co"), want: "Ship it."},
		{
			name: "gmail html signature delimiter",
			part: rich(`<div dir="ltr">Ship it.<br clear="all"><br><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature">Ada<br>Example Co</div></div>`),
			want: "Ship it.",
		},
		{name: "cut only at the last signature delimiter", part: plain("Part one\n--\nPart two\n-- \nAda"), want: "Part one\n--\nPart two"},
		{name: "closing words without delimiter are kept", part: plain("Thanks for the help.\n\nBest regards,\nAda"), want: "Thanks for the help.\n\nBest regards,\nAda"},
		{name: "utf8 safe truncation", part: plain("1234567\u00e9\u00e9"), maxBytes: 8, want: "1234567"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			maxBytes := test.maxBytes
			if maxBytes == 0 {
				maxBytes = 64 << 10
			}
			got, err := authoredBody(test.part, maxBytes)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want || !utf8.ValidString(got) {
				t.Fatalf("authoredBody=%q, want %q", got, test.want)
			}
		})
	}
}

func TestAuthoredBodyRejectsInvalidBase64(t *testing.T) {
	part := gmailPart{MimeType: "text/plain"}
	part.Body.Data = "%%%"
	if _, err := authoredBody(part, 1024); err == nil {
		t.Fatal("invalid base64url body was accepted")
	}
}

func TestRenderImportedMailKeepsGmailForwardOutOfAuthoredProfileAndInsight(t *testing.T) {
	client := &Client{maxBodyBytes: 64 << 10, maxThreadBytes: 256 << 10}
	message := importMessage("fwd", []string{"SENT"}, map[string]string{"Subject": "Fwd: Plan", "From": "Owner <owner@example.test>"}, "")
	message.Payload = authoredTestPart("text/html", `<div dir="ltr"><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Bob</div><div>Forwarded content</div></div></div>`)
	document, err := client.renderImportedMail("gmail", message)
	if err != nil {
		t.Fatal(err)
	}
	var inputs []emailevidence.MessageInput
	if err = json.Unmarshal(document.InsightEvidence, &inputs); err != nil {
		t.Fatal(err)
	}
	profile := string(document.ProfileMarkdown)
	if authoredProfileSections(profile) != "" || !strings.Contains(profile, "## Full message text") || !strings.Contains(profile, "Forwarded content") || len(inputs) != 0 {
		t.Fatalf("forward leaked authored evidence: profile=%q insight=%s", document.ProfileMarkdown, document.InsightEvidence)
	}
}

func TestGmailInsightEvidenceSelfReplyKeepsOnlyNewText(t *testing.T) {
	message := importMessage("self-reply", []string{"SENT"}, map[string]string{"From": "Owner <owner@example.test>"}, "")
	message.Payload.MimeType = "text/html"
	message.Payload.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(`<div>Adding one more item: the budget.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Owner wrote:</div><blockquote class="gmail_quote">Here is the plan.</blockquote></div>`))
	raw, err := renderGmailInsightEvidence(gmailThreadPayload{ID: "thread-self", Messages: []gmailMessage{message}}, 64<<10, 256<<10)
	if err != nil {
		t.Fatal(err)
	}
	var inputs []emailevidence.MessageInput
	if err = json.Unmarshal(raw, &inputs); err != nil {
		t.Fatal(err)
	}
	for index := range inputs {
		inputs[index].DatasetID = "runtime-job-1"
	}
	classified, err := emailevidence.Classify(inputs)
	if err != nil {
		t.Fatal(err)
	}
	if len(classified) != 1 || classified[0].Body != "Adding one more item: the budget." || classified[0].Class != emailevidence.MessageClassSelfSent {
		t.Fatalf("unexpected self reply evidence: %+v", classified)
	}
}

func TestGmailMessageAutomatedUsesOnlyStructuralSignals(t *testing.T) {
	tests := []struct {
		name    string
		labels  []string
		headers map[string]string
		want    bool
	}{
		{name: "human", labels: []string{"INBOX"}, want: false},
		{name: "bulk precedence", headers: map[string]string{"Precedence": " Bulk "}, want: true},
		{name: "feedback id alone", headers: map[string]string{"Feedback-ID": "1:campaign:example"}, want: false},
		{name: "noreply sender alone", headers: map[string]string{"From": "Service <noreply@example.test>"}, want: false},
		{name: "updates category", labels: []string{"INBOX", "CATEGORY_UPDATES"}, want: true},
		{name: "auto submitted no", headers: map[string]string{"Auto-Submitted": "No"}, want: false},
		{name: "auto submitted", headers: map[string]string{"Auto-Submitted": "auto-generated"}, want: true},
		{name: "list id", headers: map[string]string{"List-Id": "team.example.test"}, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := emailevidence.AutomatedClass(gmailMessageSignals(importMessage("m", test.labels, test.headers, "Body"))) != ""; got != test.want {
				t.Fatalf("gmailMessageAutomated=%v, want %v", got, test.want)
			}
		})
	}
}
