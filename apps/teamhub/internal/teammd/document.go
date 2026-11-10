// Package teammd parses and validates the teamMD collaboration protocol
// document that an Orchestrator publishes into a Room as team.md.
//
// Parsing is pure: it never mutates the submitted content, which TeamHub stores
// verbatim. Structural problems are reported as Issue values rather than a
// single error so the caller can return every problem in one response.
package teammd

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// MaxContentBytes bounds one team.md submission.
const MaxContentBytes = 64 * 1024

const (
	maxMembers            = 50
	maxNameBytes          = 120
	maxRoleBytes          = 1_000
	maxTaskGoalBytes      = 4_000
	maxActorIDBytes       = 120
	maxReferencesPerEntry = 20
)

// Pattern is the collaboration pattern declared in the document frontmatter.
type Pattern string

const (
	PatternClassifyAndAct          Pattern = "classify-and-act"
	PatternFanOutAndSynthesize     Pattern = "fan-out-and-synthesize"
	PatternAdversarialVerification Pattern = "adversarial-verification"
	PatternTournament              Pattern = "tournament"
	PatternLoopUntilDone           Pattern = "loop-until-done"
)

// Patterns lists every accepted collaboration pattern.
var Patterns = []Pattern{
	PatternClassifyAndAct,
	PatternFanOutAndSynthesize,
	PatternAdversarialVerification,
	PatternTournament,
	PatternLoopUntilDone,
}

// Issue codes. They are part of the Tool contract and must stay stable.
const (
	CodeContentInvalid      = "team_md_content_invalid"
	CodeContentTooLarge     = "team_md_content_too_large"
	CodeFrontmatterMissing  = "team_md_frontmatter_missing"
	CodeFrontmatterInvalid  = "team_md_frontmatter_invalid"
	CodePatternMissing      = "team_md_pattern_missing"
	CodePatternInvalid      = "team_md_pattern_invalid"
	CodeSectionMissing      = "team_md_section_missing"
	CodeSectionUnknown      = "team_md_section_unknown"
	CodeSectionDuplicated   = "team_md_section_duplicated"
	CodeTaskGoalMissing     = "team_md_task_goal_missing"
	CodeOrchestratorInvalid = "team_md_orchestrator_invalid"
	CodeMemberMissing       = "team_md_member_missing"
	CodeTooManyMembers      = "team_md_too_many_members"
	CodeEntryInvalid        = "team_md_entry_invalid"
	CodeAttributeUnknown    = "team_md_attribute_unknown"
	CodeAttributeDuplicated = "team_md_attribute_duplicated"
	CodeNameInvalid         = "team_md_name_invalid"
	CodeNameDuplicated      = "team_md_name_duplicated"
	CodeActorIDMissing      = "team_md_actor_id_missing"
	CodeActorIDDuplicated   = "team_md_actor_id_duplicated"
	CodeRoleTooLong         = "team_md_role_too_long"
	CodeReferenceUnknown    = "team_md_reference_unknown"
	CodeTooManyReferences   = "team_md_too_many_references"
	CodeActorNotRoomMember  = "team_md_actor_not_room_member"
)

// Issue is one structured validation problem.
type Issue struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Participant is the Orchestrator or one Team Member.
type Participant struct {
	Name        string   `json:"name"`
	ActorID     string   `json:"actor_id"`
	Role        string   `json:"role,omitempty"`
	ReportTo    []string `json:"report_to"`
	ReceiveFrom []string `json:"receive_from"`
}

// Document is one parsed team.md.
type Document struct {
	Pattern      Pattern       `json:"collaborate_pattern"`
	TaskGoal     string        `json:"task_goal"`
	Orchestrator Participant   `json:"orchestrator"`
	Members      []Participant `json:"members"`
}

// ActorIDs returns the Orchestrator followed by every Team Member Actor ID.
// The caller uses it to resolve Mention targets and membership authorization.
func (document Document) ActorIDs() []string {
	ids := make([]string, 0, len(document.Members)+1)
	if document.Orchestrator.ActorID != "" {
		ids = append(ids, document.Orchestrator.ActorID)
	}
	for _, member := range document.Members {
		if member.ActorID != "" {
			ids = append(ids, member.ActorID)
		}
	}
	return ids
}

// ValidPattern reports whether value is an accepted collaboration pattern.
func ValidPattern(value string) bool {
	for _, pattern := range Patterns {
		if string(pattern) == value {
			return true
		}
	}
	return false
}

func patternList() string {
	values := make([]string, 0, len(Patterns))
	for _, pattern := range Patterns {
		values = append(values, string(pattern))
	}
	return strings.Join(values, ", ")
}

// Parse reads one team.md into a Document. It reports every structural problem
// it can determine without Room context; Validate owns membership.
func Parse(content string) (Document, []Issue) {
	var document Document
	if !utf8.ValidString(content) {
		return document, []Issue{{
			Path: "content", Code: CodeContentInvalid,
			Message: "team.md must be valid UTF-8.",
		}}
	}
	if len(content) > MaxContentBytes {
		return document, []Issue{{
			Path: "content", Code: CodeContentTooLarge,
			Message: fmt.Sprintf("team.md must not exceed %d bytes.", MaxContentBytes),
		}}
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")

	frontmatter, body, issue := splitFrontmatter(lines)
	if issue != nil {
		return document, []Issue{*issue}
	}
	issues := make([]Issue, 0)
	pattern, patternIssues := parsePattern(frontmatter)
	document.Pattern = pattern
	issues = append(issues, patternIssues...)

	sections, sectionIssues := splitSections(body)
	issues = append(issues, sectionIssues...)

	document.TaskGoal, sectionIssues = parseTaskGoal(sections)
	issues = append(issues, sectionIssues...)

	document.Orchestrator, sectionIssues = parseOrchestrator(sections)
	issues = append(issues, sectionIssues...)

	document.Members, sectionIssues = parseMembers(sections)
	issues = append(issues, sectionIssues...)

	issues = append(issues, validateIdentities(document)...)
	issues = append(issues, validateReferences(document)...)
	return document, issues
}

// Validate reports Participants that are not active members of the Room.
// activeMemberActorIDs is the Room's current active membership roster.
func Validate(document Document, activeMemberActorIDs []string) []Issue {
	roster := make(map[string]struct{}, len(activeMemberActorIDs))
	for _, actorID := range activeMemberActorIDs {
		roster[actorID] = struct{}{}
	}
	issues := make([]Issue, 0)
	if actorID := document.Orchestrator.ActorID; actorID != "" {
		if _, found := roster[actorID]; !found {
			issues = append(issues, Issue{
				Path: "orchestrator.id", Code: CodeActorNotRoomMember,
				Message: fmt.Sprintf("Orchestrator %q is not an active member of this Room.", actorID),
			})
		}
	}
	for index, member := range document.Members {
		if member.ActorID == "" {
			continue
		}
		if _, found := roster[member.ActorID]; !found {
			issues = append(issues, Issue{
				Path: fmt.Sprintf("members[%d].id", index), Code: CodeActorNotRoomMember,
				Message: fmt.Sprintf("Team Member %q is not an active member of this Room.", member.ActorID),
			})
		}
	}
	return issues
}

func splitFrontmatter(lines []string) (string, []string, *Issue) {
	start := 0
	for start < len(lines) && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	if start >= len(lines) || strings.TrimSpace(lines[start]) != "---" {
		return "", nil, &Issue{
			Path: "frontmatter", Code: CodeFrontmatterMissing,
			Message: "team.md must open with a --- frontmatter block.",
		}
	}
	for index := start + 1; index < len(lines); index++ {
		if trimmed := strings.TrimSpace(lines[index]); trimmed == "---" || trimmed == "..." {
			return strings.Join(lines[start+1:index], "\n"), lines[index+1:], nil
		}
	}
	return "", nil, &Issue{
		Path: "frontmatter", Code: CodeFrontmatterMissing,
		Message: "team.md frontmatter block is not closed by ---.",
	}
}

func parsePattern(frontmatter string) (Pattern, []Issue) {
	fields := map[string]any{}
	if err := yaml.Unmarshal([]byte(frontmatter), &fields); err != nil {
		return "", []Issue{{
			Path: "frontmatter", Code: CodeFrontmatterInvalid,
			Message: "team.md frontmatter must be a YAML mapping.",
		}}
	}
	issues := make([]Issue, 0)
	for key := range fields {
		if key != "collaborate_pattern" {
			issues = append(issues, Issue{
				Path: "frontmatter." + key, Code: CodeFrontmatterInvalid,
				Message: fmt.Sprintf("team.md frontmatter does not accept %q; the only key is collaborate_pattern.", key),
			})
		}
	}
	raw, found := fields["collaborate_pattern"]
	if !found {
		return "", append(issues, Issue{
			Path: "frontmatter.collaborate_pattern", Code: CodePatternMissing,
			Message: "team.md frontmatter must declare collaborate_pattern.",
		})
	}
	value, isString := raw.(string)
	if !isString || !ValidPattern(strings.TrimSpace(value)) {
		return "", append(issues, Issue{
			Path: "frontmatter.collaborate_pattern", Code: CodePatternInvalid,
			Message: fmt.Sprintf("collaborate_pattern must be one of: %s.", patternList()),
		})
	}
	return Pattern(strings.TrimSpace(value)), issues
}

const (
	sectionTaskGoal     = "task goal"
	sectionOrchestrator = "orchestrator"
	sectionTeamMember   = "team member"
)

func splitSections(body []string) (map[string][]string, []Issue) {
	sections := map[string][]string{}
	issues := make([]Issue, 0)
	current := ""
	for _, line := range body {
		heading, isHeading := strings.CutPrefix(line, "## ")
		if !isHeading {
			if current != "" {
				sections[current] = append(sections[current], line)
			}
			continue
		}
		name := strings.ToLower(strings.TrimSpace(heading))
		switch name {
		case sectionTaskGoal, sectionOrchestrator, sectionTeamMember:
		default:
			issues = append(issues, Issue{
				Path: "sections", Code: CodeSectionUnknown,
				Message: fmt.Sprintf("team.md does not accept the section %q.", strings.TrimSpace(heading)),
			})
			current = ""
			continue
		}
		if _, found := sections[name]; found {
			issues = append(issues, Issue{
				Path: "sections", Code: CodeSectionDuplicated,
				Message: fmt.Sprintf("team.md declares the section %q more than once.", strings.TrimSpace(heading)),
			})
		}
		current = name
		sections[name] = []string{}
	}
	for _, required := range []string{sectionTaskGoal, sectionOrchestrator, sectionTeamMember} {
		if _, found := sections[required]; !found {
			issues = append(issues, Issue{
				Path: "sections", Code: CodeSectionMissing,
				Message: fmt.Sprintf("team.md must declare a %q section.", sectionTitle(required)),
			})
		}
	}
	return sections, issues
}

func sectionTitle(name string) string {
	switch name {
	case sectionTaskGoal:
		return "Task Goal"
	case sectionOrchestrator:
		return "Orchestrator"
	default:
		return "Team Member"
	}
}

func parseTaskGoal(sections map[string][]string) (string, []Issue) {
	goal := strings.TrimSpace(strings.Join(sections[sectionTaskGoal], "\n"))
	if goal == "" {
		if _, found := sections[sectionTaskGoal]; !found {
			return "", nil
		}
		return "", []Issue{{
			Path: "task_goal", Code: CodeTaskGoalMissing,
			Message: "The Task Goal section must not be empty.",
		}}
	}
	if len(goal) > maxTaskGoalBytes {
		return goal, []Issue{{
			Path: "task_goal", Code: CodeTaskGoalMissing,
			Message: fmt.Sprintf("The Task Goal section must not exceed %d bytes.", maxTaskGoalBytes),
		}}
	}
	return goal, nil
}

func parseOrchestrator(sections map[string][]string) (Participant, []Issue) {
	lines, found := sections[sectionOrchestrator]
	if !found {
		return Participant{}, nil
	}
	entries, issues := parseEntries(lines, "orchestrator")
	if len(entries) != 1 {
		return Participant{}, append(issues, Issue{
			Path: "orchestrator", Code: CodeOrchestratorInvalid,
			Message: fmt.Sprintf("The Orchestrator section must declare exactly one Agent; found %d.", len(entries)),
		})
	}
	return entries[0], issues
}

func parseMembers(sections map[string][]string) ([]Participant, []Issue) {
	lines, found := sections[sectionTeamMember]
	if !found {
		return nil, nil
	}
	entries, issues := parseEntries(lines, "members")
	if len(entries) == 0 {
		return nil, append(issues, Issue{
			Path: "members", Code: CodeMemberMissing,
			Message: "The Team Member section must declare at least one Agent.",
		})
	}
	if len(entries) > maxMembers {
		return entries, append(issues, Issue{
			Path: "members", Code: CodeTooManyMembers,
			Message: fmt.Sprintf("team.md must not declare more than %d Team Members.", maxMembers),
		})
	}
	return entries, issues
}

// parseEntries reads the "- NAME" / "  - Key: value" list shared by the
// Orchestrator and Team Member sections.
func parseEntries(lines []string, pathPrefix string) ([]Participant, []Issue) {
	entries := make([]Participant, 0)
	issues := make([]Issue, 0)
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		entryPath := func() string {
			if pathPrefix == "orchestrator" {
				return "orchestrator"
			}
			return fmt.Sprintf("%s[%d]", pathPrefix, len(entries)-1)
		}
		if name, isEntry := strings.CutPrefix(line, "- "); isEntry {
			entries = append(entries, Participant{
				Name:        strings.TrimSpace(name),
				ReportTo:    []string{},
				ReceiveFrom: []string{},
			})
			if entries[len(entries)-1].Name == "" || len(entries[len(entries)-1].Name) > maxNameBytes {
				issues = append(issues, Issue{
					Path: entryPath() + ".name", Code: CodeNameInvalid,
					Message: fmt.Sprintf("An entry name must be 1-%d bytes.", maxNameBytes),
				})
			}
			continue
		}
		if len(entries) == 0 {
			issues = append(issues, Issue{
				Path: pathPrefix, Code: CodeEntryInvalid,
				Message: fmt.Sprintf("Unexpected line before the first entry: %q.", strings.TrimSpace(line)),
			})
			continue
		}
		attribute, isAttribute := strings.CutPrefix(strings.TrimLeft(line, " \t"), "- ")
		if !isAttribute || line == strings.TrimLeft(line, " \t") {
			issues = append(issues, Issue{
				Path: entryPath(), Code: CodeEntryInvalid,
				Message: fmt.Sprintf("Expected an indented \"- Key: value\" attribute; found %q.", strings.TrimSpace(line)),
			})
			continue
		}
		issues = append(issues, applyAttribute(&entries[len(entries)-1], attribute, entryPath())...)
	}
	return entries, issues
}

func applyAttribute(entry *Participant, attribute, entryPath string) []Issue {
	key, value, hasSeparator := strings.Cut(attribute, ":")
	if !hasSeparator {
		return []Issue{{
			Path: entryPath, Code: CodeEntryInvalid,
			Message: fmt.Sprintf("Attribute %q must use \"Key: value\".", strings.TrimSpace(attribute)),
		}}
	}
	value = strings.TrimSpace(value)
	switch normalizeKey(key) {
	case "id":
		if entry.ActorID != "" {
			return duplicatedAttribute(entryPath, "ID")
		}
		if value == "" || len(value) > maxActorIDBytes {
			return []Issue{{
				Path: entryPath + ".id", Code: CodeActorIDMissing,
				Message: fmt.Sprintf("ID must be 1-%d bytes.", maxActorIDBytes),
			}}
		}
		entry.ActorID = value
	case "role":
		if entry.Role != "" {
			return duplicatedAttribute(entryPath, "Role")
		}
		if len(value) > maxRoleBytes {
			return []Issue{{
				Path: entryPath + ".role", Code: CodeRoleTooLong,
				Message: fmt.Sprintf("Role must not exceed %d bytes.", maxRoleBytes),
			}}
		}
		entry.Role = value
	case "report to":
		references, issues := parseReferences(value, entryPath+".report_to")
		entry.ReportTo = append(entry.ReportTo, references...)
		return issues
	case "receive from":
		references, issues := parseReferences(value, entryPath+".receive_from")
		entry.ReceiveFrom = append(entry.ReceiveFrom, references...)
		return issues
	default:
		return []Issue{{
			Path: entryPath, Code: CodeAttributeUnknown,
			Message: fmt.Sprintf("Unknown attribute %q; accepted keys are ID, Role, Report to, Receive from.", strings.TrimSpace(key)),
		}}
	}
	return nil
}

func duplicatedAttribute(entryPath, key string) []Issue {
	return []Issue{{
		Path: entryPath, Code: CodeAttributeDuplicated,
		Message: fmt.Sprintf("Attribute %q is declared more than once.", key),
	}}
}

// normalizeKey lowercases an attribute key and collapses "_" and runs of
// whitespace so "Report to", "report_to" and "Report  To" are one key.
func normalizeKey(key string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.ReplaceAll(key, "_", " "))), " ")
}

func parseReferences(value, path string) ([]string, []Issue) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.EqualFold(trimmed, "none") || trimmed == "-" {
		return nil, nil
	}
	references := make([]string, 0)
	for _, part := range strings.Split(trimmed, ",") {
		if name := strings.TrimSpace(part); name != "" {
			references = append(references, name)
		}
	}
	if len(references) > maxReferencesPerEntry {
		return references[:maxReferencesPerEntry], []Issue{{
			Path: path, Code: CodeTooManyReferences,
			Message: fmt.Sprintf("A relationship must not list more than %d names.", maxReferencesPerEntry),
		}}
	}
	return references, nil
}

func validateIdentities(document Document) []Issue {
	issues := make([]Issue, 0)
	names := map[string]struct{}{}
	actorIDs := map[string]struct{}{}
	if name := document.Orchestrator.Name; name != "" {
		names[name] = struct{}{}
	}
	if actorID := document.Orchestrator.ActorID; actorID != "" {
		actorIDs[actorID] = struct{}{}
	} else if document.Orchestrator.Name != "" {
		issues = append(issues, Issue{
			Path: "orchestrator.id", Code: CodeActorIDMissing,
			Message: "The Orchestrator entry must declare an ID.",
		})
	}
	for index, member := range document.Members {
		path := fmt.Sprintf("members[%d]", index)
		if member.Name != "" {
			if _, found := names[member.Name]; found {
				issues = append(issues, Issue{
					Path: path + ".name", Code: CodeNameDuplicated,
					Message: fmt.Sprintf("The name %q is declared more than once.", member.Name),
				})
			}
			names[member.Name] = struct{}{}
		}
		if member.ActorID == "" {
			issues = append(issues, Issue{
				Path: path + ".id", Code: CodeActorIDMissing,
				Message: fmt.Sprintf("Team Member %q must declare an ID.", member.Name),
			})
			continue
		}
		if _, found := actorIDs[member.ActorID]; found {
			issues = append(issues, Issue{
				Path: path + ".id", Code: CodeActorIDDuplicated,
				Message: fmt.Sprintf("The ID %q is declared more than once.", member.ActorID),
			})
		}
		actorIDs[member.ActorID] = struct{}{}
	}
	return issues
}

func validateReferences(document Document) []Issue {
	declared := map[string]struct{}{}
	if name := document.Orchestrator.Name; name != "" {
		declared[name] = struct{}{}
	}
	for _, member := range document.Members {
		if member.Name != "" {
			declared[member.Name] = struct{}{}
		}
	}
	issues := make([]Issue, 0)
	for index, member := range document.Members {
		path := fmt.Sprintf("members[%d]", index)
		issues = append(issues, unknownReferences(declared, member.ReportTo, path+".report_to")...)
		issues = append(issues, unknownReferences(declared, member.ReceiveFrom, path+".receive_from")...)
	}
	issues = append(issues, unknownReferences(declared, document.Orchestrator.ReportTo, "orchestrator.report_to")...)
	issues = append(issues, unknownReferences(declared, document.Orchestrator.ReceiveFrom, "orchestrator.receive_from")...)
	return issues
}

func unknownReferences(declared map[string]struct{}, references []string, path string) []Issue {
	issues := make([]Issue, 0)
	for index, reference := range references {
		if _, found := declared[reference]; !found {
			issues = append(issues, Issue{
				Path: fmt.Sprintf("%s[%d]", path, index), Code: CodeReferenceUnknown,
				Message: fmt.Sprintf("%q is not declared in this team.md.", reference),
			})
		}
	}
	return issues
}
