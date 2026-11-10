# TeamHub publication

TeamHub publishes the Markdown passed to `teamhub personal-profile write` verbatim as
the Human's one current Personal Profile, and the Wiki Profile page parses its shape.
This shape overrides the User-facing output section of SKILL.md. Always write the
complete document, including unaffected supported content on updates.

## Published document shape

The published profile contains the five modules only, in this fixed order and
with these exact heading levels:

1. One `# ` title line: the subject's name. An update-date line may follow it.
2. Exactly five `## ` module headings, in this order and with this exact text:
   Background, Communication Style, Working Style, Preferences, Writing Style.
3. Topical sub-points inside a module use `### ` headings only; never `# ` or
   `## ` inside a module, and never more than three heading levels.
4. Background contains one `### Timeline` sub-point that merges education and
   work (employment, internships, research, and independent projects) into a
   single list sorted strictly by start date, oldest first, even when a
   baseline or source lists them newest first. Each entry is one list item of two
   lines: the period, organization, and city, then the role and a one-sentence
   description of what the subject did there. The shape below uses
   placeholders only; never copy its wording into a profile:

   ```
   - <start>–<end> · <school> · <city>
     <degree or program> | <what was studied, when supported>
   - <start>–Present · <organization> · <city>
     <role> | <one sentence on the work>
     - <supported detail>
   ```

   Every education entry (school, degree or program when known) is its own
   Timeline entry; never summarize education in prose before or after the
   list, and write nothing after the last entry. When there is no city, end
   the first line at the organization with no trailing separator; never write
   a placeholder such as "Not specified" or "Unknown". When there is
   no supported description, end the second line at the role.

   When an entry has supported details worth knowing (notable projects,
   responsibilities, results, scope, or what was studied), summarize them as up
   to three short nested bullets under that entry, one fact each. Add nothing
   when there is nothing beyond the role line, and leave the description after
   `|` out rather than restating the role.

   Use `Present` for an ongoing entry. Include only supported entries; give the
   month only when it is supported, and omit the city when the source does not state it
   for that entry; never carry a city over from another entry. Put the
   Timeline right after Background's opening paragraph. Do not repeat its
   entries as separate education or earlier-experience sub-points; current work
   keeps its detailed sub-points after the Timeline.

Do not output a Profile Summary, Evidence sources, Things to Confirm, or
Coverage and changes section, or any other `## ` section. The Skill's guidance on
these sections still shapes what you investigate and retain, but none of them is
published: write the overview the Skill describes as Background's opening
paragraph, and leave unresolved contradictions or coverage limits out of the
document rather than guessing. Report them to the Meta instead. When a baseline
uses another shape, migrate its supported content into the five modules.

## Language

The output language is always English. This is an explicit output-language
request that overrides the Skill's language contract: write every heading and
all profile text in English even when the sources, the baseline, or the
subject's own writing are in another language, and translate a non-English
baseline into English while keeping its facts. Analyze source writing in its
original language, and keep names in the spelling the subject uses. The
Account fields follow the same rule except for proper names.

## Account fields

The Account name, bio, and organization are structured fields, not a second
profile. Read them with `teamhub account-profile show` first. Set them only with
`teamhub account-profile update [--name] [--bio] [--organization]`, only with
supported identity facts, and only for a field that `show` returns empty or that
the Human explicitly asked to change. Do not derive a name from
an email address.
