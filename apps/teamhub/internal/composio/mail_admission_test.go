package composio

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFilteredSenderMatchesNoReplyAndNotificationAddresses(t *testing.T) {
	for from, want := range map[string]bool{
		"GitHub <notifications@github.com>":           true,
		"Google <no-reply@accounts.google.com>":       true,
		"LinkedIn <jobs-noreply@linkedin.com>":        true,
		"Calendar <calendar-notification@google.com>": true,
		"Notifier <notifier@example.test>":            false,
		"Mail Delivery <mailer-daemon@example.test>":  true,
		"noreply@example.test":                        true,
		"Bank <donotreply@bank.example>":              true,
		"Relay <user@users.noreply.github.com>":       true,
		"Notify <notify+team@example.test>":           true,
		"Bob <bob@example.test>":                      false,
		"Ann <notification.design@studio.example>":    true,
		"Reply Team <reply@example.test>":             false,
		"Snorer <snoreply@example.test>":              false,
		"News <news@example.test>":                    false,
	} {
		if got := filteredSender(from); got != want {
			t.Errorf("filteredSender(%q)=%v, want %v", from, got, want)
		}
	}
}

func TestWithoutLinkTrackingKeepsLinksAndDropsTheirTracking(t *testing.T) {
	token := strings.Repeat("Ab3", 12)
	for body, want := range map[string]string{
		"Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter today.": "Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ today.",
		"Open https://t.example.test/r/?id=" + token + "&s=" + token + ".":               "Open https://t.example.test/r/.",
		"Doc: https://docs.example.test/d/abc/edit?usp=sharing#heading=h.1":              "Doc: https://docs.example.test/d/abc/edit?usp=sharing#heading=h.1",
		"(https://example.test/a?b=1&fbclid=XYZ)":                                        "(https://example.test/a?b=1)",
		"https://example.test/path":                                                      "https://example.test/path",
		"Plain text with no link stays.":                                                 "Plain text with no link stays.",
		"https://example.test/?gclid=1&UTM_Campaign=x":                                   "https://example.test/",
	} {
		if got := withoutLinkTracking(body); got != want {
			t.Errorf("withoutLinkTracking(%q)=\n%q, want\n%q", body, got, want)
		}
	}
}

func TestGmailMailImportFiltersSendersWithoutReadingTheirBodies(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	bodyReads := 0
	client := mailImportClient(t, func(request proxyRequest) any {
		if request.Endpoint == "/gmail/v1/users/me/messages" {
			return map[string]any{"messages": []any{map[string]string{"id": "human"}, map[string]string{"id": "robot"}, map[string]string{"id": "mine"}}}
		}
		id := strings.TrimPrefix(request.Endpoint, "/gmail/v1/users/me/messages/")
		if strings.Contains(id, "/attachments/") {
			bodyReads++
			return map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte("Hydrated body."))}
		}
		from, labels := "Bob <bob@example.test>", []string{"INBOX"}
		switch id {
		case "robot":
			from = "Service <no-reply@service.example>"
		case "mine":
			// The owner's own mail enters whatever its address looks like.
			from, labels = "Me <noreply-alias@example.test>", []string{"SENT"}
		}
		part := map[string]any{"mimeType": "text/plain", "body": map[string]string{"attachmentId": "body-" + id}}
		return map[string]any{"id": id, "threadId": id, "internalDate": strconv.FormatInt(end.Add(-time.Hour).UnixMilli(), 10), "labelIds": labels,
			"payload": map[string]any{"mimeType": "multipart/alternative", "headers": []any{map[string]string{"name": "From", "value": from}, map[string]string{"name": "Subject", "value": "About " + id}}, "parts": []any{part}}}
	})
	page, err := client.FetchMailImportPage(context.Background(), "account", "gmail", MailImportPageOptions{Start: MailImportStart(end), End: end, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if page.Read != 3 || len(page.Documents) != 2 || page.Documents[0].RemoteID != "message:human" || page.Documents[1].RemoteID != "message:mine" {
		t.Fatalf("documents=%+v", page.Documents)
	}
	if bodyReads != 2 {
		t.Fatalf("read %d bodies, want only the two admitted ones", bodyReads)
	}
}

func TestOutlookMailImportKeepsFocusedAndOwnMail(t *testing.T) {
	end := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	item := func(id, from, classification string) map[string]any {
		return map[string]any{"id": id, "subject": "Re " + id, "receivedDateTime": end.Add(-time.Hour).Format(time.RFC3339), "parentFolderId": "inbox",
			"inferenceClassification": classification, "from": map[string]any{"emailAddress": map[string]string{"address": from}},
			"body": map[string]string{"contentType": "text", "content": fmt.Sprintf("Body of %s.", id)}}
	}
	client := mailImportClient(t, func(request proxyRequest) any {
		switch request.Endpoint {
		case "https://graph.microsoft.com/v1.0/me":
			return map[string]string{"id": "alice", "mail": "alice@example.test"}
		case "/v1.0/me/mailFolders/junkemail":
			return map[string]string{"id": "junk"}
		case "/v1.0/me/mailFolders/deleteditems":
			return map[string]string{"id": "trash"}
		}
		for _, p := range request.Parameters {
			if p.Name == "$select" && !strings.Contains(fmt.Sprint(p.Value), "inferenceClassification") {
				t.Errorf("$select=%v", p.Value)
			}
		}
		return map[string]any{"value": []any{
			item("focused", "bob@example.test", "focused"),
			item("other", "carol@example.test", "other"),
			item("sent", "alice@example.test", "other"),
			item("robot", "notifications@service.example", "focused"),
		}}
	})
	page, err := client.FetchMailImportPage(context.Background(), "account", "outlook", MailImportPageOptions{Start: MailImportStart(end), End: end, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if page.Read != 4 || page.Skipped != 0 || len(page.Documents) != 2 || page.Documents[0].RemoteID != "message:focused" || page.Documents[1].RemoteID != "message:sent" {
		t.Fatalf("page=%+v", page)
	}
}
