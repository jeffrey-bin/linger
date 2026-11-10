---
name: pptx
description: Create, inspect, or edit PowerPoint PPTX presentations with Python, to a professional visual standard. Use whenever slides are an input or a deliverable. Covers the design rules (images, charts, diagrams, layouts) and slide-by-slide render checks.
---

# PowerPoint with Python

A finished deck must look rich and professional: every slide carries a real
visual, not just a title and bullets. Read this whole file before building.

## Runtime

Install Python packages into the current Context's isolated `./agent` project
(create it with `uv init --bare ./agent` if it does not exist):

```bash
uv --directory ./agent add python-pptx pillow
```

Run scripts with `uv --directory ./agent run python ...`. Convert script and
document paths to absolute paths first; `--directory` changes the working
directory. Keep work under `./playground/<scope>/`.

## Workflow

1. **Read the brief.** Keep the slide order and the meaning of each headline;
   take numbers only from sources you can cite.
2. **Find the Human's existing material first (required for every new deck).**
   Before any web research, use your workspace tools (the documents and files
   available to you, and the Human's knowledge search; see the `teamhub-files`
   skill and your instructions) to check what the Human already has:
   - documents, spreadsheets, slides and PDFs about the same project, team,
     company or period, including any named in the brief;
   - facts recorded in their chats, meetings and documents, searched from
     several angles (results, causes, plans, asks, people);
   - **images, logos, brand files, team or office photos** of the company.
     Knowledge search covers text only, so look for these among the files.
   Count content only if it is about the same project and period; the
   company's own logo, brand images and team or office photos count for any
   deck about that company. Read everything relevant, and write the inventory
   (found / used / not used and why, with IDs) to
   `./playground/<scope>/material.md`.
3. **Research the gaps** on the web, citing every source.
4. **Plan every slide before coding**: its claim headline, its layout, and its
   visual (which image, chart or diagram). Write the plan to
   `./playground/<scope>/plan.md`.
5. **Collect images** (see Images) into `./playground/<scope>/img/`, recording
   each source.
6. **Build** with one python-pptx script. Define the style (colors, fonts,
   margins, title position) once at the top and reuse small functions for
   repeated elements (title, source line, image with credit, card, chart) so
   every slide looks the same.
7. **Render and inspect every slide** (see Check), fix, and render again.
8. **Report**: file path, one line per slide, the Human's material found /
   used / not used and why, other sources used, every assumption, every
   missing fact, and any check you could not run.

## Design rules

### Story on the slide
- Every content slide's title is a **claim** (a sentence stating its point),
  not a label. Reading the titles in order tells the story.
- Keep each title to one line (about 60 Latin characters or 30 CJK
  characters at 28 pt); shorten the wording rather than wrapping.
- One point per slide. At most ~40 words of body text on a presented slide;
  put detail in speaker notes.
- Every fact has a short source line at the bottom of its slide.

### Visual first
- **Every slide has one visual anchor**: a photo, a native chart, a diagram
  (flow, timeline, matrix, structure), KPI tiles or a big number. A slide that
  is only a title and bullets is a defect, except a short agenda.
- **Pick the visual from the content**: numbers that compare or change → chart;
  a sequence or mechanism → flow or timeline; options or trade-offs → cards or
  matrix; one striking figure → big number; people, products, places, mood →
  photo. A deck usually mixes all of these; there is no fixed ratio, but a deck
  without photos, without charts where there are numbers, or without a diagram
  where there is a process is not finished.
- **Vary the layouts**: never three slides in a row with the same layout. Use a
  full-bleed photo cover, section dividers for decks over ~8 slides, half-slide
  image beside text, cards and full-width charts.
- Speaker notes on every slide when the brief asks for them.

### Images
- **Every deck has real photos**: the cover, and image-beside-text, section and
  card slides wherever they fit; beyond the cover, about every third or fourth
  slide carries a photo.
- Find them in this order:
  1. the Human's own images, logos and photos found in step 2 (use the
     company logo on the cover or footer when there is one);
  2. official sources about the topic (company newsroom or press kit, product
     pages, official logos);
  3. free photo libraries with a clear license (Unsplash, Pexels, Pixabay,
     Wikimedia Commons), searching for the topic;
  4. if nothing on-topic fits, **neutral photos** from those libraries
     (architecture, city skyline, office or meeting scenes, landscapes,
     abstract textures) matching the deck's mood and colors.
  Never leave an empty image area, and never use a tiny or blurry image
  stretched up.
- **Always credit the source**: a small caption on the image ("Image: <site> /
  <author or page>") and the full URL in that slide's speaker notes; list all
  credits on the sources slide or in the notes.
- Download the largest reasonable size (≥1600 px wide for full-bleed). Crop to
  fill the frame (python-pptx `crop_left/right/top/bottom` from the aspect
  ratios); never distort. Put text over a photo only on a translucent dark
  overlay (a rectangle whose fill has an `a:alpha` of about 50%).

### Charts
- Native, editable charts only (`CategoryChartData` + `add_chart`), never
  chart screenshots.
- Highlight what the headline claims in the accent color and keep the rest
  neutral grey; label values on the bars and remove gridlines and needless
  legends.
- One message per chart; the title says what the chart proves; source below.

### Diagrams
- Draw them with native shapes and connectors: flows of 3–6 steps, timelines,
  2×2 matrices only for two real dimensions, structure charts, cards, KPI
  tiles. Consistent corners, line weights and colors; highlight the step the
  slide is about.

### Look
- One style per deck: the one in the brief. Turn its name and description
  into exact colors, fonts and layout habits once at the top of the script,
  and use one accent color only for what the audience must notice. With no
  style given, use white, near-black text and one dark-blue accent.

- 16:9 (13.333 × 7.5 in), 0.6 in margins; nothing touches the edge except
  full-bleed photos.
- Type: titles 28–44 pt, body 16–20 pt, captions and sources 9–12 pt; never
  body text under 14 pt, including text in cards and tiles.
- **Size every text box to its content, for every viewer**: estimate the lines
  from characters per line at the chosen size, then make the box at least
  lines × font size × line height tall, plus its top and bottom insets, using
  1.2 for Latin text and 1.5 for Chinese, Japanese or Korean. Viewers such as
  web previews keep the stored box size and scroll or clip what does not fit,
  so never rely on auto-fit (`spAutoFit`, `normAutofit`) to make room. Size
  cards to their text instead of leaving large empty areas. Keep footers to
  one short line.
- Chinese text: set an East Asian font on every run (`a:ea` typeface, e.g.
  PingFang SC or Microsoft YaHei).

## Edit an existing deck

Open with `Presentation(path)`, change only the requested slides and shapes,
edit runs so fonts and emphasis survive, and keep the deck's own theme and
master. Inspect OOXML in the ZIP for features python-pptx does not expose.

## Check (every slide)

Render to images:

```bash
soffice --headless --convert-to pdf --outdir <dir> <deck.pptx>   # LibreOffice
pdftoppm -png -r 80 <dir>/<deck>.pdf <dir>/slide
```

If `soffice` is missing, try `micromamba install --yes --override-channels
--channel conda-forge --prefix ./agent/conda libreoffice` and run it with
`micromamba run --prefix ./agent/conda soffice ...`. If no renderer works, say
so in the report.

Check in two levels, so slide images do not fill your context:

1. **Overview**: tile the slide images into contact sheets (e.g. with Pillow,
   4 per row, about 400 px wide each, up to 12 slides per sheet), open the
   sheets, and list the slides that look wrong or uncertain against the
   checklist below.
2. **Detail**: open the single-slide image only for those slides, fix them,
   re-render, and re-check only the slides you changed.

The checklist:

1. The title is a claim on one line; titles in order tell the story; order matches the brief.
2. The slide has a visual anchor; no three consecutive slides share a layout.
3. No text overflows its box, is cut off, overlaps, or touches the edge; footers stay on one line.
   LibreOffice grows auto-fit boxes, so a render can hide an overflow: also
   check in the script that every text box is at least as tall as the formula
   above.
4. No card, tile or text box is mostly empty; content fills its frame.
5. Images are sharp, not distorted, credited on the slide and in the notes.
6. Charts are native, labeled, and highlight what the title claims.
7. Body text ≥ 14 pt everywhere and within the word budget.
8. One style throughout: fonts, colors, title position, footer.
9. Every number has a source; nothing invented; gaps are marked visibly.
   Relevant material the Human already has is used, or the report says why
   not (off-topic, superseded).
10. Chinese text renders in a CJK font.
11. Speaker notes present when asked; the last slide states the ask or next step.

Fix every failure and render again before reporting.
