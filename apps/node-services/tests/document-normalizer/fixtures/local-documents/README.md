# Local parsing regression fixtures

These are synthetic documents generated in this repository; they hold no user data. `manifest.json` lists the body
facts that must survive; the tests separately check Office table column mapping, Excel dates and percentages, slide
notes and blank input.

- PDF: ReportLab text layers in Chinese and English, tables, two columns, a scanned page, text and a scanned area on
  one page, and a blank page.
- Images: Chinese and English acceptance forms drawn with Pillow; the tests transcode these PNGs to JPEG, WebP, GIF,
  AVIF, BMP and multi-page TIFF. `ocr-sparse.png` is an interface-like screenshot drawn with `@napi-rs/canvas` (color
  blocks and one line of labels); the default layout finds nothing, and only the sparse-text layout reads the labels.
- Office: tables, formatted cells and notes generated with python-docx, python-pptx and openpyxl.
- ODF, EPUB, EML, MHTML: minimal standard XML, ZIP and MIME documents; DOTX changes the main content type of a
  synthetic DOCX.

OCR uses the Chinese and English Tesseract models pinned in the dependencies; nothing is downloaded and no system OCR
or LibreOffice is needed. The fixtures prove that file paths and body extraction work; they make no promise about
two-column reading order, complex PDF tables, handwriting or low-quality scans.
