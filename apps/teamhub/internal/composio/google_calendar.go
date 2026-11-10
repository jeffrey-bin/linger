package composio

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type GoogleCalendarIdentity struct {
	CalendarID, Label, TimeZone string
}

type GoogleCalendar struct {
	ID, Summary, TimeZone, AccessRole string
	Primary, Selected                 bool
}

type GoogleCalendarPage struct {
	Calendars     []GoogleCalendar
	NextPageToken string
}

type GoogleCalendarPerson struct {
	ID, Email, DisplayName, ResponseStatus string
	Self, Organizer, Optional, Resource    bool
}

type GoogleCalendarEvent struct {
	ID, ICalUID, Status, Summary, Description, Location, SourceURL  string
	HangoutLink, EventType, Visibility, RecurringEventID            string
	StartDate, StartDateTime, StartTimeZone                         string
	EndDate, EndDateTime, EndTimeZone                               string
	OriginalStartDate, OriginalStartDateTime, OriginalStartTimeZone string
	CreatedAt, UpdatedAt                                            time.Time
	Creator, Organizer                                              GoogleCalendarPerson
	Attendees                                                       []GoogleCalendarPerson
	Recurrence                                                      []string
	Attachments                                                     []GoogleCalendarAttachment
}

type GoogleCalendarAttachment struct {
	ID, Title, URL string
}

type GoogleCalendarEventPage struct {
	Events        []GoogleCalendarEvent
	NextPageToken string
}

func (c *Client) IdentifyGoogleCalendar(ctx context.Context, connectedAccountID string) (GoogleCalendarIdentity, error) {
	var wire struct {
		ID       string `json:"id"`
		Summary  string `json:"summary"`
		TimeZone string `json:"timeZone"`
		Primary  bool   `json:"primary"`
	}
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: "/users/me/calendarList/primary", Method: http.MethodGet}, &wire, "identify Google Calendar account"); err != nil {
		return GoogleCalendarIdentity{}, err
	}
	if wire.ID == "" || !wire.Primary {
		return GoogleCalendarIdentity{}, errors.New("Google Calendar identity response was incomplete")
	}
	label := strings.TrimSpace(wire.Summary)
	if label == "" {
		label = wire.ID
	}
	return GoogleCalendarIdentity{CalendarID: wire.ID, Label: label, TimeZone: wire.TimeZone}, nil
}

func (c *Client) ListGoogleCalendars(ctx context.Context, connectedAccountID, pageToken string, limit int) (GoogleCalendarPage, error) {
	if limit < 1 || limit > 250 {
		return GoogleCalendarPage{}, errors.New("invalid Google Calendar list request")
	}
	parameters := []proxyParameter{
		{Name: "maxResults", Value: strconv.Itoa(limit), Type: "query"},
		{Name: "minAccessRole", Value: "reader", Type: "query"},
		{Name: "showDeleted", Value: "false", Type: "query"},
		{Name: "showHidden", Value: "false", Type: "query"},
	}
	if pageToken != "" {
		parameters = append(parameters, proxyParameter{Name: "pageToken", Value: pageToken, Type: "query"})
	}
	var wire struct {
		Items []struct {
			ID         string `json:"id"`
			Summary    string `json:"summary"`
			TimeZone   string `json:"timeZone"`
			AccessRole string `json:"accessRole"`
			Primary    bool   `json:"primary"`
			Selected   bool   `json:"selected"`
		} `json:"items"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: "/users/me/calendarList", Method: http.MethodGet, Parameters: parameters}, &wire, "list Google calendars"); err != nil {
		return GoogleCalendarPage{}, err
	}
	page := GoogleCalendarPage{NextPageToken: wire.NextPageToken}
	for _, item := range wire.Items {
		if item.ID == "" || strings.TrimSpace(item.Summary) == "" || !readableGoogleCalendarRole(item.AccessRole) {
			return GoogleCalendarPage{}, errors.New("Google Calendar list response was incomplete")
		}
		page.Calendars = append(page.Calendars, GoogleCalendar{ID: item.ID, Summary: item.Summary, TimeZone: item.TimeZone, AccessRole: item.AccessRole, Primary: item.Primary, Selected: item.Selected})
	}
	return page, nil
}

func readableGoogleCalendarRole(role string) bool {
	return role == "reader" || role == "writer" || role == "owner"
}

func (c *Client) ListGoogleCalendarEvents(ctx context.Context, connectedAccountID, calendarID, pageToken string, start, end time.Time, limit int) (GoogleCalendarEventPage, error) {
	if calendarID == "" || limit < 1 || limit > 2500 || !start.Before(end) {
		return GoogleCalendarEventPage{}, errors.New("invalid Google Calendar event request")
	}
	parameters := []proxyParameter{
		{Name: "maxResults", Value: strconv.Itoa(limit), Type: "query"},
		{Name: "timeMin", Value: start.UTC().Format(time.RFC3339), Type: "query"},
		{Name: "timeMax", Value: end.UTC().Format(time.RFC3339), Type: "query"},
		{Name: "singleEvents", Value: "true", Type: "query"},
		{Name: "showDeleted", Value: "true", Type: "query"},
		{Name: "orderBy", Value: "startTime", Type: "query"},
	}
	if pageToken != "" {
		parameters = append(parameters, proxyParameter{Name: "pageToken", Value: pageToken, Type: "query"})
	}
	var wire googleCalendarEventsWire
	endpoint := "/calendars/" + url.PathEscape(calendarID) + "/events"
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet, Parameters: parameters}, &wire, "list Google Calendar events"); err != nil {
		return GoogleCalendarEventPage{}, err
	}
	page := GoogleCalendarEventPage{NextPageToken: wire.NextPageToken}
	for _, item := range wire.Items {
		event, err := normalizeGoogleCalendarEvent(item)
		if err != nil {
			return GoogleCalendarEventPage{}, err
		}
		page.Events = append(page.Events, event)
	}
	return page, nil
}

type googleCalendarEventsWire struct {
	Items         []googleCalendarEventWire `json:"items"`
	NextPageToken string                    `json:"nextPageToken"`
}

type googleCalendarDateWire struct {
	Date     string `json:"date"`
	DateTime string `json:"dateTime"`
	TimeZone string `json:"timeZone"`
}

type googleCalendarPersonWire struct {
	ID             string `json:"id"`
	Email          string `json:"email"`
	DisplayName    string `json:"displayName"`
	ResponseStatus string `json:"responseStatus"`
	Self           bool   `json:"self"`
	Organizer      bool   `json:"organizer"`
	Optional       bool   `json:"optional"`
	Resource       bool   `json:"resource"`
}

type googleCalendarEventWire struct {
	ID                string                     `json:"id"`
	ICalUID           string                     `json:"iCalUID"`
	Status            string                     `json:"status"`
	Summary           string                     `json:"summary"`
	Description       string                     `json:"description"`
	Location          string                     `json:"location"`
	HTMLLink          string                     `json:"htmlLink"`
	HangoutLink       string                     `json:"hangoutLink"`
	EventType         string                     `json:"eventType"`
	Visibility        string                     `json:"visibility"`
	RecurringEventID  string                     `json:"recurringEventId"`
	Created           string                     `json:"created"`
	Updated           string                     `json:"updated"`
	Start             googleCalendarDateWire     `json:"start"`
	End               googleCalendarDateWire     `json:"end"`
	OriginalStartTime googleCalendarDateWire     `json:"originalStartTime"`
	Creator           googleCalendarPersonWire   `json:"creator"`
	Organizer         googleCalendarPersonWire   `json:"organizer"`
	Attendees         []googleCalendarPersonWire `json:"attendees"`
	Recurrence        []string                   `json:"recurrence"`
	Attachments       []struct {
		FileID  string `json:"fileId"`
		Title   string `json:"title"`
		FileURL string `json:"fileUrl"`
	} `json:"attachments"`
}

func normalizeGoogleCalendarEvent(item googleCalendarEventWire) (GoogleCalendarEvent, error) {
	if item.ID == "" || item.Status == "" {
		return GoogleCalendarEvent{}, errors.New("Google Calendar event response was incomplete")
	}
	createdAt, err := parseOptionalRFC3339(item.Created)
	if err != nil {
		return GoogleCalendarEvent{}, err
	}
	updatedAt, err := parseOptionalRFC3339(item.Updated)
	if err != nil {
		return GoogleCalendarEvent{}, err
	}
	event := GoogleCalendarEvent{
		ID: item.ID, ICalUID: item.ICalUID, Status: item.Status, Summary: item.Summary, Description: item.Description, Location: item.Location,
		SourceURL: item.HTMLLink, HangoutLink: item.HangoutLink, EventType: item.EventType, Visibility: item.Visibility, RecurringEventID: item.RecurringEventID,
		StartDate: item.Start.Date, StartDateTime: item.Start.DateTime, StartTimeZone: item.Start.TimeZone,
		EndDate: item.End.Date, EndDateTime: item.End.DateTime, EndTimeZone: item.End.TimeZone,
		OriginalStartDate: item.OriginalStartTime.Date, OriginalStartDateTime: item.OriginalStartTime.DateTime, OriginalStartTimeZone: item.OriginalStartTime.TimeZone,
		CreatedAt: createdAt, UpdatedAt: updatedAt, Creator: normalizeGoogleCalendarPerson(item.Creator), Organizer: normalizeGoogleCalendarPerson(item.Organizer), Recurrence: append([]string(nil), item.Recurrence...),
	}
	for _, attendee := range item.Attendees {
		event.Attendees = append(event.Attendees, normalizeGoogleCalendarPerson(attendee))
	}
	for _, attachment := range item.Attachments {
		event.Attachments = append(event.Attachments, GoogleCalendarAttachment{ID: attachment.FileID, Title: attachment.Title, URL: attachment.FileURL})
	}
	return event, nil
}

func normalizeGoogleCalendarPerson(person googleCalendarPersonWire) GoogleCalendarPerson {
	return GoogleCalendarPerson(person)
}

func parseOptionalRFC3339(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, errors.New("Google Calendar timestamp was invalid")
	}
	return parsed.UTC(), nil
}

func RenderGoogleCalendarDocumentsWithLimits(identity GoogleCalendarIdentity, calendars map[string]GoogleCalendar, events map[string][]GoogleCalendarEvent, limits AppImportLimits) ([]AppDocument, error) {
	type groupKey struct{ calendarID, day string }
	grouped := map[groupKey][]GoogleCalendarEvent{}
	for calendarID, calendarEvents := range events {
		calendar, ok := calendars[calendarID]
		if !ok {
			return nil, errors.New("Google Calendar event did not match a selected calendar")
		}
		for _, event := range calendarEvents {
			day, err := googleCalendarEventDay(event, calendar.TimeZone)
			if err != nil {
				return nil, err
			}
			grouped[groupKey{calendarID: calendarID, day: day}] = append(grouped[groupKey{calendarID: calendarID, day: day}], event)
		}
	}
	keys := make([]groupKey, 0, len(grouped))
	for key := range grouped {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].calendarID+keys[i].day < keys[j].calendarID+keys[j].day })
	documents := make([]AppDocument, 0, len(keys))
	renderedTotal := 0
	for _, key := range keys {
		calendar := calendars[key.calendarID]
		output := newAppDocumentBuilder(limits, &renderedTotal)
		_, _ = fmt.Fprintf(output, "# Google Calendar %s - %s\n\n- Connected identity: %s\n- Calendar: %s\n- Calendar timezone: %s\n- Local date: %s\n\n", safeAppText(calendar.Summary), key.day, safeAppText(identity.Label), safeAppText(calendar.Summary), safeAppText(calendar.TimeZone), key.day)
		for _, event := range grouped[key] {
			title := strings.TrimSpace(event.Summary)
			if title == "" {
				title = "Untitled event"
			}
			_, _ = fmt.Fprintf(output, "## %s\n\n- Event ID: %s\n- Status: %s\n- Start: %s\n- End: %s\n", safeAppText(title), safeAppText(event.ID), safeAppText(event.Status), safeAppText(calendarEventTime(event.StartDate, event.StartDateTime, event.StartTimeZone)), safeAppText(calendarEventTime(event.EndDate, event.EndDateTime, event.EndTimeZone)))
			if event.ICalUID != "" {
				_, _ = fmt.Fprintf(output, "- iCal UID: %s\n", safeAppText(event.ICalUID))
			}
			if event.EventType != "" {
				_, _ = fmt.Fprintf(output, "- Event type: %s\n", safeAppText(event.EventType))
			}
			if event.Visibility != "" {
				_, _ = fmt.Fprintf(output, "- Visibility: %s\n", safeAppText(event.Visibility))
			}
			if event.RecurringEventID != "" {
				_, _ = fmt.Fprintf(output, "- Recurring event ID: %s\n", safeAppText(event.RecurringEventID))
			}
			for _, recurrence := range event.Recurrence {
				_, _ = fmt.Fprintf(output, "- Recurrence: %s\n", safeAppText(recurrence))
			}
			writeCalendarPerson(output, "Creator", event.Creator)
			writeCalendarPerson(output, "Organizer", event.Organizer)
			if event.Location != "" {
				_, _ = fmt.Fprintf(output, "- Location: %s\n", safeAppText(event.Location))
			}
			if event.HangoutLink != "" {
				_, _ = fmt.Fprintf(output, "- Conference: %s\n", safeAppText(event.HangoutLink))
			}
			if event.SourceURL != "" {
				_, _ = fmt.Fprintf(output, "- Source: %s\n", safeAppText(event.SourceURL))
			}
			for _, attendee := range event.Attendees {
				label := attendee.DisplayName
				if label == "" {
					label = attendee.Email
				}
				_, _ = fmt.Fprintf(output, "- Invitee: %s", safeAppText(label))
				if attendee.Email != "" && attendee.Email != label {
					_, _ = fmt.Fprintf(output, " <%s>", safeAppText(attendee.Email))
				}
				if attendee.ResponseStatus != "" {
					_, _ = fmt.Fprintf(output, " [%s]", safeAppText(attendee.ResponseStatus))
				}
				_, _ = output.WriteString("\n")
			}
			if event.Description != "" {
				_, _ = fmt.Fprintf(output, "\n%s\n", safeAppText(event.Description))
			}
			for _, attachment := range event.Attachments {
				_, _ = fmt.Fprintf(output, "\n- Attachment: %s (%s)", safeAppText(attachment.Title), safeAppText(attachment.URL))
			}
			_, _ = output.WriteString("\n\n")
		}
		content, err := output.Content()
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(content) {
			return nil, errors.New("Google Calendar document was not valid UTF-8")
		}
		stableIdentity := "google_calendar:" + identity.CalendarID + ":calendar:" + key.calendarID
		documents = append(documents, AppDocument{RemoteID: "google_calendar:" + key.calendarID + ":" + key.day, Filename: boundedAppFilename("google-calendar", calendar.Summary, stableIdentity, key.day), Markdown: content})
	}
	return documents, nil
}

func googleCalendarEventDay(event GoogleCalendarEvent, calendarTimeZone string) (string, error) {
	if event.StartDate != "" {
		return event.StartDate, nil
	}
	dateTime, zone := event.StartDateTime, event.StartTimeZone
	if dateTime == "" {
		dateTime, zone = event.OriginalStartDateTime, event.OriginalStartTimeZone
	}
	if dateTime == "" {
		if !event.UpdatedAt.IsZero() {
			return event.UpdatedAt.UTC().Format("2006-01-02"), nil
		}
		if !event.CreatedAt.IsZero() {
			return event.CreatedAt.UTC().Format("2006-01-02"), nil
		}
		if event.Status == "cancelled" {
			return "cancelled", nil
		}
		return "", errors.New("Google Calendar event start was missing")
	}
	parsed, err := time.Parse(time.RFC3339Nano, dateTime)
	if err != nil {
		return "", errors.New("Google Calendar event start was invalid")
	}
	if zone == "" {
		zone = calendarTimeZone
	}
	if zone != "" {
		location, loadErr := time.LoadLocation(zone)
		if loadErr != nil {
			return "", errors.New("Google Calendar timezone was invalid")
		}
		parsed = parsed.In(location)
	}
	return parsed.Format("2006-01-02"), nil
}

func calendarEventTime(date, dateTime, zone string) string {
	if date != "" {
		return date + " (all day)"
	}
	if zone != "" {
		return dateTime + " [" + zone + "]"
	}
	return dateTime
}

func writeCalendarPerson(output *appDocumentBuilder, label string, person GoogleCalendarPerson) {
	value := person.DisplayName
	if value == "" {
		value = person.Email
	}
	if value == "" {
		return
	}
	_, _ = fmt.Fprintf(output, "- %s: %s", label, safeAppText(value))
	if person.Email != "" && person.Email != value {
		_, _ = fmt.Fprintf(output, " <%s>", safeAppText(person.Email))
	}
	_, _ = output.WriteString("\n")
}
