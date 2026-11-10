# Office Preview Fixtures

Real Office files for the real-stack Room Document E2E specs.

- `sample.docx`, `sample.pptx` and `sample.xlsx` are small, sanitized OOXML
  files that contain the marker `Linger Office Preview`. They were
  generated with document tooling; never rename another file to an Office
  extension.
- `single-100kb.docx` (98,982 bytes) is the single-file cold-open sample. It
  contains the paragraph `Issue 199 single DOCX cold preview` and one
  deterministic 180x180 RGB PNG, with no external resources. SHA-256:
  `1f268b518978f50e1454cc82a8fc635d38770b95f8c11f64ad616a9bbec3dd50`.
- Product code must not reference these files.
