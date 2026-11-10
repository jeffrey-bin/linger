---
name: docx
description: Create, inspect, or edit Word DOCX files with Python. Use when a Word file is an input or requested deliverable, including templates, tables, comments, and tracked changes.
---

# Word documents with Python

## Runtime

The active Context has its own Python project in `./agent`. Install only the packages needed for the task:

```bash
uv --directory ./agent add python-docx
```

Run Python with `uv --directory ./agent run python ...`. Resolve script, input, and output paths to absolute paths **before** invoking `uv`; `--directory` changes the command's working directory to `./agent`. Keep generated scripts and files under the current Context's `./playground/<scope>/` directory. Publish finished files through the available delivery tool; a filesystem path alone is not a Human-accessible deliverable.

Use the Python standard library (`zipfile`, `xml.etree.ElementTree`) for package inspection. Add `defusedxml` if processing untrusted XML with a nonstandard parser. Do not run an install script or use system `pip`.

## Choose the operation

- **Read or extract:** Open with `python-docx` for paragraphs, tables, sections, and document properties. DOCX is an OOXML ZIP; inspect its XML parts when the high-level view omits headers, footers, comments, text boxes, or revisions. Keep the original order of paragraphs and tables when order matters.
- **Create:** Use `python-docx`. Set page size and margins, named styles, fonts, and table widths deliberately. Put repeated formatting in styles. For CJK text, check that the chosen font covers the characters actually used.
- **Edit an existing file:** Work on a copy. Change the relevant paragraphs, runs, tables, or sections while preserving the template's styles, headers, footers, and unrelated package parts. Avoid replacing an entire paragraph when its runs carry meaningful formatting or links.
- **Comments or tracked changes:** Inspect existing OOXML first. Use a narrowly scoped OOXML edit only when the installed `python-docx` API cannot express the requested change. Preserve relationships and IDs, and do not accept or discard revisions without a request to do so. Set comment and revision author from the user's instructions or a neutral descriptive value; never stamp a vendor identity.

## Example: preserve an existing document while changing one run

```python
from docx import Document

source = "/absolute/path/input.docx"
target = "/absolute/path/output.docx"
doc = Document(source)
for paragraph in doc.paragraphs:
    for run in paragraph.runs:
        if "Old term" in run.text:
            run.text = run.text.replace("Old term", "New term")
doc.save(target)
```

This example handles text wholly inside one run. If a match spans runs, map the text back to runs and preserve their formatting; do not flatten the paragraph as a shortcut.

## Check the result

Reopen the saved DOCX with `python-docx`; compare expected text, tables, sections, and document properties with the request. Check ZIP integrity with `zipfile.ZipFile(...).testzip()`. For layout-sensitive work, render with an available Word-compatible viewer and inspect every page. The Runtime does not include LibreOffice by default; if no renderer is available, report that visual layout was not checked.
