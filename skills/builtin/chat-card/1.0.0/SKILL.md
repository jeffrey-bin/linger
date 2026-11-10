---
name: chat-card
description: Show something right here in the chat as a live HTML card - a quick chart, dashboard, checklist, tracker, small calculator or tool, or any result clearer drawn than written. Use it whenever the person wants to look at or use something in the conversation now ("draw it", "a checklist I can tick", "give me a timer"), and read it before writing any HTML fragment. Covers the card's shape, fixed width, theme colors and fonts, and how to send it with teamhub message send. A file people keep, share, print or present uses the artifact skill instead.
---

# Chat cards

A chat card is an HTML fragment sent inline in a message. The chat renders it
inside its own card frame, in the app's theme, at the width of every other chat
card. Never send this kind of piece as an .html file or a generated image.

## Card or file

- Card: the person looks at it or uses it here, now (a chart of numbers they
  just gave, a checklist for this week, a timer, a quick comparison).
- File (artifact skill): the piece is for other people or for later - to
  share, print, present or keep (a poster, one-pager, report, landing page) -
  or the person asks for a file, page or link.
- When both fit, send the card and offer the file in one line.

## Send it

Write the snippet to a file under your workspace, then send it:

```
teamhub message send --message '{"segments":[{"type":"fragment","title":"Weekly sales","content-path":"./playground/weekly-sales.html"}]}'
```

- `title` is one plain line of at most 120 characters. Previews and quotes show
  it; do not repeat it as a heading inside the card.
- A segment carries exactly one of `content` (inline HTML/SVG) or
  `content-path` (a UTF-8 file). Keep the whole card under 2 MiB.
- Put a one-line text segment before the fragment when the card needs a lead-in.

## Shape

- A compact HTML snippet, not a document: no `<!DOCTYPE>`, `<html>`, `<head>`
  or `<body>`. Scripts and `<style>` blocks are fine.
- Width is fixed at 500px (narrower on a phone), whatever the card shows. The
  outer element fills it with `width: 100%` and sets no `width` or `max-width`
  of its own; inner blocks share the width with flex so they narrow together.
  Use `box-sizing: border-box` and let content wrap.
- Height follows the content: no fixed height, `100vh` or overflow scrolling on
  the outer element.
- The chat already draws the frame (surface, border, rounded corners, shadow)
  but adds no padding. The outer element draws no border, border-radius,
  box-shadow or background of its own, and pads its content with
  `padding: 16px` like every other chat card. Only content meant to run edge to
  edge (a chart, an image, a full-width color band) may use 0 padding, and any
  text inside it still keeps 16px from the edge.
- Icons are text labels or inline `currentColor` SVG, not emoji. Remote images
  need stable public URLs.

## Theme

Never hard-code colors or fonts - no hex, rgb or named colors, no font-family.
The chat injects these variables so the card matches the app and follows its
light or dark theme. Each has one role:

| Variable | Use |
|---|---|
| `--color-background-primary` | control surfaces inside the card (the card itself is already this color) |
| `--color-background-secondary` | low-emphasis blocks, tracks, chips |
| `--color-text-primary` | main text and icons |
| `--color-text-secondary`, `--color-text-tertiary` | secondary text, axis labels |
| `--color-border-tertiary` | dividers and borders inside the card |
| `--color-accent` | accent text, borders, indicators, progress, the main data series |
| `--color-on-accent` | text on a filled accent surface |
| `--color-text-success`, `--color-text-warning`, `--color-text-danger`, `--color-text-info` | status, and extra data series when one accent is not enough |
| `--color-focus` | focus rings |
| `--shadow` | shadows |
| `--border-radius` | corners |

Background variables are never text colors. The font is inherited
(`var(--font-sans)`); form controls take `font: inherit`.

## Example

```html
<div style="width:100%;box-sizing:border-box;padding:16px;color:var(--color-text-primary)">
  <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--color-text-secondary)">
    <span>3 of 5 done</span><span>60%</span>
  </div>
  <div style="height:6px;margin-top:6px;border-radius:3px;background:var(--color-background-secondary)">
    <div style="width:60%;height:100%;border-radius:3px;background:var(--color-accent)"></div>
  </div>
</div>
```
