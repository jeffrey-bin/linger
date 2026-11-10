package composio

import (
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The Wiki whitelist for imported mail. Both the Wiki and the Profile read
// only what it admits: Gmail's Primary category and the owner's sent mail,
// or Outlook's Focused inbox, without no-reply or notification senders.
// Mail it keeps out is not imported and leaves no record.

var (
	noReplySender      = regexp.MustCompile(`(^|[^a-z0-9])(no[-_.]?reply|do[-_.]?not[-_.]?reply)`)
	notificationSender = regexp.MustCompile(`(^|[^a-z0-9])(notifications?|notify)([^a-z0-9]|$)|^(mailer[-_.]?daemon|postmaster)([^a-z0-9]|$)`)
)

// filteredSender reports a no-reply address, or a notification one by its
// local part, in a From header.
func filteredSender(from string) bool {
	address := strings.TrimSpace(from)
	if parsed, err := mail.ParseAddress(from); err == nil {
		address = parsed.Address
	}
	address = strings.ToLower(address)
	local, _, _ := strings.Cut(address, "@")
	return noReplySender.MatchString(address) || notificationSender.MatchString(local)
}

var (
	mailLink          = regexp.MustCompile(`https?://[^\s<>()"'\[\]]+`)
	trackingParameter = regexp.MustCompile(`^(utm_.+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|trk|igshid|yclid|ttclid|_ga|_gl|spm)$`)
)

// maxLinkParameterRunes bounds a query value worth keeping: a longer one is
// an opaque click token, while short identifiers such as video IDs stay.
const maxLinkParameterRunes = 24

// withoutLinkTracking drops the click-tracking parameters from every link in
// a mail body: tracking keys and opaque values. The rest of each link and all
// other text stay.
func withoutLinkTracking(body string) string {
	return mailLink.ReplaceAllStringFunc(body, func(link string) string {
		trimmed := strings.TrimRight(link, ".,;:!?")
		address, query, found := strings.Cut(trimmed, "?")
		if !found {
			return link
		}
		query, fragment, hasFragment := strings.Cut(query, "#")
		kept := make([]string, 0)
		for _, parameter := range strings.Split(query, "&") {
			key, value, _ := strings.Cut(parameter, "=")
			if decoded, err := url.QueryUnescape(key); err == nil {
				key = decoded
			}
			if decoded, err := url.QueryUnescape(value); err == nil {
				value = decoded
			}
			if parameter == "" || trackingParameter.MatchString(strings.ToLower(key)) || utf8.RuneCountInString(value) > maxLinkParameterRunes {
				continue
			}
			kept = append(kept, parameter)
		}
		if len(kept) > 0 {
			address += "?" + strings.Join(kept, "&")
		}
		if hasFragment {
			address += "#" + fragment
		}
		return address + link[len(trimmed):]
	})
}
