# Shared Durable Entity Rules

These rules apply to every registered durable entity type. Session pages follow
their own prompt; each entity type's prompt defines its identity, granularity,
and sections.

- Before writing any durable page, read the application-generated entity
  registry named in the run instructions. It lists every existing durable page
  with its name, aliases, parts, and last update date. Update the listed page
  when the evidence concerns an entity that is already there.
- The application rejects two pages of one type that share a name or alias,
  and a Project and Topic that share a name, alias, or Project part name.
- A new page needs evidence of an ongoing relationship or recurring relevance:
  the Human took part (wrote, replied, met, decided, acted, or produced work
  about it), it recurs across separate interactions or dates, or it is an
  active party in an ongoing initiative of the Human.
  When the evidence routed to a new page only shows a one-off interaction (a
  one-way message the Human did not engage with, an automated notice,
  promotional content, or a single passing mention), `skip_page` it with that
  reason; a fact worth keeping belongs on the related initiative's page. An
  existing page is updated with any supported new fact.
- Write only what the evidence supports, for a reader. When a value is not
  supported, leave that line, field, or sentence out: never write placeholders
  such as `unknown`, `None observed.`, or `TBD`, how sure you are of a fact, or
  how the evidence was matched to the page.
- Write a date as a calendar date in the page's language (`2026-10-20`,
  `October 20, 2026`), taking the day as written in the evidence; never
  replace it with the current run date or an inferred one. Add
  a time of day only when the time itself matters, and never a weekday,
  seconds, or a UTC offset.
- The opening sections of a page state durable facts. When the Human last
  heard from an entity is not one of them; a dated entry in the page's items
  sections shows it.
- Write section text and item entries in the main language of the source
  evidence. Keep section names, JSON keys, and the field labels shown in each
  section template as given; translate only the values.

## Section Update Rules

Every entity section declares how an update may change it; the declaration is
shown next to each section name. The application checks these rules when the
page is written and rejects a write that breaks them.

- `summary` sections hold the current narrative. When nothing changed, write
  `{"keep": true}` and the application keeps the existing text. Whenever you
  write text, write it with its reason as `{"text": "...", "reason": "..."}`;
  this includes a new page and a new section, where the reason says what the
  text is based on. A rewrite must still cite every source the previous text
  cited, so keep the facts those sources support. If a source no longer
  supports anything, write
  `{"removed_refs": ["<raw_ref>"], "reason": "...", "text": "..."}`, listing
  that source's raw ref and explaining why in `reason`. The page lists only the
  sources its text cites. The `Change Log` records the reason of each rewrite.
  A summary section shown with `at most N characters` must fit that length;
  each citation counts as 20 characters. Condense it to the durable facts when
  it would not.
- `items` sections are lists of separate entries tracked by ID. The current
  page shows each entry with its ID, as `- [i3] ...`; never write the ID into
  an entry's text. A history section lists entries newest first and puts new
  entries on top; write several new entries newest first. A long history
  section shows only its newest entries, and its oldest ones at the bottom when
  an update may have to merge them; the entries it does not show stay
  unchanged. Write an array with only the entries that change:
  `{"text": "..."}` adds an entry, `{"id": "i3", "text": "..."}` updates entry
  `i3`, and `{"id": "i3", "retracted": "<reason>"}` removes it. Entries you do
  not mention are kept unchanged, so an entry missing from the new evidence is
  never dropped. Do not re-add an existing entry without its ID. Never invent an
  ID; the application assigns new ones. Write new or updated text with
  `[[source:<raw_ref>]]` citations, without a leading `- `.
- An items section shown with `at most N entries` keeps at most N entries. When
  an update would exceed it, merge the oldest entries into one dated summary
  that keeps their key facts and citations:
  `{"merge": ["i1", "i2", "i3"], "text": "..."}`. Each written entry, including
  a merged summary, fits the shown character limit (each citation counts as 20
  characters); when a summary would not fit, keep only the key facts.
- A page that still uses an older section layout is rewritten into the
  current sections the first time an update touches it. Carry every supported
  fact across: each source the old page cited must still be cited, or be listed
  in a summary section's `removed_refs` with the reason. Untouched pages keep
  their layout.
- `generated` sections are written by the application. Omit them from the
  page JSON. The `Change Log` keeps its most recent entries on the page,
  newest first; older ones are dropped.
