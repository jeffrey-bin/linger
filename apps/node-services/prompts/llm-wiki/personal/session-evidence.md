# Session Evidence Adaptation

Write the output in the user's language (the language the meeting or conversation was held in), but keep the `[[source:<raw_ref>]]` citations exactly as written: the app resolves them literally.

The following only adds the mapping from the original Skill's information inventory to Wiki sections; it does not replace the original content rules and adds no page fields.

- Write each quantitative fact in the source inventory back into its topic as one unit of "object/scenario + value and unit + condition/basis + source position".
  Keep averages, single observations, targets, estimates, and assumptions separate; keep duration and throughput for the same scenario paired.
  Do not merge different observations into a min-max range, do not keep only the duration and drop the quantity, and do not write throughput as a hit count.
  Objects and measure words must follow the source and its explicit context: counts of people, companies, amounts of money, and so on must not be generalized into "items" or have their object omitted.
  When the source gives only an approximate value, keep the approximation qualifier; when the source contradicts itself, state the contradiction and do not correct it arithmetically or fill in missing values.
- Write the original Skill inventory items that contain quantitative facts as an explicit "quantitative record" list or table inside the corresponding topic of both Meeting Summary and Main Topics;
  one row per independent observation, fully keeping the object, grouped values, units, conditions, and position.
  When the transcript adds to the same observation over several sentences, combine them in the same row; list average figures and single observations separately.
  Do not list only a few durations and leave the reader to find throughput in another section, and do not replace the record with a category such as "took a long time".
  This is layout inside the two existing bodies; add no top-level section or field, and do not output the internal working inventory.
  After finishing both bodies, check back as the original Skill requires: every inventory item with quantitative facts must have
  a complete corresponding row in each of the two bodies; when an object, paired value, or unit is missing, complete it before submitting.
  Ordinary timestamps and content-free verbal repetition are not quantitative facts; deduplication must not delete new observations or bases.
- Every H3 main topic in Meeting Summary and Main Topics must cite the corresponding
  `[[source:<raw_ref>]]` inside that topic's body and keep the time or position the source provides. Cite nearby even when there is only one source.
  Do not substitute frontmatter source_refs, another topic's citation, or a single citation at the end of the whole text.
  Without H3, the whole body must still have a citation; use an empty string only when there is truly no substantive content, and do not use empty values to avoid topics that have content.
  Citations must point to a selected source that actually supports the fact; markers inside code examples do not count as citations. Writes reject topics that lack citations.
- A recording cites its transcript.

## Fact Coverage Before Abstraction

Read each supplied source through its actual end; a bounded file read is
not proof of EOF. Build a source-order working inventory before composing prose.
Include every independent fact, constraint, reason, correction and explicit request,
even if brief, peripheral, about another participant, or at the end. Only filler
and semantic duplicates may be omitted. Do not output the inventory itself.

Write each fact in the source language, retaining exact names for its objects and
resources. Preserve every independent condition. For explicit follow-ups retain
the deliverable, recipient, delivery method, owner, deadline and actual status when
supplied; do not replace specific resources or requests with broad categories.
Do not reduce the full discussion to a few topic-level conclusions. Check every
inventory item against both body views before writing, including closing logistics.

Keep speaker, event subject and represented Human separate. A question belongs to
its asker; its answer may describe someone else. Preserve named or numbered
transcript speakers when no binding exists. Attribute Agent explanations and
recommendations to the Agent; do not turn them into user beliefs or verified facts.
Preserve negation, uncertainty, and planned versus completed status. Ordinary facts
belong in the body regardless of Pattern eligibility.

For every event or deadline, retain the source time expression and its source
message/session date as an anchor. Distinguish occurrence time from mention time.
Resolve relative dates only when unambiguous and keep the original wording plus
anchor alongside the resolved date. For ambiguous times retain that ambiguity;
never substitute the generation date or silently discard the time expression.

Complete the factual body first, then extract Pattern using its supplied gates.
Do not filter the working inventory or factual body by Pattern eligibility.
