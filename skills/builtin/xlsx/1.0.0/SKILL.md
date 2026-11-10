---
name: xlsx
description: Read, analyze, create, or edit Excel XLSX spreadsheets with Python. Use when a spreadsheet is the main input or requested output, including formulas, formatting, charts, and CSV conversion.
---

# Spreadsheets with Python

## Runtime

Use the current Context's isolated Python project in `./agent`:

```bash
uv --directory ./agent add openpyxl
uv --directory ./agent add pandas
```

`openpyxl` handles workbook structure and presentation. Add `pandas` only when it helps with large table analysis or transformation; the standard library `csv` module is enough for simple CSV work. Run scripts with `uv --directory ./agent run python ...` and absolute script/input/output paths, since `--directory` changes the command's working directory. Save working files under `./playground/<scope>/` and publish the deliverable through the available tool.

## Choose the operation

- **Read or analyze:** Load the workbook with `openpyxl`. Inspect sheets, headers, data types, formulas, merged ranges, hidden rows or columns, and tables before interpreting values. For CSV, detect delimiter and encoding rather than assuming them.
- **Edit a workbook:** Copy the source, then change only requested cells or structures. Preserve formulas, number formats, validations, named ranges, charts, and template styling where possible. When macros must survive, use `load_workbook(..., keep_vba=True)` and retain the `.xlsm` extension; check the result in a compatible application.
- **Create:** Use clear column labels, appropriate number and date formats, frozen headers where useful, and native Excel formulas or charts when users need editable calculations. Do not invent input data or financial sources.
- **Analyze:** Use `pandas` for tabular transformations if needed, then write results with `openpyxl` when workbook layout or formulas matter. Treat identifiers as strings when leading zeros are significant.

## Example: edit while preserving workbook structure

```python
from openpyxl import load_workbook

source = "/absolute/path/input.xlsx"
target = "/absolute/path/output.xlsx"
workbook = load_workbook(source)
sheet = workbook["Summary"]
sheet["B2"] = 42
workbook.save(target)
```

`openpyxl` stores formulas but does not calculate them. Do not present `data_only=True` values as freshly recalculated after an edit. If computed results are required, use an available spreadsheet calculation engine and inspect its output; the Runtime does not include LibreOffice by default. Otherwise provide formulas and state that recalculation occurs when the workbook opens in a compatible spreadsheet application.

## Check the result

Reopen the saved workbook. Verify sheet names, dimensions, key values and formulas, number formats, links, charts, and any macro preservation relevant to the request. Check for broken references and formula error cells. For a styled or layout-sensitive file, inspect it in a spreadsheet renderer when one is available; report if a visual check could not be done.
