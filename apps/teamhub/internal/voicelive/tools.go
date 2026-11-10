package voicelive

import (
	"encoding/json"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// Business tools TeamHub executes with the session Human's authority. Voice
// Runtime adds the browser-side read_page, page_action and end_voice_mode tools.
const (
	ToolSearchMessages   = "search_messages"
	ToolFindRooms        = "find_rooms"
	ToolListWorkItems    = "list_work_items"
	ToolSearchDocuments  = "search_documents"
	ToolSendMessage      = "send_message"
	ToolAppendPocketNote = "append_pocket_note"
	ToolRecallMemory     = "recall_memory"
	ToolReadPocketNotes  = "read_pocket_notes"
	ToolDeletePocketNote = "delete_pocket_note"
	ToolCreateRoom       = "create_room"
	ToolReadDocument     = "read_document"
	ToolCheckReminders   = "check_reminders"
)

// MaxDocumentRunes bounds the Document text read to the live model.
const MaxDocumentRunes = 3000

// ReadDocumentArguments selects an authorized document and optional text query.
type ReadDocumentArguments struct {
	DocumentID string `json:"document_id"`
	Query      string `json:"query"`
}

// Tool is a provider-independent tool schema served to Voice Runtime.
type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
}

func objectSchema(required []string, properties map[string]any) map[string]any {
	return map[string]any{"type": "object", "properties": properties, "required": required}
}

func stringProperty(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

// Tools contains the business tools executed with the session Human’s authority.
var Tools = append([]Tool{
	{
		Name:        ToolSearchMessages,
		Description: "Search chat messages the user can see by keyword. Searches only the current Room by default; all_rooms=true searches every Room the user is in.",
		Parameters: objectSchema([]string{"query"}, map[string]any{
			"query":     stringProperty("Keywords to search for"),
			"all_rooms": map[string]any{"type": "boolean", "description": "Whether to search all Rooms"},
		}),
	},
	{
		Name:        ToolFindRooms,
		Description: "Find a Room or direct-chat contact the user belongs to by name and return its room_id, used to message another Room or person.",
		Parameters: objectSchema([]string{"query"}, map[string]any{
			"query": stringProperty("Part of the Room or contact name"),
		}),
	},
	{
		Name:        ToolListWorkItems,
		Description: "List the recent tasks and items the user can see, with their states. state is where an item stands (open, in_progress, resolved), not whether work runs now: execution_status says that (running; waiting_for_approval; idle, nothing runs and it waits for someone; failed; canceled). Say work is under way only when execution_status is running.",
		Parameters: objectSchema([]string{}, map[string]any{
			"state": map[string]any{"type": "string", "enum": []string{"open", "in_progress", "resolved"}, "description": "Optional: only this state"},
		}),
	},
	{
		Name: ToolCheckReminders,
		Description: "Read the user's own open tracked items: to-dos, meetings, things waiting on someone's reply, and so on. " +
			"Call it when the user asks what needs their attention, what to remind them of, or what is on today. It returns items (content, kind, and due when timed); an empty list means nothing needs attention right now. " +
			"Mention the most important few in a sentence or two instead of reading them all; if the user has an opinion about one (too late, no reminder needed, should have told me directly), just respond to it.",
		Parameters: objectSchema([]string{}, map[string]any{}),
	},
	{
		Name: ToolReadDocument,
		Description: "Read the body of a document or of a file in the chat (including canvases, such as an email draft the Agent wrote, and files someone uploaded or a task delivered, such as report.md). Call it when the user wants you to read, look at or explain what a document, file or draft says; never open the page to read the body. " +
			"With no arguments it reads the document or file most recently shared in the current room (such as a freshly delivered report); fill document_id when known (search_documents results include it), or query with the file or document name. " +
			"It returns title and text (up to 3000 characters; truncated=true means there is more); the canvas: lines at the top of a canvas are fields such as recipient and subject. Summarize the key points when reading, and read sentence by sentence only when asked. " +
			"images lists the image file names in the document: you cannot see image content, so only say how many there are and their names; when the user wants an image described, judged or changed, start a task for it with start_task. " +
			"text_pending=true means the body is not ready yet, so read again a little later; document_not_found means it was not found or the user may not view it.",
		Parameters: objectSchema([]string{}, map[string]any{
			"document_id": stringProperty("Optional document ID"),
			"query":       stringProperty("Optional part of the document name"),
		}),
	},
	{
		Name:        ToolSearchDocuments,
		Description: "Search documents and canvases shared in rooms by keyword and return titles and snippets. It does not search the Wiki, knowledge base or memory: when the user asks about the Wiki, knowledge base, memory, daily or weekly reports, meeting notes, project pages or someone's page, use recall_memory.",
		Parameters: objectSchema([]string{"query"}, map[string]any{
			"query": stringProperty("Keywords to search for"),
		}),
	},
	{
		Name: ToolSendMessage,
		Description: "Send a message as the user in a room of this app. Without room_id it goes to the room this call belongs to (not the room open on the page); to message another Room or person here, get its room_id with find_rooms first. It cannot post outside this app: Slack is send_slack; Feishu, WeChat or email is start_task. " +
			"It posts the user's own words as the user; never use it to share a task's result, report or files: the Agent posts those in the chat with their files by itself. " +
			"This is a write: first call without confirmed, read back the room name and content from the returned summary and ask the user to confirm, and after they agree call again with the same room_id and text and confirmed=true. " +
			"Setting confirmed=true without first getting a summary returns needs_confirmation again and sends nothing. If the room is wrong, go through it again with another room_id.",
		Parameters: objectSchema([]string{"text", "confirmed"}, map[string]any{
			"text":      stringProperty("Message body"),
			"room_id":   stringProperty("Optional target Room ID"),
			"confirmed": map[string]any{"type": "boolean", "description": "Whether the user has confirmed out loud"},
		}),
	},
	{
		Name: ToolAppendPocketNote,
		Description: "Append a note to the end of the user's own Pocket Notes page for today, for requests to note something down or add it to Pocket Notes. " +
			"It only writes text and sets no alarm: a reminder at a set time is create_routine, and a note is never called a reminder. " +
			"When the user lists several things in a row (note this … and also …), merge them into one note, confirm once and call once. " +
			"This is a write: read back what will be noted and ask the user to confirm, and only then set confirmed=true; it is noted only when the result is appended.",
		Parameters: objectSchema([]string{"text", "confirmed"}, map[string]any{
			"text":      stringProperty("What to note, in the user's meaning, as one sentence or a few short lines"),
			"time":      stringProperty("Optional time phrase kept as the user said it, such as “8 tonight”, not converted to a date format; it is written at the start of the note"),
			"confirmed": map[string]any{"type": "boolean", "description": "Whether the user has confirmed out loud"},
		}),
	},
	{
		Name: ToolCreateRoom,
		Description: "Create a collaboration Room (group chat) as the user, who becomes its owner. Call it when the user asks to create a group, a new room or a project group. " +
			"name is required: if the user did not give one, ask what to call it; never make one up. members is optional: fill in the colleagues or Agents to add, as the user called them; if none were mentioned, leave it empty and do not ask. " +
			"This is a write: read back the room name and members and ask the user to confirm, and only then set confirmed=true; it is created only when the result is created, after which you may ask whether to open it. " +
			"On room_name_taken, say a room with that name exists and ask whether to use another name; on member_not_found or member_ambiguous, ask which person was meant using candidates; never guess.",
		Parameters: objectSchema([]string{"name", "confirmed"}, map[string]any{
			"name":        stringProperty("Room name as the user said it, at most 120 characters"),
			"description": stringProperty("Optional room description, only when the user said what it is for"),
			"members": map[string]any{
				"type": "array", "maxItems": MaxRoomMembers,
				"items":       map[string]any{"type": "string"},
				"description": "Optional names of people or Agents to add, not including the user",
			},
			"confirmed": map[string]any{"type": "boolean", "description": "Whether the user has confirmed out loud"},
		}),
	},
	{
		Name: ToolReadPocketNotes,
		Description: "Read the user's own Pocket Notes, one page per local calendar day. " +
			"Call it when the user asks what is in their Pocket Notes or what they noted yesterday, today or last week; do not use recall_memory or search_documents instead. " +
			"date_from and date_to are local YYYY-MM-DD dates, resolving today and yesterday against the current local date the system gives; without them it returns the last 7 days. " +
			"Each page in the result has date and relative (today, yesterday, day_before); say which day something was noted only by date, and never present yesterday's notes as today's.",
		Parameters: objectSchema([]string{}, map[string]any{
			"date_from": stringProperty("Optional start local date YYYY-MM-DD"),
			"date_to":   stringProperty("Optional end local date YYYY-MM-DD (inclusive)"),
		}),
	},
	{
		Name: ToolDeletePocketNote,
		Description: "Delete a whole past day's page of the user's own Pocket Notes, for tidying requests like deleting yesterday's Pocket Notes or the page of October 3. " +
			"Only days before today can be deleted, never today's page; do not call it when the user only wants to change today's content. date is a local YYYY-MM-DD date, resolving yesterday and the day before against the current local date the system gives. " +
			"This is a write: first call without confirmed, read back which day it is and what was noted from the returned summary and ask the user to confirm, and after they agree call again with the same date and confirmed=true; it is deleted only when the result is deleted. " +
			"On not_found, say there were no notes that day; on today_not_deletable, say today's page cannot be deleted.",
		Parameters: objectSchema([]string{"date", "confirmed"}, map[string]any{
			"date":      stringProperty("Local date YYYY-MM-DD to delete, earlier than today"),
			"confirmed": map[string]any{"type": "boolean", "description": "Whether the user has confirmed out loud"},
		}),
	},
	{
		Name: ToolRecallMemory,
		Description: "Look up the user's own personal memory and Wiki (knowledge base), covering meeting notes, contacts, project pages and daily or weekly reports (overviews, decisions, to-dos) as well as the original chats, meetings and documents (details, exact words). " +
			"Use it when the user asks what is in their Wiki, knowledge base, memory or weekly reports, or about someone's page; never open the Wiki on the page to browse it, and never use search_documents for this. " +
			"Call it first whenever the answer depends on the user's own past (what was discussed or decided, who said what, what to follow up, progress, preferences, or advice for them personally); never answer from impression, and do not call it for small talk or common knowledge. " +
			"Do not copy the user's sentence into query: write “key person/project/event + what is asked”, such as “<person> follow-ups” or “Q3 budget decision”, in the user's language. " +
			"For two people or two things, look each up separately. Only fill event_from/event_to when the question names a time (last week, early September, today, just now; set both to today's date for today or just now); never for something said before or the latest status. " +
			"When status is weak or empty, look up once more with different words (only the name, a synonym or the project name); if still nothing, try search_messages; only then say plainly that you found nothing, and never answer from what the open page shows instead. A weak result is only a lead: never present it as the answer. memory_unavailable means the user's memory cannot be searched right now: say so in a sentence. " +
			"When the dates include today, the result's today holds today's Pocket Notes not yet in memory (pocket_note) and today's messages in the user's rooms (messages, oldest first); answer from it, even when the memory part is memory_unavailable.",
		Parameters: objectSchema([]string{"query"}, map[string]any{
			"query":      stringProperty("The question to recall, in the user's meaning, keeping any time phrase"),
			"event_from": stringProperty("Optional start date YYYY-MM-DD the question is about"),
			"event_to":   stringProperty("Optional end date YYYY-MM-DD the question is about"),
		}),
	},
	EmailCanvasTool,
	EditEmailCanvasTool,
	AttachEmailFileTool,
	AgentTool,
}, slices.Concat(DocumentTools, RoutineTools, taskTools, []Tool{approvalTool})...)

// SearchArguments selects a query and its Room search scope.
type SearchArguments struct {
	Query    string `json:"query"`
	AllRooms bool   `json:"all_rooms"`
}

// ListWorkItemsArguments filters the user’s visible Work Items by state.
type ListWorkItemsArguments struct {
	State string `json:"state"`
}

// LooseBool accepts JSON true/false and the string forms some live models
// emit for booleans ("true", "True", "false"). Anything else is false.
type LooseBool bool

// UnmarshalJSON accepts provider boolean values and their string forms.
func (b *LooseBool) UnmarshalJSON(raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	switch typed := value.(type) {
	case bool:
		*b = LooseBool(typed)
	case string:
		*b = LooseBool(strings.EqualFold(strings.TrimSpace(typed), "true"))
	default:
		*b = false
	}
	return nil
}

// DeletePocketNoteArguments selects a note date and explicit user confirmation.
type DeletePocketNoteArguments struct {
	Date      string    `json:"date"`
	Confirmed LooseBool `json:"confirmed"`
}

// AppendPocketNoteArguments holds note text, time and explicit user confirmation.
type AppendPocketNoteArguments struct {
	Text      string    `json:"text"`
	Time      string    `json:"time"`
	Confirmed LooseBool `json:"confirmed"`
}

// ReadPocketNotesArguments bounds the note dates to read.
type ReadPocketNotesArguments struct {
	DateFrom string `json:"date_from"`
	DateTo   string `json:"date_to"`
}

// MaxRoomMembers bounds the people a spoken create_room invites at once.
const MaxRoomMembers = 20

// CreateRoomArguments holds the proposed Room and invited member names.
type CreateRoomArguments struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Members     []string  `json:"members"`
	Confirmed   LooseBool `json:"confirmed"`
}

// DirectoryActor is one person or Agent the session Human can see.
type DirectoryActor struct {
	ID, Name, Kind string
}

// MemberMatch is the outcome of resolving spoken member names.
type MemberMatch struct {
	IDs, Names []string
	// Problem is set when a name matches nobody or more than one actor; it
	// is returned to the model as is so it can ask the user.
	Problem map[string]any
}

// MatchMembers resolves spoken names to actors: an exact display name
// (ignoring case and spaces) wins, otherwise a single actor whose name
// contains the spoken one. The session Human is never added again.
func MatchMembers(spoken []string, directory []DirectoryActor, self string) MemberMatch {
	normalize := func(value string) string {
		return strings.ToLower(strings.Join(strings.Fields(value), ""))
	}
	var match MemberMatch
	seen := map[string]bool{self: true}
	for _, raw := range spoken {
		name := normalize(raw)
		if name == "" {
			continue
		}
		var exact, partial []DirectoryActor
		for _, actor := range directory {
			candidate := normalize(actor.Name)
			switch {
			case candidate == "":
			case candidate == name:
				exact = append(exact, actor)
			case strings.Contains(candidate, name):
				partial = append(partial, actor)
			}
		}
		found := exact
		if len(found) == 0 {
			found = partial
		}
		switch {
		case len(found) == 1:
			if !seen[found[0].ID] {
				seen[found[0].ID] = true
				match.IDs = append(match.IDs, found[0].ID)
				match.Names = append(match.Names, found[0].Name)
			}
		case len(found) == 0:
			match.Problem = map[string]any{"error": "member_not_found", "name": strings.TrimSpace(raw)}
			return match
		default:
			candidates := make([]string, 0, 5)
			for _, actor := range found[:min(5, len(found))] {
				candidates = append(candidates, actor.Name)
			}
			match.Problem = map[string]any{"error": "member_ambiguous", "name": strings.TrimSpace(raw), "candidates": candidates}
			return match
		}
	}
	return match
}

// SendMessageArguments holds a destination, text and explicit user confirmation.
type SendMessageArguments struct {
	Text      string    `json:"text"`
	RoomID    string    `json:"room_id"`
	Confirmed LooseBool `json:"confirmed"`
}

// DecodeArguments reads the model's JSON object text. Empty text means no arguments.
func DecodeArguments(raw string, target any) error {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	if err := json.Unmarshal([]byte(raw), target); err != nil {
		return ErrInvalid
	}
	return nil
}

// Output encodes a tool result as the JSON text returned to the live model.
func Output(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		encoded, _ = json.Marshal(map[string]string{"error": "internal_error"})
	}
	return string(encoded)
}

// ErrorOutput encodes a structured tool error for the live model.
func ErrorOutput(code string) string {
	return Output(map[string]string{"error": code})
}

// NeedsConfirmation answers a write tool call the user has not confirmed yet.
// The yes must be the user's own, in their next turn: TeamHub refuses a
// confirmation from the turn that asked.
func NeedsConfirmation(summary string) string {
	return Output(map[string]string{
		"status": "needs_confirmation", "summary": summary,
		"next": "Ask the user this now, once, and end your turn; never answer it for them. If the user already said yes to it while this call ran, do not ask again: call again with confirmed=true now. Otherwise call again with confirmed=true only after they say yes in their own next turn. As you call, say a few words in their language that you are doing it, since the action can take a few seconds.",
	})
}

// AwaitingAnswer tells the model it said yes for the user to the question
// it just asked: the question stands and the user's own answer decides.
func AwaitingAnswer() string {
	return Output(map[string]string{
		"status": "awaiting_answer",
		"next":   "You already asked the user this in this turn and they have not answered. Do not ask again and never answer for them: if your question was cut off, finish it in one short sentence, otherwise say nothing more. When they say yes in their next turn, call again with confirmed=true.",
	})
}

// Truncate keeps the first limit runes of text and says whether it cut any.
func Truncate(text string, limit int) (string, bool) {
	text = strings.TrimSpace(text)
	shortened := truncateRunes(text, limit)
	return shortened, len(shortened) < len(text)
}

// Snippet shortens Message or Document text read aloud by the live model.
func Snippet(text string) string {
	return truncateRunes(strings.Join(strings.Fields(text), " "), 300)
}

// ValidQuery checks the bounded nonempty query accepted by search tools.
func ValidQuery(query string) bool {
	query = strings.TrimSpace(query)
	return query != "" && len(query) <= 200
}

// RecallArguments holds the user’s question and optional event date range.
type RecallArguments struct {
	Query     string `json:"query"`
	EventFrom string `json:"event_from"`
	EventTo   string `json:"event_to"`
}

// RecallMemoryResponse is the part of the Memory personal knowledge query
// response (queryPersonalKnowledge) the live recall reads.
type RecallMemoryResponse struct {
	Status string `json:"status"`
	Items  []struct {
		Title    string         `json:"title"`
		Excerpt  string         `json:"excerpt"`
		Content  string         `json:"content"`
		TimeHint string         `json:"timeHint"`
		Metadata map[string]any `json:"metadata"`
		Source   struct {
			Label string `json:"label"`
		} `json:"source"`
	} `json:"items"`
	Facts []struct {
		Text        string `json:"text"`
		MentionedAt string `json:"mentionedAt"`
		EvidenceID  string `json:"evidenceId"`
	} `json:"facts"`
}

const (
	maxRecallBullets  = 4
	maxRecallSources  = 3
	recallBulletRunes = 160
)

var roomSourceURI = regexp.MustCompile(`^teamhub://rooms/([A-Za-z0-9_-]{1,128})/messages$`)

// RecallEvidence is everything one live recall retrieved.
type RecallEvidence struct {
	Raw RecallMemoryResponse
	// Entities are the people named in the query, after name correction.
	Entities []string
}

type recallCandidate struct {
	text, title, date, uri string
	mentions, fact         bool
}

// CompactRecall turns one recall into what the live model reads aloud: at
// most four bullets, up to three sources with dates, and the Room the best
// source came from so the model can offer to open it. When the query names
// people, evidence that mentions them comes first and unrelated documents
// are left out, so a name never answers with someone else's material.
// Room ids still pass the caller's Room membership check before they are
// offered.
func CompactRecall(evidence RecallEvidence, canOpenRoom func(roomID string) (string, bool)) map[string]any {
	mentions := func(texts ...string) bool {
		for _, entity := range evidence.Entities {
			for _, text := range texts {
				if entity != "" && strings.Contains(text, entity) {
					return true
				}
			}
		}
		return false
	}
	var candidates []recallCandidate
	for _, fact := range evidence.Raw.Facts {
		date := ""
		if len(fact.MentionedAt) >= 10 {
			date = fact.MentionedAt[:10]
		}
		candidates = append(candidates, recallCandidate{text: fact.Text, date: date, mentions: mentions(fact.Text), fact: true})
	}
	for _, item := range evidence.Raw.Items {
		uri, _ := item.Metadata["sourceUri"].(string)
		candidates = append(candidates, recallCandidate{
			text: firstNonEmpty(item.Content, item.Excerpt), title: firstNonEmpty(item.Source.Label, item.Title),
			date: item.TimeHint, uri: uri, mentions: mentions(item.Title, item.Content, item.Excerpt),
		})
	}
	matched := false
	for _, candidate := range candidates {
		matched = matched || candidate.mentions
	}
	ordered := make([]recallCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.mentions || len(evidence.Entities) == 0 {
			ordered = append(ordered, candidate)
		}
	}
	if !matched && len(evidence.Entities) > 0 {
		// Nothing names the person: offer at most two loose leads.
		ordered = candidates[:min(2, len(candidates))]
	}

	bullets := make([]string, 0, maxRecallBullets)
	seen := map[string]bool{}
	sources := make([]map[string]string, 0, maxRecallSources)
	seenSources := map[string]bool{}
	openable, openableName := "", ""
	// Facts leave the last bullet to source text when there is any.
	facts, sourced := 0, slices.ContainsFunc(ordered, func(c recallCandidate) bool { return !c.fact })
	for _, candidate := range ordered {
		if len(bullets) >= maxRecallBullets {
			break
		}
		if candidate.fact && sourced && facts >= maxRecallBullets-1 {
			continue
		}
		text := truncateRunes(spokenRecallText(candidate.text), recallBulletRunes)
		key := truncateRunes(text, 40)
		if text == "" || seen[key] {
			continue
		}
		seen[key] = true
		bullets = append(bullets, text)
		if candidate.fact {
			facts++
		}
	}
	for _, candidate := range ordered {
		if candidate.title == "" || seenSources[candidate.title] || len(sources) >= maxRecallSources {
			continue
		}
		seenSources[candidate.title] = true
		source := map[string]string{"title": truncateRunes(candidate.title, 80)}
		if candidate.date != "" {
			source["date"] = truncateRunes(candidate.date, 32)
		}
		if match := roomSourceURI.FindStringSubmatch(candidate.uri); match != nil && canOpenRoom != nil {
			if name, ok := canOpenRoom(match[1]); ok {
				source["room_id"] = match[1]
				source["room"] = name
				if openable == "" {
					openable, openableName = match[1], name
				}
			}
		}
		sources = append(sources, source)
	}
	result := map[string]any{"status": "empty", "bullets": bullets, "sources": sources}
	switch {
	case len(bullets) > 0 && (matched || len(evidence.Entities) == 0):
		result["status"] = "found"
	case len(bullets) > 0:
		result["status"] = "weak"
		result["note"] = "Nothing mentions " + strings.Join(evidence.Entities, ", ") + "; below are only possibly related leads, not an answer."
	}
	if openable != "" {
		result["openable_room_id"] = openable
		result["openable_room"] = openableName
	}
	return result
}

// RecallMentions reports whether any retrieved evidence names one of the
// query's people.
func RecallMentions(evidence RecallEvidence) bool {
	for _, entity := range evidence.Entities {
		for _, fact := range evidence.Raw.Facts {
			if strings.Contains(fact.Text, entity) {
				return true
			}
		}
		for _, item := range evidence.Raw.Items {
			if strings.Contains(item.Title+item.Content+item.Excerpt, entity) {
				return true
			}
		}
	}
	return false
}

// NamedPeople lists the directory names (people and Agents the Human can
// see) that the query contains, longest first. Recall uses them only to
// rank evidence about those people first; the search itself is unchanged.
func NamedPeople(query string, directory []string) []string {
	names := make([]string, 0, len(directory))
	for _, name := range directory {
		if size := utf8.RuneCountInString(name); size >= 2 && size <= 8 && strings.Contains(query, name) && !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	sort.SliceStable(names, func(i, j int) bool {
		return utf8.RuneCountInString(names[i]) > utf8.RuneCountInString(names[j])
	})
	return names
}

var (
	recallMarkup     = regexp.MustCompile(`#{1,6}\s+|\\|<[^>]{1,80}>|\|`)
	recallEmphasis   = regexp.MustCompile("[*`]+")
	recallTimestamps = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*·?\s*|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b\s*`)
)

// spokenRecallText strips Markdown marks, escaped line breaks and transcript
// timestamps so an excerpt reads as plain words.
func spokenRecallText(text string) string {
	text = recallTimestamps.ReplaceAllString(text, "")
	text = recallMarkup.ReplaceAllString(text, " ")
	text = recallEmphasis.ReplaceAllString(text, "")
	return strings.Join(strings.Fields(text), " ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
