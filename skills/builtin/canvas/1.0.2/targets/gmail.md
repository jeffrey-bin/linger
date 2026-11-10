# Target: gmail

A gmail canvas is for a new email only. To answer an email someone sent, use
`teamhub gmail reply` instead; a canvas draft does not join that thread.

Fields in the canvas header:

- `to`: recipient emails, separated by commas only (never semicolons).
- `cc`: carbon-copy emails, separated by commas only; may be empty.
- `subject`: one line.

The email body is everything after the header block. Images in the canvas go
into the email body as inline images, exactly as they appear in the canvas.
File blocks in the canvas go as attachments, under their file names; their
lines do not appear in the body. Attach files only through the canvas: never
use `teamhub gmail send --attach` or `teamhub gmail draft --attach` for a
canvas email, since the draft and the email are rebuilt from the canvas.

## Save as a draft (default)

```
teamhub gmail canvas-draft <document-id>
```

It reads `to`, `cc` and `subject` from the header (pass `--to`, `--cc` or
`--subject` only to override) and returns `draftId`. It never sends.
A draft may have no recipients yet; it needs a subject.
Then set the header lines `status: draft`, `external_id: <draftId>` and
`link: https://mail.google.com/mail/#drafts`, one `str_replace` per line.

The user asks for changes after a draft exists: edit the canvas, then update
the same draft instead of creating a new one:

```
teamhub gmail canvas-draft <document-id> --update <draftId>
```

A successful `canvas-draft` is the confirmation: the draft is exactly the
canvas, `inlineImages` counts the images it carries and `attachments` names
its attached files. Do not read the draft back from Gmail; check it there
only if these differ from the images and file blocks in the canvas or the
command fails. Finish the canvas changes a request asks
for, then update the draft once, not after every edit.

Images must stay under 5 MiB in total; shrink large ones first (for example
with `imagemagick`). Attachments must stay under 15 MiB in total; for larger
files, share a link in the body instead.

## Send

- A draft exists (`external_id` is set): `teamhub gmail send --draft <draftId>`.
  The email goes out exactly as the draft, inline images and attachments
  included. If the canvas changed after the draft was saved, update the draft
  first.
- No draft yet and the user says to send now: save the draft first with
  `teamhub gmail canvas-draft <document-id>`, then send that draft.

Then set `status: sent` (keep `link`).

## Authorization

If Gmail is not connected, the command posts an authorization card in the
chat and stops. Tell the user to connect Gmail on the card, then run the same
command again.

## Unknown result

When an external write's outcome is unknown, do not rerun it blindly:
rerunning submits the write again whatever its `--operation-id`, and only a
confirmation-card command with the same `--operation-id` returns the same
card. Check the result in Gmail first, and submit again only after confirming
the write did not take effect.
