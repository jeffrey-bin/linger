---
name: pptx
description: Create, inspect, or edit PowerPoint PPTX presentations with Python. Use when slides are an input or deliverable, including templates, charts, notes, and layout changes.
---

# PowerPoint with Python

## Runtime

Install Python packages into the current Context's isolated `./agent` project:

```bash
uv --directory ./agent add python-pptx
uv --directory ./agent add pillow
```

Run scripts with `uv --directory ./agent run python ...`. Convert script and document paths to absolute paths first; `--directory` changes the command's working directory. Keep work under `./playground/<scope>/` and publish the finished PPTX through the available delivery tool. No Node package or JavaScript generator is required for this workflow.

## Work with the deck

- **Inspect:** Open with `Presentation(path)`. Record slide dimensions, layouts, placeholders, groups, text, charts, and image positions. For a supplied deck, preserve its theme and master rather than rebuilding it.
- **Create:** Set the slide size and a consistent visual system. Put one clear message on each slide. Use editable shapes and native charts for data that the user may need to change; add images at their correct aspect ratio.
- **Edit:** Change only requested slides and shapes. Within text frames, edit runs where possible so existing fonts, links, and emphasis survive. When replacing a shape, carry forward its position and relevant styling.
- **Advanced features:** `python-pptx` does not expose every PowerPoint feature. Inspect OOXML parts in the PPTX ZIP for notes, animation, transitions, comments, and other unsupported content. Make targeted XML edits only when needed, retaining relationships and untouched parts.

## Example: inspect text and geometry

```python
from pptx import Presentation

deck = Presentation("/absolute/path/input.pptx")
for slide_number, slide in enumerate(deck.slides, start=1):
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(slide_number, shape.left, shape.top, shape.width, shape.height, shape.text)
```

## Check the result

Reopen the finished file with `python-pptx` and verify slide count, expected text, media, charts, and notes relevant to the task. Check shape bounds against the slide dimensions and look for obvious overlap. If a slide renderer is available, render and inspect every changed slide; the Runtime does not include LibreOffice by default. Geometry checks alone do not prove that fonts and text render correctly, so state when visual inspection was unavailable.
