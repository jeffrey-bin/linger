# Personal Wiki Extraction Prompts

The complete extraction rules for each node type are stored separately in `personal/*.md`.
[`personal-wiki-node-types.ts`](../../src/llm-wiki/personal-wiki-node-types.ts) only registers directories, fields,
sections, relations, graph types, and `promptFile`; at generation time it reads the full Markdown file, and
[`personal-wiki-policy.ts`](../../src/llm-wiki/personal-wiki-policy.ts) assembles it into the Wiki generation request sent to the Owner Agent Runtime.
Do not compress the complete rules back into a one-sentence `instructions` in the registry, and do not edit `node_modules` directly.

## Where to View and Change

| Type    | Complete Prompt                   | Source of the original stable rules                                                                                                                                                          |
| ------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session | [session.md](personal/session.md) | Historical Sessionly session interpretation and evidence boundaries; the current seven sections follow `personal/session.md`                                                                 |
| Client  | [client.md](personal/client.md)   | Cross-session merging, organization identification, evidence rules, and Client body sections from Memory `sync/client-memory/client-memory.md`; Sessionly CRM filtering rules                |
| Contact | [contact.md](personal/contact.md) | Person identification, unknown-organization handling, cross-session history, and Contact body sections from the same Client Memory template; Sessionly CRM filtering rules                   |
| Project | [project.md](personal/project.md) | Routing, grouping, continuity, project sections, and commitment rules from `sync/daily/daily.md`, referenced by Memory `sync/project/project.md` through `project-rules.ts`                  |
| Topic   | [topic.md](personal/topic.md)     | Concept/project classification boundaries from the original node registry; the old Memory had no separate Topic template, so field and section descriptions follow the current page contract |

The original templates are in [`apps/node-services/prompts/memory/sync`](../memory/sync/). The historical templates are kept to trace migration semantics; the current Session and the separate Daily/Weekly use the Prompts of their owning services.
At runtime, no role reads another role's source code or Prompts.

Every new Prompt must explain all registered fields and sections, not just list their names. The registry and JSON Schema
still decide which fields may be written; the Markdown explains what each part should contain, how to judge it, and how to handle insufficient evidence.
When rules change, update the registry, read compatibility, tests, and user-facing documentation together; keep source attribution and degree of certainty.

## Migration Adaptation, Not Restoring the Old Pipeline

- Source-specific write paths become the pages defined by this
  `wiki_projection` and the registry; do not stuff the old multi-file output envelope into single-page JSON.
- Original evidence becomes the current raw catalog, `source_refs`, and in-page citations; links between generated Wiki pages are only for navigation.
  Do not reuse old Session file paths as source evidence, and do not invent `Daily`, person, or project identities.
- Client / Contact organization and person filtering and history merging are kept; the old "read only the CRM cache, never the transcript" restriction
  becomes verifying the authoritative Raw supplied in this run. Standards such as organization/person splitting, low-confidence contacts for unknown organizations, and not merging same-name people stay unchanged.
- Project keeps coarse-grained parent projects, directions, explicit anchor routing, stable names/aliases, cross-project isolation, and status continuity.
  Old `Next Steps` go into `Open Items`; `Related People` and background such as owner, phase, and time go into
  `Project Summary`; `Routing Notes` go into `Change Log`; `Source Links` are adapted to current source citations.
  Do not sneak old frontmatter fields into the restricted JSON Schema.
- Session uses seven sections: Objective Summary, Keywords, Meeting Summary, Main Topics, Decisions And Outcomes, Action Items, Pattern. The model writes each section as a structured JSON value (Keywords and Pattern as string arrays, Meeting Summary and Main Topics as Markdown strings, Decisions And Outcomes as `{kind, text, evidence}` objects, Action Items as `{text, evidence, owner?, deadline?, resources?, priority?}` objects) plus a top-level `source_readable` boolean; the app renders the `Decision:` / `Completed:` / `Action:` / `Evidence:` labels, omits absent optional attributes, and writes `None observed.` for an empty array or string. Useful information from the old Participants/Timeline/Runtime Evidence
  goes into the evidence of `Main Topics`; explicit open questions go into topics, and commitments and follow-up work go into `Action Items`.
  Do not recreate hidden CRM/Workflow cache pages, and do not modify the stable private Profile.
- Session directly loads the English translation of the seven text rule files of `test-meeting-note 1.0.23` (including examples and self-checks), stored in
  `personal/session-meeting-note/`: the same rules, with output written in the user's language, and no separate summarized version in `session.md`.
  The generation instructions actually embed the full text of these files, and a missing or empty file fails; the model is not just given the paths.
  `session.md` only adds the Session contract, section mapping, and identity/evidence boundaries:
  first organize the layered topic body of Main Topics, then generate the complete meeting summary of Meeting Summary from the same fact inventory; when displayed, the summary comes first and the body after.
  Each of the two blocks is deduplicated on its own; do not delete independent facts from the summary to reduce overlap between them.
  Objective Summary and Keywords serve as the leading overview; results, to-dos, and Pattern keep adapting to the existing Session read contract.
  Main topics inside the two separate sections use H3, and only real sub-topics use H4; Main Topics shows open questions at the end only when there are explicit pending questions.
  A paragraph is usually 1-3 sentences, with no limit on total length; keep number pairing, source attribution, conditions, and undecided status.
  This integration covers the text body and source citations, not the Skill's PNG production or document publishing tools.
  The seven-section Schema keeps non-empty Markdown strings with no body length limit; the field descriptions of Meeting Summary and Main Topics
  also directly load the corresponding rule files, so the two fields are not left with a generic string definition.
  A description is a generation hint, not a semantic validator; a valid structure does not prove the information is complete.
  `personal/session-evidence.md` separately records the Session evidence adaptation: values are kept together with their object, unit, condition, and basis,
  multiple observations are not turned into ranges, and each of the two bodies lists quantitative records line by line within the corresponding topic and checks back separately.
  Every H3 main topic body must have a nearby source citation;
  even with a single source, listing only source_refs is not enough. Writes and candidate page validation reject topics missing citations,
  and the existing error feedback asks the model to repair them, without automatically pasting sources or filling in numbers. The seven Skill rule files are not summarized.
  For explicit Markdown layout that is double-escaped as a whole, the Session renderer only decodes line breaks, keeping inline code and text;
  ambiguous content with code fences or mixed line breaks is not processed automatically, so that format repair does not make the model re-summarize the body.
- Daily writes only the day's summary and Weekly only the week's activity; do not restore the old Daily's User/Project/Workflow write responsibilities,
  and do not restore the old Weekly's Workflow promotion. What was migrated is the content rules they owned, not the retired storage model.

## Daily / Weekly Have Two Prompt Layers

The leading Memory summaries are still generated by their owning service and keep the original JSON/source contract:

- [`daily-summary.md`](../memory/sync/daily/daily-summary.md)
- [`weekly-user.md`](../memory/sync/weekly/weekly-user.md)

These two also keep the old templates' detailed definition of each section. Daily/Weekly are generated independently by Memory's periodic report runner and published as PostgreSQL Raw sources; they are not Wiki node types, and their Prompts are not maintained in this directory.

## Validation and Deployment

- `personal-wiki-prompts.llm-wiki.test.ts` checks that each type's complete Markdown is injected and every field/section is described,
  and locks the key semantics of the original Project, CRM, Session, Daily, and Weekly rules.
- Runtime Wiki backend tests check that the request actually sent contains the detailed rules; Memory `wiki-period-scope.test.ts`
  checks that `--wiki-only` really loads the detailed Daily/Weekly templates while keeping the original write scope.
- A missing or empty Prompt must fail; it must not silently fall back to a one-sentence description.
- Both `src/` and the compiled `dist/` read assets from `prompts/llm-wiki/` at the node-services package root.
  The Docker runtime image copies this directory explicitly; copying only `dist/` is not enough to deploy the full generation capability.
- These tests verify rule assembly and the structural contract; they do not replace quality regression on real model output.

## Pattern: Session / Meeting → Daily → Weekly

`Pattern` is a required section of Session and of the separate Daily/Weekly reports; with no qualifying observation the app renders
`None observed.`. It is not an entity, a private profile, or an executable rule, and adds no separate storage.

Keep only useful explicit work requirements, judgment criteria, preferences, or concrete working methods. Usually 1-3 short observations;
no seven-category form to fill, no padding the count, and no hard truncation of important signals. Each one combines content, scope, status, and source;
ordinary questions, confirmations, interests, and task progress stay in the body. A one-time request does not become a permanent preference, and a generic
"view → compare → confirm" sequence does not automatically become a Pattern.

- Session: extract only observations that can be confirmed to belong to the target user; when identity or attribution is unknown, do not infer from other people's remarks.
- Daily: aggregate the day's valid observations; stay compatible with old Session's separate sections and old input lacking Pattern.
- Weekly: summarize repetitions, changes, withdrawals, and conflicts supported by independent evidence, keeping the original dates and scope.
- The same original remark is not counted repeatedly because of multiple summaries or snapshots; do not infer hidden psychology, and do not automatically update the private Profile.

Newly generated Sessions must satisfy the seven-section Schema; safely published history inherited unchanged still follows the candidate validation's
compatibility rules, and unrelated refreshes are not forced to rewrite history. When actually updating an old page, keep every fact that still holds in full,
merge the old objective into Main Topics, merge the original decisions/completed results into a short index, and keep the complete Meeting Summary separately.

Tests cover seven-section writes, inheritance and post-edit validation of old pages, old and new reads of recall cards, periodic Prompt assembly,
and the source and non-empty Pattern constraints. Coverage, duplication, status accuracy, and latency of real models are compared separately on samples.
