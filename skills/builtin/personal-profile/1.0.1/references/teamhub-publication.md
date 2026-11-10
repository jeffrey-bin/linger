# TeamHub publication

The Profile is one structured JSON document. `teamhub personal-profile show`
prints it as `profile`; `teamhub personal-profile write` replaces it with the
complete document you pass. TeamHub validates the document and renders its
Markdown itself, so readers never depend on your formatting. This shape
overrides the User-facing output section of SKILL.md. Always write the
complete document, including unaffected supported content on updates.

## Workflow

1. Run `teamhub personal-profile show` and note its `revision_id`.
2. Copy the `profile` JSON into a transient draft file and edit it. With no
   Profile yet, start from the fields below.
3. Run `teamhub personal-profile write --base-revision <revision_id> --file <draft.json>`
   with the complete document, then delete the draft.
4. On `profile_revision_conflict`, show again, merge, and write again. On
   `profile_document_invalid` or `profile_module_empty`, fix the field named in
   the error issues; nothing was written.

## Document fields

The document contains exactly these fields; unknown fields are rejected.

- `name`: the subject's name.
- Five modules, in this fixed reading order: `background`,
  `communication_style`, `working_style`, `preferences`, `writing_style`.
  Each module has:
  - `overview`: a paragraph of connected prose; may be empty when the module
    has points.
  - `points`: topical sub-points, each with a short `title`, a `text`
    paragraph, and `items`, a list of short single-line facts. A point needs
    text or at least one item.

  Every module must carry supported content: a non-empty overview or at least
  one point. Background's overview is the opening portrait.
- `background.timeline` merges education and work (employment, internships,
  research, and independent projects) into a single list sorted strictly by
  start date, oldest first, even when a baseline or source lists them newest
  first. Each entry has:
  - `period`: the start and end; use `Present` for an ongoing entry and give
    the month only when it is supported.
  - `organization`: the school or organization.
  - `place`: the city, or an empty string when the source does not state it
    for that entry; never carry a city over from another entry.
  - `role`: the role, or the degree or program for education when known.
  - `description`: one sentence on what the subject did or studied there, or an
    empty string; never restate the role.
  - `details`: up to three short supported facts worth knowing (notable
    projects, responsibilities, results, scope, or what was studied), one fact
    each; an empty list when there is nothing beyond the role.

  An empty string means the value is unknown; never write a placeholder such
  as "Not specified" or "Unknown". Every education entry is its own timeline
  entry; never summarize education in the overview or points. Do not repeat
  timeline entries as separate education or earlier-experience points; current
  work keeps its detailed points in `background.points`.

Every text field is plain text: no Markdown headings (a line starting with
`#`), no images, and no HTML. Write prose in `overview` and `text`, and short
facts in `items` and `details`. Where the Skill's guidance speaks of topical
headings, subheadings, or subsections inside a module, use titled points.

Do not add a Profile Summary, Evidence sources, Things to Confirm, or Coverage
and changes section anywhere in the document. The Skill's guidance on these
sections still shapes what you investigate and retain, but none of them is
published: write the overview the Skill describes as Background's overview,
and leave unresolved contradictions or coverage limits out of the document
rather than guessing. Report them to the Meta instead. When a baseline uses
another shape, migrate its supported content into these fields.

## Language

The output language is always English. This is an explicit output-language
request that overrides the Skill's language contract: write all profile text in
English even when the sources, the baseline, or the subject's own writing are
in another language, and translate a non-English baseline into English while
keeping its facts. Analyze source writing in its original language, and keep
names in the spelling the subject uses. The Account fields follow the same
rule except for proper names.

## Account fields

The Account name, bio, and organization are structured fields, not a second
profile. Read them with `teamhub account-profile show` first. Set them only with
`teamhub account-profile update [--name] [--bio] [--organization]`, only with
supported identity facts, and only for a field that `show` returns empty or that
the Human explicitly asked to change. Do not derive a name from
an email address.
