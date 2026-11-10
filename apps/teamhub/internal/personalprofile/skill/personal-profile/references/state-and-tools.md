# Derived state and local tools

Read this reference when saving, updating, localizing, or rendering. The agent discovers information, evaluates support, merges meaning, and translates. The helper stores and renders approved derived understanding; it does not connect to Gmail, perform extraction, or enable monitoring.

## Files and boundaries

- Canonical state: profile-state.json, outside this Skill package.
- Readable output: profile.md, regenerated after each saved update.
- A separate working candidate may contain permitted derived state only. Remove it after completion. Never create raw exports, evidence pools, or historical backups.
- Use a stable generated local subject identifier. Do not use an email address or account token as identity.
- Serialize writes. Read current state and merge before saving; the revision guard is not a substitute for coordinating concurrent writers.
- For conversation-only previews, do not persist.

## Version 2 contract

Required root fields are exactly schema_version, revision, subject_id, language, updated_at, sources, blocks, summary, conflicts, excluded_source_ids, and last_changes. The optional root fields are presentation, sections, display_name, and source_sync. Unknown fields are rejected. Existing version 2 states without these optional fields remain readable; no re-extraction is required to add source-level synchronization.

| Field | Meaning |
| --- | --- |
| schema_version | Fixed at 2: derived understanding and source summaries only |
| revision | Initialize to 0; increment by one per saved update |
| subject_id | Stable local identity; never mix different people |
| display_name | Resolved preferred/display/extracted name used in the title and third-person prose; add when preparing a profile for delivery |
| language | Explicit output-language tag, such as en, zh-Hans, ja, es, or pt-BR; not auto, und, or mul |
| updated_at | State update time, set by the helper; not a source-message timestamp |
| sources | General source categories and actual broad coverage |
| source_sync | Optional generated source IDs and successful scan boundaries for incremental retrieval; no item identifiers or source content |
| blocks | All useful supported derived observations, with no count or length cap |
| summary | Developed opening portrait of the person's present work, life, and concerns, with selective history and IDs of supporting active blocks |
| conflicts | Unresolved competing understandings; no quotations |
| excluded_source_ids | Generated local IDs of explicitly excluded whole sources |
| last_changes | Short localized coverage/update notes, replaced each run; not a cumulative personal history |
| presentation | Localized headings/messages; required for non-English output |
| sections | Localized connected reading layout covering all active blocks; use for substantive profiles |

There is no evidence array, original-text field, item-level checkpoint, message locator, or raw-content archive. Field names, IDs, and enum values stay stable; all generated display text follows the user's language.

### Source-level incremental boundaries

The optional source_sync array contains records with exactly source_id and checked_through. Each source_id must refer to one existing general source and may appear only once. checked_through is an ISO timestamp with a timezone: a run-generated upper boundary for the source's successful scan, not a copied item timestamp. Do not store mail IDs, thread IDs, URLs, opaque connector cursors, pagination tokens, or source content here.

Capture an upper boundary when a source pass begins, so new arrivals during the pass remain eligible next time. After a successful initial baseline, the boundary separates later arrivals from the historical material considered for that baseline; it does not certify that every historical item was inspected. Keep any incomplete historical scope in the general source overview. After an incremental run, advance the source boundary only after the eligible changes through that boundary were assessed within the declared scope. Do not advance it past an interrupted page, failed read, or unprocessed interval. Independently completed sources may advance while another source keeps its previous boundary.

Use the connector's actual change or time-filter semantics. Limited overlap can handle boundary granularity or late-arriving items; deduplicate derived meanings instead of saving item-level checkpoints. If an old profile has no reliable scan boundary, use the requested update interval or a disclosed bounded recent window consistent with the cadence, then establish a boundary after successful review. Do not assume updated_at equals the last source read or reread the entire history solely to initialize this field.

A successful scan with no useful profile changes may update source_sync while preserving all blocks, sections, and summary prose. A wording edit, translation, failed scan, or unvisited source must not advance its boundary. The renderer does not display source_sync as personal evidence. Removing a source also removes its synchronization record. The helper validates this metadata's shape and references, not whether the agent actually completed the scan.

### Subject display name

Resolve the name using SKILL.md: explicit preferred name, then verified display name, then a reliably attributed extracted name. Store it as display_name; do not use an address, URL, account token, or guessed name. A name correction does not change subject_id.

The renderer includes display_name in the title. It does not rewrite prose or infer identity. The agent must compose all subject descriptions in natural third person, including summaries and sections. Preserve spelling across languages unless a localized form is requested. Older states without the field remain readable and receive a naming reminder when they contain active understanding; resolve the name before delivering an updated profile.

The title and all visible headings also use neutral wording rather than first-person labels. Internal module identifiers retain their established spelling for compatibility. On an update, refresh legacy presentation labels explicitly; changing renderer defaults does not rewrite a custom presentation already stored in a profile.

### Source

Each source has exactly id, kind, label, and scope.

- id: generated local identifier such as s1, never an external message ID or account address.
- kind: general category such as gmail, email, chat, upload, or user_confirmation.
- label: localized general label, such as Work correspondence, with proper source names preserved where appropriate.
- scope: general account purpose/content families and actual coverage limits, such as received and sent product, client, and collaboration correspondence; older archived threads were only partly accessible.

The helper rejects obvious web links and email addresses in source summaries. The agent must also exclude subjects, copied passages, participant lists, external IDs, precise message timelines, and other raw records. A source summary is not a place to disguise a detailed mail history. Multiple blocks can use the same source without a separate source record for every message.

### Block

Each block has exactly id, module, narrative, source_ids, and basis.

Modules, in display order:

1. about_me
2. how_i_communicate
3. how_i_work
4. what_i_prefer
5. how_i_write

Write narrative in the output language. Preserve enough detail to convey the useful fact or pattern, relationships, scope, and meaningful time/status. Useful factual names are allowed. Do not store quotations or copied messages. Group related blocks in a readable order; no arbitrary quota or equal module size is required.

Every block has at least one source_id and one support basis:

| basis | Meaning |
| --- | --- |
| explicit_statement | A clear attributable self-statement, role description, or preference |
| documented_context | A fact, relationship, action, constraint, or scoped third-party report established by clear correspondence or records, including incoming, shared, and system-generated material; retain reported or uncertain status in the wording |
| observed_pattern | A scoped pattern supported by independent attributable behavior |
| user_confirmed | A conclusion explicitly accepted or corrected by the user; requires a source with kind user_confirmation |

These are claim types, not confidence scores or a hierarchy of authors. The agent must match wording to support; the helper cannot establish truth or authorship. Others' or system records may document actions and choices attributable to the subject; independent instances can support observed_pattern without a personally authored statement. A received assignment supports documented responsibility, not an invented behavioral trait or completed action. A specific third-party report remains scoped and reported unless further evidence supports a stronger claim. A user confirmation stores accepted meaning only, not the original answer.

Duplicate narratives within the same module are rejected; related but distinct observations are permitted. Semantic deduplication is the agent's responsibility.

### Connected reading sections

Individual blocks preserve supported understanding for updates. The optional sections array composes it into a coherent document. Do not render the observation inventory as a flat list by default. For a substantive build or revision, supply sections following [Narrative and communication style](narrative-and-style.md).

For Background, use company-based headings that keep each company's background and the subject's activities together: current primary company, other concurrent companies/engagements, then earlier experience. The existing sections array preserves this reading order; no separate company registry or new raw-data archive is needed. Store publicly verified company context in distinct blocks associated with a general company_public source, while role and contribution blocks retain their personal-source associations. They can appear in the same company section with the distinction clear in the prose.

Each section has exactly module, heading, and content. module is one of the five established module keys. heading is a localized topical subheading, or an empty string for an introductory passage. Arrange sections in a useful order within their module; rendering always keeps the established top-level module order. Combine repeated topical headings.

Each content item has exactly kind, text, and block_ids:

- kind is paragraph, numbered, or bullet. Use paragraph by default, numbered for a real sequence, and bullet for comparable variants. Consecutive numbered items form one ordered sequence.
- text is agent-composed derived prose in the output language. It may combine related observations with supported transitions. It must not add facts, quote original messages, invent motives, or drop useful detail. Newly composed illustrations, when useful, must be explicitly labeled and must illustrate referenced style observations rather than pretend to be evidence.
- block_ids identifies the active blocks whose understanding the passage expresses. Every referenced block must be in the same module, and all active blocks must be represented across the sections. An item can reference several blocks; a block can support several related passages when necessary without duplicating the whole claim.

When the user explicitly deprioritizes a topic, its passage may summarize the linked understanding at a lower level of detail while preserving the relevant connection. Keep the underlying derived observations unless deletion or forgetting is requested. Do not use this scoped exception to hide omissions in the main requested topics or to claim that an empty passage represents a block.

For example, the following fictional section combines professional context already established in blocks b1 and b2:

~~~json
{
  "module": "about_me",
  "heading": "Product responsibilities",
  "content": [
    {
      "kind": "paragraph",
      "text": "At Cedar Labs, Alex coordinates Harbor onboarding with the design team. This responsibility covers the first-use experience, while the design lead owns visual direction.",
      "block_ids": ["b1", "b2"]
    }
  ]
}
~~~

The corresponding blocks must actually establish both facts. This fragment is not a complete candidate and is not evidence about the user.

Validation rejects unknown or suspended block references, cross-module references, missing coverage, and extra raw-data fields. It checks associations, not whether every nuance survived composition; review the prose against the underlying understanding. When blocks change, revise the relevant sections too. A deleted claim must not remain in a paragraph linked to another valid block.

Older states without sections render their existing narratives as paragraphs and receive a composition reminder when they contain multiple active blocks. That compatibility fallback does not infer transitions or replace the agent's composition work. Paragraph breaks are preserved. Do not skip connected composition merely because a fallback can render.

### Summary

Exactly narrative and block_ids. The narrative is a developed, independently readable portrait rather than a short navigation blurb. It may contain multiple connected paragraphs separated by blank lines; the existing renderer preserves them without extra fields. Emphasize supported present work, life, and current concerns, with a small amount of relevant history. Follow [Narrative and communication style](narrative-and-style.md) for selection and natural flow; do not impose one sentence per module, a paragraph formula, or a length cap.

Reference every active block needed to support its factual statements. Do not introduce new facts only in the overview or summarize a suspended contradiction as settled. Derived observations about current life or concerns belong in the appropriate existing modules, with source associations, as well as in the overview when useful. With no active blocks, both narrative and block_ids are empty. The detailed modules retain useful specifics that the opening selects among; they do not excuse an opening so compressed that the person is hard to understand.

### Conflict

Exactly id, module, question, affected_block_ids, and options. Each option contains exactly label, narrative, and source_ids. Supply at least two supported alternatives as derived descriptions in the output language.

Existing ordinary disputed blocks are listed in affected_block_ids, suspended from rendered modules, and excluded from summary references. New competing candidates can have no affected blocks. A confirmed block remains authoritative when ordinary evidence proposes a change, so it need not be suspended; explain the alternatives without claiming the confirmed statement was revoked. Do not use an empty affected list to leave an ordinary disputed conclusion active.

### Source exclusions

excluded_source_ids contains generated local source IDs, created only for an explicit exclusion request. Remove excluded source records, associated source_sync entries, and dependent associations first; validation rejects reintroduction under those IDs. The agent must also avoid rereading an excluded source. The helper cannot recognize the same external account under a different local ID.

Item-level exclusions are not persisted because raw identifiers are not retained. Honor any requested narrow exclusion in the active task, and explain this recognition limit when relevant. Do not retain the forgotten text as an exclusion description or change note.

## Complete fictional candidate

Alex is a fictional display name. This compact example illustrates the format only. It is not a recommended profile length or evidence about the actual user. A real candidate should preserve all supported understanding.

~~~json
{
  "schema_version": 2,
  "revision": 1,
  "subject_id": "user-local",
  "display_name": "Alex",
  "language": "en",
  "updated_at": "2026-09-28T00:00:00+00:00",
  "sources": [
    {
      "id": "s1",
      "kind": "gmail",
      "label": "Gmail",
      "scope": "Received and sent correspondence about products, clients, and collaboration."
    }
  ],
  "blocks": [
    {
      "id": "b1",
      "module": "about_me",
      "narrative": "Alex coordinates the Harbor product's onboarding work with the design team at Cedar Labs.",
      "source_ids": ["s1"],
      "basis": "documented_context"
    }
  ],
  "summary": {
    "narrative": "Alex coordinates onboarding as part of the current product work at Cedar Labs.",
    "block_ids": ["b1"]
  },
  "conflicts": [],
  "excluded_source_ids": [],
  "last_changes": []
}
~~~

Do not copy the example date into a real profile; the helper sets actual update time on save. A one-observation mailbox state validates but receives a coverage review reminder, not a requirement to invent more observations.

## Localized presentation

English labels are built in. Other languages require an agent-supplied presentation object; the helper never silently falls back to English. Translate values, not keys. All narrative/source/conflict/change text must also be translated by the agent.

~~~json
{
  "language": "en",
  "labels": {
    "title": "Personal Profile",
    "updated": "Updated",
    "summary": "Profile Summary",
    "no_summary": "Insufficient evidence for an overall summary.",
    "no_evidence": "Not enough supported information for this module yet.",
    "evidence": "Evidence sources",
    "things_to_confirm": "Things to Confirm",
    "confirmation_choices": "Choose one, explain the contexts, rewrite, or skip.",
    "coverage": "Coverage and changes",
    "no_sources": "No sources reviewed yet."
  },
  "modules": {
    "about_me": "Background",
    "how_i_communicate": "Communication Style",
    "how_i_work": "Working Style",
    "what_i_prefer": "Preferences",
    "how_i_write": "Writing Style"
  }
}
~~~

The module order is fixed by the renderer even if object key order differs. Localize section headings and content as well as all other prose; section keys and block IDs remain unchanged. Language-tag validation is syntactic, not proof of natural-language quality. Review the entire output for untranslated generated text; proper product/person/organization names may remain unchanged.

## Save, check, and render

Saving accepts a derived-only candidate with the same subject and the next revision, against the revision actually read. The check reports counts and structural review hints without raw content, and rendering previews the derived profile. The helper does not translate or decide that evidence supports a conclusion.

Only for an explicitly requested repair of inadequate prose, save with --recompose-module and the applicable stable module key. Repeat it for multiple affected modules. This optional safeguard is not an initial-extraction or incremental-update requirement. Daily updates with no meaningful changes must be allowed to preserve existing prose.

The guard compares the requested module's visible body with the saved body. It ignores headings, whitespace-only differences, dates, source summaries, and block changes that never reach composed prose. If the body is unchanged or absent, it rejects the save and leaves the existing state intact. Do not bypass it by writing the state directly or omit it to label unchanged inadequate prose as a repair. If no adequate repair is supported or authorized, report the unresolved limitation. Ordinary source-only updates and intentional removal are different tasks and do not require forced rewriting.

This check detects stale text, not whether a rewrite is grounded, specific, or useful. The agent must still assess the new prose against the current module guidance and the user's complaint. A small cosmetic wording change is not evidence of a successful repair.

If a save reports a stale revision, reread and merge. Do not force overwrite or reinitialize. Invalid candidates leave the saved state unchanged. The helper atomically replaces files and creates no historical backup. After saving, render, inspect the output, and remove task-created candidate/presentation files. If rendering fails, repair it; never present an old profile.md as current.

## Migrate version 1 safely

The helper cannot render version 1. Prepare a new version 2 candidate from existing derived conclusions and any necessary transient review:

1. Preserve local subject identity, useful blocks and their IDs where appropriate, all valuable detail, accepted corrections, and genuine unresolved issues. Compose sections from that understanding rather than keeping fragmented evidence panels.
2. Convert evidence associations to general sources. Assign an appropriate basis, retaining confirmation authority through a generic user_confirmation source.
3. Remove raw evidence, excerpts, translated excerpts, source locations, external content IDs, precise message dates, item checkpoints, and copied source/account details. Do not paste them into allowed narrative fields.
4. Increment revision, resolve presentation language, validate, and save against the actual existing revision. The helper permits a v1 destination only to replace it with a strictly validated v2 candidate.
5. Regenerate profile.md. Remove known task-created raw copies and outdated rendered evidence panels without keeping a legacy backup. Do not delete original user inputs or unrelated files.

If old identity/exclusion fields themselves contain raw addresses or external identifiers, replace them with generated local identifiers through a deliberate reviewed migration; the normal save identity guard must not be bypassed casually. Describe any limitation rather than retaining raw identifiers in a supposedly derived-only state.

## What validation does and does not prove

Validation checks field contracts, references, module order, presentation completeness, duplicate exact narratives, excluded source IDs, confirmation associations, summary/conflict consistency, source synchronization metadata, and complete active-block coverage in supplied sections. It does not automatically detect a copied passage hidden inside a narrative, establish factual accuracy, prove full mailbox coverage, translate prose, or semantically deduplicate claims. The agent must review retention, attribution, relevance, status, language, and preservation of useful detail.
