package composio

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

const pollMailBodyRunes = 8000
const oversizedMailBody = "[Message body unavailable: provider response exceeded the read limit. Only headers are available.]"

// pollMailBody bounds the cleaned body, not the provider's short preview.
func pollMailBody(body string, truncated bool) string {
	body = pollTextBody(body, truncated)
	if body == "" {
		return "[Message body unavailable; do not infer that no action is needed.]"
	}
	return body
}

func pollTextBody(body string, truncated bool) string {
	body = strings.Map(func(r rune) rune {
		switch r {
		case '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad':
			return -1
		}
		return r
	}, body)
	var lines []string
	for _, line := range strings.Split(body, "\n") {
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			lines = append(lines, line)
		}
	}
	body = strings.Join(lines, "\n")
	const marker = "\n[Body truncated]"
	runes := []rune(body)
	if len(runes) > pollMailBodyRunes-len(marker) {
		body = string(runes[:pollMailBodyRunes-len(marker)])
		truncated = true
	}
	if truncated {
		body += marker
	}
	return body
}

// ReadOutlookMessageBody fetches only the message body, not attachments. A 404
// means the message disappeared; other failures must preserve the poll cursor.
func (c *Client) ReadOutlookMessageBody(ctx context.Context, accountID, messageID string) (string, bool, error) {
	var wire struct {
		Body struct {
			ContentType string `json:"contentType"`
			Content     string `json:"content"`
		} `json:"body"`
	}
	err := c.proxy(ctx, proxyRequest{
		ConnectedAccountID: accountID,
		Endpoint:           "/v1.0/me/messages/" + url.PathEscape(messageID),
		Method:             http.MethodGet,
		Parameters:         []proxyParameter{{Name: "$select", Value: "body", Type: "query"}},
	}, &wire, "read Outlook message body")
	if err != nil {
		if errors.Is(err, ErrResponseTooLarge) {
			return oversizedMailBody, true, nil
		}
		var remote *remoteError
		if errors.As(err, &remote) && remote.status == http.StatusNotFound {
			return "", false, nil
		}
		return "", false, err
	}
	body := wire.Body.Content
	if strings.EqualFold(wire.Body.ContentType, "html") {
		body = htmlText(body)
	}
	return pollMailBody(body, false), true, nil
}

// Gmail can store a text body outside messages.get. Only hydrate inline body
// parts; an attached document (even text/plain) is not the message body.
func (c *Client) hydrateGmailPollBody(ctx context.Context, accountID, messageID string, part *gmailPart) (bool, error) {
	if part.Filename != "" || strings.Contains(strings.ToLower(header(*part, "Content-Disposition")), "attachment") {
		return false, nil
	}
	oversized := false
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(part.MimeType, ";")[0]))
	if (mediaType == "text/plain" || mediaType == "text/html") && part.Body.Data == "" && part.Body.AttachmentID != "" {
		var wire struct {
			Data string `json:"data"`
		}
		err := c.proxy(ctx, proxyRequest{ConnectedAccountID: accountID,
			Endpoint: "/gmail/v1/users/me/messages/" + url.PathEscape(messageID) + "/attachments/" + url.PathEscape(part.Body.AttachmentID),
			Method:   http.MethodGet}, &wire, "read Gmail text body")
		if errors.Is(err, ErrResponseTooLarge) {
			oversized = true
		} else if err != nil {
			var remote *remoteError
			if !errors.As(err, &remote) || remote.status != http.StatusNotFound {
				return false, err
			}
		} else {
			part.Body.Data = wire.Data
		}
		// Missing/oversized parts stay empty so a readable alternative can win.
	}
	for i := range part.Parts {
		large, err := c.hydrateGmailPollBody(ctx, accountID, messageID, &part.Parts[i])
		if err != nil {
			return false, err
		}
		oversized = oversized || large
	}
	return oversized, nil
}
