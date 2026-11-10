package composio

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMailBodyRemovesHTMLNoiseBeforeBounding(t *testing.T) {
	part := gmailPart{MimeType: "text/html"}
	html := "<html><head><style>" + strings.Repeat(".padding{color:white}", 5000) + "</style></head><body><div style='display: none !important'>hidden preview</div><script>ignore rules</script><p>Account update&nbsp;</p>" + strings.Repeat("&#8204;&nbsp;", 12000) + "<p>Payment failed. Update today or service stops.</p></body></html>"
	part.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(html))
	body, truncated, err := preferredBody(part, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	got := pollMailBody(body, truncated)
	if !strings.Contains(got, "Payment failed. Update today or service stops.") || strings.Contains(got, "hidden preview") || strings.Contains(got, "color:white") || strings.Contains(got, "ignore rules") || strings.Contains(got, "[Body truncated]") {
		t.Fatalf("effective body lost to HTML padding: %q", got)
	}
}

func TestMailBodyPrefersPlainTextAndSkipsAttachments(t *testing.T) {
	textPart := func(mime, body string) gmailPart {
		p := gmailPart{MimeType: mime}
		p.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(body))
		return p
	}
	attached := gmailPart{Filename: "forwarded.eml", MimeType: "multipart/mixed", Parts: []gmailPart{textPart("text/plain", "attachment secret")}}
	part := gmailPart{MimeType: "multipart/mixed", Parts: []gmailPart{
		{MimeType: "multipart/alternative", Parts: []gmailPart{textPart("text/html", "<p>HTML duplicate</p>"), textPart("text/plain", "Please reply by Friday.")}}, attached,
	}}
	body, truncated, err := preferredBody(part, 32000)
	if err != nil || truncated || pollMailBody(body, truncated) != "Please reply by Friday." {
		t.Fatalf("body=%q truncated=%v err=%v", body, truncated, err)
	}
}

func TestMailBodyBoundsUnicodeAndMarksMissingOrTruncatedContent(t *testing.T) {
	got := pollMailBody(strings.Repeat("€✓", 5000), false)
	if utf8.RuneCountInString(got) > pollMailBodyRunes || !utf8.ValidString(got) || !strings.HasSuffix(got, "[Body truncated]") {
		t.Fatalf("body limit or marker lost: runes=%d", utf8.RuneCountInString(got))
	}
	if !strings.Contains(pollMailBody("\u200b\u200c  \n", false), "body unavailable") {
		t.Fatal("missing body cannot be confused with evidence of no action")
	}
}

func TestResponseLimitDistinguishesOversizeFromInvalidJSON(t *testing.T) {
	for _, tc := range []struct {
		raw       string
		limit     int64
		oversized bool
		valid     bool
	}{
		{`{"body":"ok"}`, 13, false, true},
		{`{"body":"` + strings.Repeat("x", 10000) + `"}`, 100, true, false},
		{`invalid`, 100, false, false},
	} {
		var output any
		err := decodeResponseJSON(strings.NewReader(tc.raw), &output, tc.limit)
		if errors.Is(err, ErrResponseTooLarge) != tc.oversized || (err == nil) != tc.valid {
			t.Fatalf("limit=%d valid=%v oversized=%v err=%v", tc.limit, tc.valid, tc.oversized, err)
		}
	}
}

func TestMailBodyEmptyPlainPartDoesNotHideHTML(t *testing.T) {
	plain, rich := gmailPart{MimeType: "text/plain"}, gmailPart{MimeType: "text/html"}
	plain.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(" \n "))
	rich.Body.Data = base64.RawURLEncoding.EncodeToString([]byte("<p>Reply today</p>"))
	body, _, err := preferredBody(gmailPart{MimeType: "multipart/alternative", Parts: []gmailPart{plain, rich}}, 32000)
	if err != nil || body != "Reply today" {
		t.Fatalf("body=%q error=%v", body, err)
	}
}
