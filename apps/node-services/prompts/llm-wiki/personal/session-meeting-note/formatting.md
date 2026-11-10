# Body Formatting Rules

## Recommended Structure

- Each heading is on its own line and progresses through `#`, `##`, `###` without skipping levels.
- Each key point uses `- **Short title**: one specific explanation.`.
- Put different objects, reasons, conditions, and results in separate items; indent sub-lists only for real containment.
- Paragraphs are usually 1-3 sentences. Split long sentences, and do not insert manual line breaks for screen width.
- Leave blank lines between headings, paragraphs, images, and lists; do not simulate layout with repeated spaces, blank lines, or code blocks.
- Bold covers only a short title or keyword, with punctuation outside the bold; no Markdown asterisks may show in the final body.

## Checks While Generating

- Is there a hierarchy of "top-level topic → sub-topic → short point → necessary explanation"?
- Are several views or objects packed into one large paragraph? If so, split them into sibling items or real sub-items.
- Do cards and the summary first state the object clearly and then the specific content? Abstract words must not stand alone as an item.
- When information does not fit, increase paragraph or card height or reduce the number of columns; do not delete subjects, objects, conditions, or results.

## Checks After Publishing

Use an actual Markdown preview to check the summary, the deepest level, long lists, images, and to-dos: bold renders, list levels are intact, no heading or image syntax is exposed, and no text is truncated. If preview is not possible, state truthfully that the display is unverified.
