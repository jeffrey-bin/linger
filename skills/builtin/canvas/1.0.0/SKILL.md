---
name: canvas
description: Draft content that will be sent to an outside platform (first target - a new Gmail email) on a canvas the user watches and edits in the Room side panel. Use when the user asks you to write or prepare a new email; reply to an existing email with teamhub gmail reply instead.
---

# Canvas

A canvas is an ordinary Room Document that the user sees open in the side
panel while you write. You and the user both edit it; when the user decides,
you deliver it to its target platform. Targets are listed under `targets/`;
read the matching guide before delivering.

## Shape

The first block is a fenced code block that starts with `canvas: <target>`,
followed by `key: value` lines, one per line. Everything after it is the content
to deliver.

````markdown
```
canvas: gmail
to: lisa@acme.com
cc:
subject: Following up on last week's quote
status: editing
link:
external_id:
```

Hi Lisa,
...
````

Shared lines for every target:

- `status`: `editing` while drafting, `draft` once saved on the platform as a
  draft, `sent` once delivered.
- `link`: an `https://` link to the draft or delivered item, when you have one.
- `external_id`: the platform's ID for the draft or item.

The target guide lists its own fields. Write every line when you open the
canvas, leaving a value empty rather than inventing it, so each can later be
filled in place; ask the user for anything you need.

## Open a canvas

1. Write the canvas to a local Markdown file and create the Document:
   `teamhub docs create --title "<short title>" --file ./canvas.md`.
   Put every image the content needs in that Markdown, where it belongs in
   the body (`![Card](./card.png)`, path relative to the Markdown file);
   `docs create` uploads it into the canvas.
2. Open it for the user with a canvas message (it also shows as a card):

   ```json
   {"segments":[{"type":"document","document_id":"<document-id>","content":"<short title>","presentation":"canvas"}]}
   ```

   `teamhub message send --message-file ./open-canvas.json`

Open one canvas per piece of content and keep working on the same canvas for
follow-up requests. Everything that goes out with the content, images
included, lives in the canvas: never paste the body into the chat and never
send its images as chat attachments. If an image cannot be placed in the
canvas, say so plainly instead of posting it in the chat.

## Edit while the user watches

- Every request to change the canvas (rewrite the text, change one paragraph,
  replace an image, ...) starts by reading the latest canvas, because the user may
  have edited it since: `teamhub docs get <document-id> --format blocks -o ./canvas.json`.
  This gives the current text and the block IDs; the first block is the canvas header.
- Within that request, an edit that returns `"status":"applied"` succeeded; make the
  next change without reading the canvas again. Read it again only when an edit is
  rejected as a conflict, when you need the ID of a block you just added (for example
  an image you will replace later), and once after your last change to check the result.
- Change content with `teamhub docs update <document-id> --command <action>`
  (`block_replace`, `block_insert_after`, `append`, `str_replace`, ...).
- Change one header line with `str_replace` on that line, narrowed to the
  header block: `--block-id <header-block-id> --pattern "subject: Old" --content "subject: New"`.
  `str_replace` changes one line at a time and its text cannot contain a line
  break, so change several header lines with one `str_replace` each.
- Make small, frequent edits so the user sees progress.

## Images

Images live in the canvas as image blocks (PNG, JPEG, GIF or WebP, up to 10 MiB).

- Add one: `teamhub docs image put <document-id> ./card.png --after <block-id> [--caption "..."]`.
- Change one (recolor, crop, a new version): save the original with
  `teamhub docs image get <document-id> <image-block-id> -o ./original.png`, make the new
  image, then `teamhub docs image put <document-id> ./new.png --replace <image-block-id>`.
  The image keeps its place and width.
  - Crop, resize, rotate, recolor or compress with the `imagemagick` skill.
  - Generate an image, or change it by description (new background, new style), only
    with your model's own image generation, using the original as reference. If you
    cannot generate images, say so plainly and offer what `imagemagick` can do.
- Undo a replacement: the previous image stays available for about a day. Find its Asset
  in the earlier `--format blocks` export and put it back with
  `teamhub docs update <document-id> --command image_replace --block-id <block-id> --asset-id <old-asset-id>`.
- Image block IDs and Assets come from `teamhub docs get <document-id> --format blocks`.

## The user's edits win

The user may type in the canvas at the same time. An edit made against an
older version is rejected as a conflict: never retry it blindly and never
overwrite what the user wrote. Read the canvas again, keep the user's text,
and redo only what is still needed. If the user changed something you were
asked to change, follow the user's version.

## Deliver

The conversation decides what happens; there are no buttons. Follow the
target guide for the exact commands:

- If the user has not said how to deliver, save it on the platform as a draft.
- If the user says to send it, send it.
- After delivering, update the header: `status`, `link` and `external_id`.
- Tell the user in one short sentence what you did and where to find it.

Only report a draft or delivery as done after the command succeeded.
