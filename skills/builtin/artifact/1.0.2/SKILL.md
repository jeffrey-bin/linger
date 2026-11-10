---
name: artifact
description: Make a designed file people keep, share, print or present - a poster, flyer, invitation, announcement, one-pager, infographic, visual report or summary page, explainer, landing page, or a dashboard or interactive tool meant to be opened outside this conversation. Use it when the user asks for such a piece by name ("a poster for the hiring push", "a one-pager on Q3"), when the work is finished output meant for other people (a team, a manager, a meeting, a channel), or when the user asks for a file, page or link. Something to look at or use right here in the chat, now (a quick chart, dashboard, checklist or small tool), is not a file - send it inline as a chat card with the chat-card skill instead. Slide decks, Word documents and spreadsheets use their own skills. Builds one self-contained HTML file and covers the treatment, responsive or fixed-canvas layout, design fundamentals, and a render check.
---

# Designed visual pieces

## When to make one

Make the piece when:

- the user asks for it by name ("a poster for the hiring push", "a one-pager
  on Q3");
- a visual page would be clearer than a chat reply: numbers to compare, a
  process to show, an overview to scan;
- the result is finished work for other people, such as an update for the
  team, a summary for a manager or the case for a decision, also when the
  request is phrased as a question;
- the request names who will see it or where it goes (a meeting, a channel,
  the whole company);
- people will use it rather than only read it: fill it in, track progress,
  check live numbers.

When the user only wants your answer or opinion, or the result may be passed
on but nothing says so, reply in the chat and offer the piece in one line.
When the person wants to see or use the piece right here in the chat, now,
do not make a file: send it inline as a chat card (see the chat-card skill).
Writing that people will keep editing as text (a memo, a plan, meeting notes)
goes into a document; pieces made to be looked at or used come here.

Build it as one HTML file, because it previews anywhere and can be printed or
turned into an image, and talk to the user about the piece.

The piece may be opened in a narrow preview pane, a browser, or a phone. It
must look deliberate at every width and never need sideways scrolling.

## The file

Write one self-contained `.html` file: a full document (`<!doctype html>`,
`<meta charset="utf-8">`, a viewport meta, `<title>`), with its CSS and JS
inline. Embed images as `data:` URIs or keep them next to the file and use
relative paths. Load a library from a CDN only when it does real work (a chart
or map library), pinned to an exact version.

## Start from the user's own material

Before designing, use your workspace tools (the documents and files available
to you, and the user's knowledge search; see the `teamhub-files` skill and
your instructions) to check what the user already has:

- brand guidelines, logos, colors, fonts and templates;
- documents and data about the topic;
- photos of the company, team or product.

Knowledge search covers text only, so look for images and design files among
the files. Count content only if it is about the same topic and period; the
organization's own brand guidelines, logos, colors, fonts and photos count for
any piece made for that organization. Build the piece with what you find.

## 1. Choose the treatment

Decide what the page is for before designing it.

- **Document pages** (report, memo, plan, explainer): calm and readable. Real
  type hierarchy, considered spacing, a restrained palette, no big hero.
- **Showcase pages** (landing page, poster, invitation, announcement): a
  distinct visual identity with one bold idea, kept quiet around it.
- **Tools and dashboards**: information design first. Summary before detail;
  state shown by form (chips, colored markers) as well as numbers; controls
  that look clickable; open in a realistic working state with real or clearly
  marked example data. Semantic colors (good, warning, critical) are separate
  from the accent.

When the user or their organization already has a design system or brand
(logo, colors, fonts, a template), apply it; the user's own words come first,
then that system, then your choices. Ground every other choice in the
subject: its own materials, terms and units, and include at least one detail
only this subject would have (its real units and scales, its document
conventions, its terms of art) as content, not ornament. Use real content;
never use placeholder text.

## 2. Layout that fits any width

Decide the layout by how the piece is seen. A piece taken in as one composed
frame, where the arrangement itself is the design and people will screenshot,
print, project or forward it as an image, uses a **fixed canvas**: design at
one size and scale the whole frame to the window. Choose the ratio from where
it will be seen: 4:5 or 1:1 for chat and phones, 16:9 for screens, a paper
size for print. A piece that is read, scrolled or operated uses a **fluid
page** that reflows to any width.

A **fluid page**:

- Works from about 360 px (phone, narrow side panel) to wide desktop. The page
  body never scrolls horizontally.
- Side padding of at least 16 px at every width; running text about 60–75
  characters wide (`max-width` in `ch` or `rem`).
- Build rows with flex or grid and `gap`; let them wrap or stack to one column
  when narrow (`grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr))`
  or a media query). Give text-holding flex/grid children `min-width: 0`.
- Relative units; `max-width: 100%` on images, video and fixed-ratio boxes;
  nothing with a `min-width` wider than a phone.
- Only wide tables, code and diagrams may be wider, each inside its own
  `overflow-x: auto` wrapper.
- Size type with `clamp()` so big numbers and headings shrink on small screens.

A **fixed canvas**: design at the real size (e.g. 1080 × 1350 px for 4:5, or
297 × 420 mm for A3) inside one stage element, and scale the whole stage to
the window so it always fits without scrolling sideways:

```html
<div class="stage-wrap"><div class="stage" id="stage">…</div></div>
<style>
  html, body { margin: 0; }
  .stage-wrap { width: 100%; overflow: hidden; }
  .stage { width: 1080px; height: 1350px; transform-origin: top left; }
  @media print { .stage { transform: none !important; } .stage-wrap { height: auto !important; } }
</style>
<script>
  const stage = document.getElementById("stage");
  function fit() {
    const s = Math.min(1, document.documentElement.clientWidth / stage.offsetWidth);
    stage.style.transform = `scale(${s})`;
    stage.parentElement.style.height = stage.offsetHeight * s + "px";
  }
  addEventListener("resize", fit); fit();
</script>
```

## 3. Design fundamentals

- **Plan first, in tokens.** Before writing the page, put the design in a
  `:root` block at the top of the style: 4–6 named colors, 2–3 font roles, a
  spacing unit, and a one-line comment above it naming the layout concept.
  Check the plan against the subject: any part that would fit any similar page
  is a generic default, so change it in the plan before building. Derive
  everything from the tokens.
- **Both themes.** Define light values on `:root` and dark values under
  `@media (prefers-color-scheme: dark)`, with `color-scheme` set; give `body`
  an explicit background. Design the dark theme with the same care rather
  than inverting the light one: keep contrast readable and the accent working
  on both backgrounds. A design that deliberately has one look (a dark event
  poster) may skip dark mode but still sets every color explicitly.
- **Neutrals with intent**: greys slightly tinted toward the accent, not pure
  mid-grey. One accent, used for what the reader must notice.
- **Type**: pair a display face with a body face (Google Fonts or a system
  stack with real fallbacks); keep a type scale; `text-wrap: balance` on
  headings; letter-spacing on uppercase labels; `tabular-nums` where digits
  line up.
- **Consistency**: repeated cards, rows and badges share edges, padding and
  baselines; content sets heights; no card left alone in a row or stretched
  over empty space. Use borders, fills and shadows only to set off what needs
  it, not on every block. Lead with big-number tiles only when those figures
  are the point of the piece.
- **Charts** drawn to one scale, with every tick label naming a value the
  chart reaches, colors from the tokens, and marks and labels inside the
  bounds. Structure (numbering, dividers, labels) only when it says something
  true, such as a real sequence.
- **Complete at rest**: everything meant to be read is visible once the page
  loads, with no scrolling or animation needed to reveal it; previews and
  thumbnails show only that first frame. Animate from a visible resting state,
  never from `opacity: 0`, and size a hero to its content instead of `100vh`.
- **Motion with purpose**: one orchestrated moment (a load sequence, a hover
  detail) works better than scattered effects; often none is best.
- **Copy**: plain, specific, active; name things as the reader knows them.
  Write in short, direct sentences, free of mannered devices such as asides
  set off by dashes, "not X but Y" framing, colon-then-reveal lines, scare
  quotes and stock phrases.
- **Avoid the stock AI look**: cream background with serif and terracotta,
  black with one neon accent, broadsheet hairlines with dense columns,
  purple-to-blue gradient heroes, Inter or Space Grotesk as the safe choice,
  emoji as section markers, everything centered, the same rounded card
  everywhere, accent bars on rounded cards. Follow the user's direction
  exactly when they give one.
- **Build cleanly**: valid markup, visible keyboard focus, respect
  `prefers-reduced-motion`, no element overlapping another, and selectors
  that do not cancel each other's spacing.
- **Credit sources**: every number and every image not made by the user has
  a short source line.

## 4. Check once, then deliver

Render the page headless at a narrow and a wide width, in light and dark, and
look at each screenshot once. Use a screenshot tool your environment already
has, or Playwright for Python: the `playwright` package is small, so add it to
your Python environment when it is missing. Its browser is a separate, large
download kept in a shared cache; use it when it is already there (check with
`playwright install --dry-run chromium` or by launching it), and otherwise
follow "When no browser is available" below. Launch the browser only through
Playwright, which keeps it away from the system keychain; never run a browser
executable directly.

```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()  # headless
    for w, scheme in [(390, "light"), (1280, "light"), (1280, "dark")]:
        pg = b.new_page(viewport={"width": w, "height": 900}, color_scheme=scheme)
        pg.goto("file://<absolute path to page>.html")
        print(w, scheme, "overflow:", pg.evaluate("document.documentElement.scrollWidth > innerWidth"))
        pg.screenshot(path=f"<dir>/check-{w}-{scheme}.png", full_page=True)
    b.close()
```

Check: no sideways overflow, nothing clipped or overlapping, text readable in
both themes, the layout stacks sensibly at 390 px, charts and images intact.
Make one round of fixes, then deliver.

**When no browser is available**, keep going without downloading one yourself
(it is a large download stored outside the workspace and can trigger system
prompts). Check the source instead: no fixed widths wider than a phone,
no `min-width` beyond the screen, wide content in its own scroll container,
every color from the tokens in both themes, and the scaling script present on
a fixed canvas. Deliver the piece, say that it was checked in the source but
not rendered, and suggest a one-time setup so later pieces can be checked
visually, with the reason:

> To let me preview pages at phone and desktop width before handing them
> over, install Playwright once: `pip install playwright` then
> `playwright install chromium` (about 150 MB). It renders the page off
> screen, catches layouts that break on narrow screens, and needs no further
> setup.
