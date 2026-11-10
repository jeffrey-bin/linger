# Meeting Summary

Write the output in the user's language (the language the meeting or conversation was held in).

Goal: following the actual order in which the meeting progressed, produce a **complete, deduplicated, readable** summary of the content. Compress only verbal repetition and repeated persuasion; do not infer, add, or create conclusions.

## Fixed Structure

Use the levels below; when there is little content, levels that are not needed may be omitted:

```markdown
## Meeting Summary

### Topic one [time range]

One sentence describing what this topic discusses.

- **Key point A**: specifically describe the object, current state, or discussion result.
  - **Reason or premise**: the reason, limit, or condition the source explicitly mentions.
  - **Additional information**: a different object, case, number, or view.
- **Key point B**: another independent piece of information.

### Topic two [time range]

...
```

- `###` holds only sibling main topics; use `####` only when the source has a real subordinate relationship.
- Order headings by when substantive discussion first began. When a topic comes up again, merge it back into the original topic and organize it as "proposal → addition/objection → correction/result".
- Each list item expresses one main idea. List different objects, reasons, limits, examples, views, or results separately instead of packing them into one long sentence.
- Each paragraph is usually 1-3 sentences; when it gets too long, split it into short sentences or sub-items. Leave blank lines between headings, paragraphs, and lists.

## Information Coverage

Read the transcript segment by segment and build an internal inventory: source position, independent information, attribution, and whether it has been written. The following must not be omitted:

- the object of discussion, current state, and necessary background;
- options, approaches, and the reasons they were proposed;
- conditions, limits, numbers, and concrete examples;
- dissenting views, negations, changes, and the final state;
- unconfirmed content and explicit actions.

Merge content with the same meaning, but any new information must be folded in. Secondary content may be brief, but must not shrink to a category name, and must not appear only in the summary image or the later body.

## Factual Boundaries

- Suggestions, tentative arrangements, personal views, consensus, and decisions keep their original attribution.
- Preserve statuses such as "uncertain", "to be confirmed", or "not yet tested".
- Do not merge several views into consensus, do not write goals as commitments, and do not add reasons or causation the source does not have.
- Check numbers, units, names, and proper nouns against the source.

## Optional Images

Only when the source explicitly contains a process, branch, or subordinate relationship, and an image would reduce the cost of understanding, add a flowchart or mind map under the corresponding topic: generate SVG first, then render PNG, and keep the complete editable text next to the image. Every node and connector in the image must be grounded in the source; when unsure, use text.

## Check Before Finishing

For each item in the source inventory, find the specific sentence or sub-item in the summary; then check each summary item back against the source. Merge duplicates, restore omissions, and delete inferences. Do not claim complete coverage until this item-by-item check is done.
