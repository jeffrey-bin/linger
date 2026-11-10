# Merge, conflict, and lifecycle rules

## Incremental updates without raw archives

This is the normal maintenance path after the initial profile. A daily update begins with newly available information, not a fresh reconstruction of the whole person. Initial extraction remains the primary workflow in SKILL.md; a quality complaint or explicit full rebuild is a separate task.

1. Read the current Profile with `teamhub personal-profile show` and note its `revision_id`. Identify the authorized update interval and sources that can have new or changed material. A newly connected source may receive its own focused first pass without rebuilding existing sources.
2. Read eligible changes using the connector's supported change feed or time filters. No scan boundary is stored, so use the period named in the request or a disclosed bounded recent window appropriate to the cadence; do not automatically restart historical extraction.
3. Open earlier related context only when a new item needs it: to resolve identity, connect a product and organization, interpret a change in status, or evaluate a consequential contradiction. Unrelated old threads and every previously sparse module are not part of the daily scope. A bounded overlap can account for retrieval granularity; deduplicate derived meaning without saving message IDs.
4. Classify the effect of the new material: no useful change, independent support for an existing pattern, complementary detail, a new fact or practice, a status change, or a genuine contradiction. Repeated notices about one event are not independent support. One event need not become a stable preference or habit.
5. Integrate supported changes into existing observations and connected passages. Preserve names and responsibility boundaries, retain relevant history with its status, and keep unrelated detail intact. Update Background's opening only when its claims are affected. Do not append a daily message log or rewrite all modules to make the profile look fresh.
6. When something changed, compose the complete merged JSON document, write it with `teamhub personal-profile write --base-revision <revision_id> --file <draft.json>`, and inspect the affected passages. Report which period and sources were actually read. With no meaningful new understanding, do not write; zero or one new observation is a valid daily result. Do not widen historical reading simply because nothing changed.

Use the same claim-specific support, authority, and privacy rules as initial extraction. A new role can change current work without erasing useful history; a parallel engagement need not replace existing employment. If a change affects multiple passages, update those dependents together. A direct user correction overrides prior ordinary evidence within its scope.

Preserve historical access limitations, and do not promise exact-once ingestion or detection of changes unsupported by the connector. Reading a source without new understanding does not require inventing profile content.

## Preserve meaning when merging

First distinguish duplicate material and events, equivalent meaning, complementary detail, contextual differences, and real changes over time. Only then consider contradiction. More messages or more sources do not win a vote.

| Situation | Action |
| --- | --- |
| One event appears in replies, a forward, and an automated notification | Treat it as one event in transient analysis, not repeated behavior. Save only the derived understanding. |
| Two independent statements establish the same preference in the same context | Keep one complete narrative and its general source associations. |
| Incoming mail establishes product scope; the user's reply describes their responsibility | Combine the supported relationship or keep complementary observations. Preserve both meanings. |
| One person owns different aspects of several products | Keep product and responsibility distinctions; do not compress them to a generic industry label. |
| Short internal updates and detailed client explanations | Preserve the audience difference. |
| A role is explicitly shown to replace an older one | Update current status; retain concise relevant career history with its time context. |
| Another role or client engagement is active concurrently | Keep both in the current-work account, grouped by company or engagement. Do not manufacture a career transition. |
| An offer follows ongoing employment correspondence | Retain the offer's status; do not assume departure, acceptance, or a completed transition. |
| Contemporary, equally applicable preferences cannot be reconciled | Suspend the ordinary disputed conclusion and present derived alternatives for confirmation. |
| A task asks for brevity while the user generally wants full analysis | Follow the task without rewriting the broader preference. |
| Equivalent understanding appears in different languages | Merge meaning while retaining useful detail and authority; translation creates no new evidence. |

There is no maximum number of observations. Merge to remove true repetition, never to hit a size target. Preserve useful unaffected content. The reading layout may combine several related observations into one connected paragraph without merging away their distinct meanings or support. Background's opening makes the person's present understandable; the modules retain the full detailed account.

## Authority depends on the kind of claim

- Explicit current user corrections and confirmations control the accepted understanding within their scope. Apply them directly; do not ask the same question again.
- An explicit preference supports the preference. Repeated attributable behavior can support a contextual pattern but does not automatically override a confirmed preference.
- Clear correspondence, shared documents, and records can establish the subject's context, responsibilities, behavior, choices, and scoped preferences without being user-authored. Evaluate reliability, attribution, time, and status for each conclusion rather than making self-authorship a universal requirement. An explicitly requested coverage correction may revisit previously omitted material. Routine updates do not reopen unrelated history merely because earlier coverage was partial, and rewriting prose alone does not broaden source coverage.
- Different audiences, periods, or tasks often explain variation. Preserve those distinctions instead of inventing conflict.
- Recency is a clue, not automatic authority. A newly received old document is not a new event.
- Silence is not confirmation. Skipped questions remain pending.

If ordinary evidence differs from confirmed understanding, keep the confirmed understanding within its scope and surface the proposed change. If ordinary equally applicable conclusions conflict, leave the affected conclusions out of the published Profile. Preserve independent, undisputed portions where possible.

## Things to confirm

The published Profile has no confirmation section. Raise only genuine unresolved contradictions that matter: in a Task, list them in the final report so the Meta can ask the Human; in the Meta, ask the Human directly. Explain the competing understandings in the Human's language and name their general sources. Do not quote or reconstruct emails, retain confirmation wording, or attach message-level evidence.

A fictional example: two possible preferences for internal weekly updates are detailed background and risks, or key changes followed by next steps. Ask which currently applies, or whether each applies in a different setting. The user can choose, explain contexts, rewrite, or skip.

After an answer:

1. Write the accepted derived understanding into the affected passage. Do not store the original reply, its locator, or its timestamp as evidence.
2. Preserve the context the user supplied; do not turn a scoped answer into a universal rule.
3. Update the affected passages and Background's opening. Keep distinct useful facts and genuine unresolved questions.
4. If skipped, leave the disputed conclusion out without restoring an ordinary disputed inference.

## Targeted recomposition for an explicit complaint

Use this path only when the user explicitly requests correction of an inadequate section. Ordinary incremental updates and installation of updated Skill guidance do not activate it automatically. A user may reject abstraction, emphasis, tone coverage, continuity, or point titles even when the facts remain unchanged. Preserve confirmed understanding and unaffected detail while repairing that stated scope.

1. Identify the affected module and the current acceptance criterion before deciding whether there is nothing to update. Read its actual text in `teamhub personal-profile show`, not just a change note.
2. Read the current module-specific guide and reassess observations for the missing dimension. For Communication Style, task descriptions are not expression choices or tone. For Working Style, professional beliefs, responsibilities, and product capabilities are not a complete account of the subject's actual operating practices. New detail about rhythm, decisions, handoffs, tool functions, or contextual differences is complementary understanding, not a duplicate merely because it concerns the same project or source.
3. If the support is sufficient, write the affected passage afresh, preserving grounded facts and scope. If it lacks the needed expression or process detail, make targeted reads of relevant authorized material using those specific gaps. Do not substitute unrelated background checks, invent a workflow from a job title, or copy a reference profile's conclusions. If access is unavailable, state the actual limit and keep the account appropriately bounded.
4. Replace the affected passages in the complete document, update Background's overview where needed, and migrate any stale structure to the published fields.
5. Write the document, then compare the repaired module with the previous text against the specific complaint. An unchanged body does not repair it even when a title or date changed, and a changed adjective or vague sentence can still fail review. Record new-source reading separately from improved synthesis, and explain actual unresolved gaps rather than claiming they were filled.

Do not trigger an unnecessary private-source rerun for an instruction-only Skill revision. The workflow above governs subsequent profile execution and any profile repair actually included in the authorized task.

## Updating the subject name

Use an explicit preferred name first, otherwise the verified display name, then a reliably extracted name. A name correction keeps the same person and facts. Update the `name` field and every passage that uses the name, and update the Account name with `teamhub account-profile update --name` when the Human asks for it. Rewrite second-person prose naturally without changing facts or removing detail. Do not confuse a collaborator, signature persona, or sample name with the profile subject.

## Output language

The published Profile is always English (see [TeamHub publication](teamhub-publication.md)). Translate a non-English baseline into English while keeping its facts, names, and confirmed understanding; do not keep parallel profiles in other languages.

Translation is not new evidence. Do not re-read personal sources solely to translate already-derived understanding, infer a permanent language preference, or keep original source quotes as a translation aid. Check that details and uncertainty survive translation.

## Explain, correct, remove, and forget

**Explain:** describe the conclusion's support type and general source scope. Be transparent that exact messages are not retained. Do not fabricate a quotation or a source link. If the user explicitly wants renewed verification, re-read only authorized relevant material and continue to avoid retaining raw copies.

**Correct:** apply a clear replacement directly. If the user says a conclusion is wrong without a replacement, remove or suspend it first. Do not require proof of the correction.

**Remove a conclusion:** delete it from every affected passage, including Background's opening. **Forget information:** also remove synonymous or translated versions and any draft file. Reports to the Meta must not preserve the forgotten content in disguise. Preserve other useful unaffected understanding.

**Stop reading a source** and **delete information derived from it** are different requests. Follow the actual request. Deleting source-derived information removes the conclusions no longer supported; keep independently supported understanding only when consistent with the user's request.

Nothing records an exclusion between runs. For an explicit source-wide exclusion, remove what it alone supports and tell the Meta so it can name the exclusion in later Task requirements. For an item-specific exclusion, honor it during the active task without saving raw item identifiers or forgotten details. Explain the limitation if persistent recognition is requested; do not claim to recognize every future reappearance without retained identifiers.

Do not delete the user's original emails/files or unrelated backups. Delete the transient draft file after the write. Tool/provider histories and other systems are outside this Skill's erasure control.
