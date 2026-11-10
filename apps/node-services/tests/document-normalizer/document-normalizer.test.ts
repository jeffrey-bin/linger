import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeMarkdown,
  isInProcessDocumentSource,
  normalizeDocumentContent,
} from "../../src/document-normalizer/document-normalizer-core.js";
import {
  DOC_MEDIA_TYPE,
  DocumentNormalizationError,
  DOCX_MEDIA_TYPE,
  GZIP_MEDIA_TYPE,
  MAX_DOCUMENT_SOURCE_BYTES,
  PDF_MEDIA_TYPE,
  PNG_MEDIA_TYPE,
  SVG_MEDIA_TYPE,
  WorkerDocumentNormalizer,
  XLSX_MEDIA_TYPE,
  ZIP_MEDIA_TYPE,
} from "../../src/document-normalizer/document-normalizer.js";
import {
  docxFixture,
  gzipFixture,
  pdfFixture,
  pngFixture,
  pngWithTextFixture,
  svgFixture,
  xlsxFixture,
  zipFixture,
} from "./fixtures/document-normalizer-fixtures.js";

const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const sampleDocPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/sample.doc",
);

describe("document normalization", () => {
  it("extracts a PDF text layer as canonical Markdown", async () => {
    const markdown = decode(
      await normalizeDocumentContent({
        mediaType: PDF_MEDIA_TYPE,
        source: pdfFixture(),
      }),
    );

    expect(markdown).toBe("PDF text layer\n");
  });

  it("preserves DOCX formatting and applies NFC", async () => {
    const markdown = decode(
      await normalizeDocumentContent({
        mediaType: DOCX_MEDIA_TYPE,
        source: docxFixture(),
      }),
    );

    expect(markdown).toBe("**Caf\u00e9**\n\nSecond line\n");
    expect(markdown).toBe(markdown.normalize("NFC"));
  });

  it("extracts body text from a legacy Word DOC", async () => {
    const markdown = decode(
      await normalizeDocumentContent({
        filename: "sample.doc",
        mediaType: DOC_MEDIA_TYPE,
        source: await readFile(sampleDocPath),
      }),
    );

    expect(markdown).toContain("SimplexAI Office Preview");
    expect(markdown).toContain("Aperçu multilingue");
  });

  it("resolves a DOC from filename when the stored media type is generic", async () => {
    const markdown = decode(
      await normalizeDocumentContent({
        filename: "notes.doc",
        mediaType: "application/octet-stream",
        representationFormat: "doc",
        source: await readFile(sampleDocPath),
      }),
    );

    expect(markdown).toContain("SimplexAI Office Preview");
  });

  it("converts HTML, CSV, JSON, and XLSX into Markdown", async () => {
    await expect(
      normalizeDocumentContent({
        mediaType: "text/html; charset=utf-8",
        source: encode("<h1>Title</h1><p>Hello <b>world</b></p>"),
      }).then(decode),
    ).resolves.toBe("# Title\n\nHello world\n");

    await expect(
      normalizeDocumentContent({
        filename: "people.csv",
        mediaType: "text/csv",
        source: encode("name,count\nAda,42\n"),
      }).then(decode),
    ).resolves.toBe("| name | count |\n| --- | --- |\n| Ada | 42 |\n");

    await expect(
      normalizeDocumentContent({
        mediaType: "application/json",
        source: encode('{"name":"Ada"}'),
      }).then(decode),
    ).resolves.toBe('```json\n{\n  "name": "Ada"\n}\n```\n');

    await expect(
      normalizeDocumentContent({
        mediaType: XLSX_MEDIA_TYPE,
        source: xlsxFixture(),
      }).then(decode),
    ).resolves.toBe(
      "## People\n\n| Name | Count |\n| --- | --- |\n| Ada | 42 |\n",
    );
  });

  it("extracts archive and SVG text without indexing image metadata as body", async () => {
    await expect(
      normalizeDocumentContent({
        filename: "bundle.zip",
        mediaType: ZIP_MEDIA_TYPE,
        source: zipFixture([
          { name: "notes.md", value: "# From zip\n" },
          { name: ".DS_Store", value: "junk" },
          {
            name: "photo.png",
            value: pngWithTextFixture("Comment", "Album cover"),
          },
        ]),
      }).then(decode),
    ).resolves.toBe(
      "## notes.md\n\n# From zip\n\n## photo.png\n\n# photo.png\n\n- Format: PNG\n",
    );

    await expect(
      normalizeDocumentContent({
        filename: "notes.md.gz",
        mediaType: GZIP_MEDIA_TYPE,
        source: gzipFixture(encode("# From gzip\n")),
      }).then(decode),
    ).resolves.toBe("# From gzip\n");

    await expect(
      normalizeDocumentContent({
        filename: "icon.svg",
        mediaType: SVG_MEDIA_TYPE,
        source: svgFixture(),
      }).then(decode),
    ).resolves.toBe("# icon.svg\n\nIcon\n\nHello wiki\n");

    await expect(
      normalizeDocumentContent({
        filename: "photo.png",
        mediaType: PNG_MEDIA_TYPE,
        source: pngFixture(),
      }).then(decode),
    ).resolves.toBe("# photo.png\n\n- Format: PNG\n");

    await expect(
      normalizeDocumentContent({
        filename: "photo.png",
        mediaType: PNG_MEDIA_TYPE,
        source: pngFixture().subarray(0, 24),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_INVALID" });

    await expect(
      normalizeDocumentContent({
        filename: "photo.heic",
        mediaType: "image/heic",
        source: encode("not a real heic"),
      }).then(decode),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_INVALID" });
  });

  it("rejects nested gzip instead of recursing through wrappers", async () => {
    let source = encode("# From nested gzip\n");
    let filename = "notes.md";
    for (let layer = 0; layer < 8; layer += 1) {
      source = gzipFixture(source);
      filename += ".gz";
    }
    await expect(
      normalizeDocumentContent({
        filename,
        mediaType: GZIP_MEDIA_TYPE,
        source,
      }),
    ).rejects.toMatchObject({
      code: "DOCUMENT_SOURCE_UNSUPPORTED",
      disposition: "terminal",
    });
  });

  it("does not keep unwrapping gzip members inside a ZIP", async () => {
    await expect(
      normalizeDocumentContent({
        filename: "bundle.zip",
        mediaType: ZIP_MEDIA_TYPE,
        source: zipFixture([
          { name: "notes.md", value: "# From zip\n" },
          {
            name: "nested.md.gz.gz",
            value: gzipFixture(gzipFixture(encode("# From nested gzip\n"))),
          },
        ]),
      }).then(decode),
    ).resolves.toBe("## notes.md\n\n# From zip\n");
  });

  it("rejects a gzip-wrapped ZIP as a second archive layer", async () => {
    await expect(
      normalizeDocumentContent({
        filename: "bundle.zip.gz",
        mediaType: GZIP_MEDIA_TYPE,
        source: gzipFixture(
          zipFixture([{ name: "notes.md", value: "# From zip\n" }]),
        ),
      }),
    ).rejects.toMatchObject({
      code: "DOCUMENT_SOURCE_UNSUPPORTED",
      disposition: "terminal",
    });
  });

  it("treats an Office Open XML file labeled as ZIP as that Office kind", async () => {
    await expect(
      normalizeDocumentContent({
        filename: "budget.xlsx",
        mediaType: ZIP_MEDIA_TYPE,
        representationFormat: "binary",
        source: xlsxFixture(),
      }).then(decode),
    ).resolves.toBe(
      "## People\n\n| Name | Count |\n| --- | --- |\n| Ada | 42 |\n",
    );
  });

  it("keeps SVG in-process and sends ZIP and raster images to the worker path", () => {
    expect(
      isInProcessDocumentSource({
        filename: "icon.svg",
        mediaType: SVG_MEDIA_TYPE,
      }),
    ).toBe(true);
    expect(
      isInProcessDocumentSource({
        filename: "bundle.zip",
        mediaType: ZIP_MEDIA_TYPE,
      }),
    ).toBe(false);
    expect(
      isInProcessDocumentSource({
        filename: "photo.png",
        mediaType: PNG_MEDIA_TYPE,
      }),
    ).toBe(false);
  });

  it("keeps UTF-8 Markdown and treats a generic .md Version as text", async () => {
    await expect(
      normalizeDocumentContent({
        mediaType: "text/markdown; charset=utf-8",
        source: encode("# Notes\r\n"),
      }).then(decode),
    ).resolves.toBe("# Notes\n");
    await expect(
      normalizeDocumentContent({
        filename: "notes.md",
        mediaType: "application/octet-stream",
        source: encode("# Notes\n"),
      }).then(decode),
    ).resolves.toBe("# Notes\n");
  });

  it("normalizes LF and one trailing newline and enforces output size", () => {
    expect(decode(canonicalizeMarkdown("Cafe\u0301\r\nline\r\n\r\n"))).toBe(
      "Caf\u00e9\nline\n",
    );
    expect(() => canonicalizeMarkdown("1234", 4)).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_MARKDOWN_TOO_LARGE" }),
    );
  });

  it.each([
    {
      code: "DOCUMENT_SOURCE_UNSUPPORTED",
      mediaType: "audio/mpeg",
      source: encode("not audio"),
    },
    {
      code: "DOCUMENT_SOURCE_UNSUPPORTED",
      mediaType: "application/vnd.ms-excel",
      source: encode("not a spreadsheet"),
    },
    {
      code: "DOCUMENT_SOURCE_INVALID",
      mediaType: PDF_MEDIA_TYPE,
      source: encode("not a PDF"),
    },
    {
      code: "DOCUMENT_SOURCE_INVALID",
      mediaType: DOCX_MEDIA_TYPE,
      source: encode("not a DOCX"),
    },
    {
      code: "DOCUMENT_SOURCE_INVALID",
      mediaType: DOC_MEDIA_TYPE,
      source: encode("not a DOC"),
    },
    {
      code: "DOCUMENT_SOURCE_EMPTY",
      mediaType: PDF_MEDIA_TYPE,
      source: pdfFixture(""),
    },
  ])("returns terminal $code for unusable input", async (fixture) => {
    await expect(normalizeDocumentContent(fixture)).rejects.toMatchObject({
      code: fixture.code,
      disposition: "terminal",
    });
  });

  it("converts one document at a time and gives each conversion its own deadline", async () => {
    let running = 0;
    let peak = 0;
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 60));
        running -= 1;
        return new TextEncoder().encode("ok\n");
      },
      timeoutMs: 100,
    });

    // The second request finishes after 120 ms, past one timeout.
    await expect(
      Promise.all([1, 2].map(() => normalizer.normalizeDocument(pdf()))),
    ).resolves.toHaveLength(2);
    expect(peak).toBe(1);
  });

  it("converts text in process without waiting for the worker", async () => {
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => await new Promise<Uint8Array>(() => undefined),
    });
    void normalizer.normalizeDocument(pdf()).catch(() => undefined);

    await expect(
      normalizer
        .normalizeDocument({
          filename: "notes.md",
          mediaType: "text/markdown",
          source: encode("# Notes"),
        })
        .then(decode),
    ).resolves.toBe("# Notes\n");
  });

  it("classifies a conversion that runs past its deadline as terminal", async () => {
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => await new Promise<Uint8Array>(() => undefined),
      timeoutMs: 5,
    });

    await expect(normalizer.normalizeDocument(pdf())).rejects.toMatchObject({
      code: "DOCUMENT_NORMALIZATION_TIMEOUT",
      disposition: "terminal",
      status: 422,
    });
  });

  it("rejects a request when the queue is full", async () => {
    let finish!: () => void;
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return encode("ok\n");
      },
      maxQueued: 1,
    });
    const converting = normalizer.normalizeDocument(pdf());
    const waiting = normalizer.normalizeDocument(pdf());

    await expect(normalizer.normalizeDocument(pdf())).rejects.toMatchObject({
      code: "DOCUMENT_NORMALIZATION_UNAVAILABLE",
      disposition: "retryable",
    });
    finish();
    await converting;
    finish();
    await expect(waiting.then(decode)).resolves.toBe("ok\n");
  });

  it("drops a waiting request when its caller goes away", async () => {
    const started: string[] = [];
    let finish!: () => void;
    const normalizer = new WorkerDocumentNormalizer({
      execute: async (input) => {
        started.push(input.filename ?? "");
        if (input.filename === "first.pdf") {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return encode("ok\n");
      },
    });
    const caller = new AbortController();
    const first = normalizer.normalizeDocument(pdf("first.pdf"));
    const dropped = normalizer.normalizeDocument(
      pdf("dropped.pdf"),
      caller.signal,
    );
    const third = normalizer.normalizeDocument(pdf("third.pdf"));

    caller.abort();
    await expect(dropped).rejects.toMatchObject({
      code: "DOCUMENT_NORMALIZATION_UNAVAILABLE",
    });
    finish();
    await Promise.all([first, third]);
    expect(started).toEqual(["first.pdf", "third.pdf"]);
  });

  it("rejects a source past the byte budget until admitted sources settle", async () => {
    let finish!: () => void;
    const normalizer = new WorkerDocumentNormalizer({
      execute: async (input) => {
        if (input.filename === "held.pdf") {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return encode("ok\n");
      },
      maxAdmittedBytes: MAX_DOCUMENT_SOURCE_BYTES,
    });
    const held = normalizer.normalizeDocument(sized(1, "held.pdf"));

    await expect(
      normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES)),
    ).rejects.toMatchObject({
      code: "DOCUMENT_NORMALIZATION_UNAVAILABLE",
      disposition: "retryable",
    });
    await waitFor(() => finish !== undefined);
    finish();
    await held;
    // Alone, a maximum source fits even though the budget has no headroom.
    await expect(
      normalizer
        .normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES))
        .then(decode),
    ).resolves.toBe("ok\n");
  });

  it("counts in-process text sources against the byte budget", async () => {
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => encode("ok\n"),
      maxAdmittedBytes: MAX_DOCUMENT_SOURCE_BYTES,
    });
    // Admission is synchronous, so the text source is admitted before the
    // worker source is called.
    const text = normalizer.normalizeDocument({
      filename: "notes.md",
      mediaType: "text/markdown",
      source: encode("# Notes"),
    });

    await expect(
      normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES)),
    ).rejects.toMatchObject({ code: "DOCUMENT_NORMALIZATION_UNAVAILABLE" });
    await expect(text.then(decode)).resolves.toBe("# Notes\n");
    await expect(
      normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES)),
    ).resolves.toBeDefined();
  });

  it("releases the byte budget after a conversion failure", async () => {
    const normalizer = new WorkerDocumentNormalizer({
      execute: async (input) => {
        if (input.filename === "broken.pdf") {
          throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
        }
        return encode("ok\n");
      },
      maxAdmittedBytes: MAX_DOCUMENT_SOURCE_BYTES,
    });

    await expect(
      normalizer.normalizeDocument(sized(1, "broken.pdf")),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_INVALID" });
    const first = normalizer.normalizeDocument(sized(1));
    await expect(
      normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES - 1)),
    ).resolves.toBeDefined();
    await first;
  });

  it("releases the byte budget of a waiting request whose caller goes away", async () => {
    let finish!: () => void;
    const normalizer = new WorkerDocumentNormalizer({
      execute: async (input) => {
        if (input.filename === "held.pdf") {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return encode("ok\n");
      },
      maxAdmittedBytes: 2 * MAX_DOCUMENT_SOURCE_BYTES,
    });
    const caller = new AbortController();
    const held = normalizer.normalizeDocument(sized(1, "held.pdf"));
    const dropped = normalizer.normalizeDocument(
      sized(MAX_DOCUMENT_SOURCE_BYTES),
      caller.signal,
    );

    caller.abort();
    await expect(dropped).rejects.toMatchObject({
      code: "DOCUMENT_NORMALIZATION_UNAVAILABLE",
    });
    // A leaked reservation would put this request past the budget.
    const next = normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES));
    await waitFor(() => finish !== undefined);
    finish();
    await Promise.all([held, next]);
  });

  it("releases the byte budget of a request whose wait times out", async () => {
    const normalizer = new WorkerDocumentNormalizer({
      execute: async (input) => {
        if (input.filename === "next.pdf") return encode("ok\n");
        return await new Promise<Uint8Array>(() => undefined);
      },
      maxAdmittedBytes: 2 * MAX_DOCUMENT_SOURCE_BYTES,
      timeoutMs: 100,
    });
    // The first two conversions each run out their 100 ms deadline, so the
    // worker is busy from 0 to 200 ms; the second request, queued at 10 ms,
    // gets the worker at 100 ms, and the one queued at 60 ms gives up waiting
    // at 160 ms.
    vi.useFakeTimers();
    try {
      const ignore = (): undefined => undefined;
      const first = normalizer.normalizeDocument(sized(1)).catch(ignore);
      await vi.advanceTimersByTimeAsync(10);
      const second = normalizer.normalizeDocument(sized(1)).catch(ignore);
      await vi.advanceTimersByTimeAsync(50);
      const waiting = expect(
        normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES)),
      ).rejects.toMatchObject({ code: "DOCUMENT_NORMALIZATION_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(100);
      await waiting;
      // A leaked reservation would put this request past the budget.
      const next = normalizer.normalizeDocument(
        sized(MAX_DOCUMENT_SOURCE_BYTES, "next.pdf"),
      );
      await vi.advanceTimersByTimeAsync(50);
      await Promise.all([first, second]);
      await expect(next.then(decode)).resolves.toBe("ok\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the byte budget of a request rejected by a full queue", async () => {
    const finishes: (() => void)[] = [];
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => {
        await new Promise<void>((resolve) => {
          finishes.push(resolve);
        });
        return encode("ok\n");
      },
      maxAdmittedBytes: 2 * MAX_DOCUMENT_SOURCE_BYTES + 1,
      maxQueued: 1,
    });
    const converting = normalizer.normalizeDocument(sized(1));
    const waiting = normalizer.normalizeDocument(
      sized(MAX_DOCUMENT_SOURCE_BYTES),
    );

    await expect(
      normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES)),
    ).rejects.toMatchObject({ code: "DOCUMENT_NORMALIZATION_UNAVAILABLE" });
    await waitFor(() => finishes.length === 1);
    finishes[0]!();
    await converting;
    // The waiting source now converts; a leaked reservation would put this
    // request past the budget.
    const next = normalizer.normalizeDocument(sized(MAX_DOCUMENT_SOURCE_BYTES));
    await waitFor(() => finishes.length === 2);
    finishes[1]!();
    await waiting;
    await waitFor(() => finishes.length === 3);
    finishes[2]!();
    await expect(next.then(decode)).resolves.toBe("ok\n");
  });

  it("requires a byte budget that admits one maximum source", () => {
    expect(
      () =>
        new WorkerDocumentNormalizer({
          maxAdmittedBytes: MAX_DOCUMENT_SOURCE_BYTES - 1,
        }),
    ).toThrow("byte budget");
  });
});

function pdf(filename = "notes.pdf") {
  return { filename, mediaType: PDF_MEDIA_TYPE, source: pdfFixture() };
}

const maxSizedSource = new Uint8Array(MAX_DOCUMENT_SOURCE_BYTES);

function sized(byteLength: number, filename = "sized.pdf") {
  return {
    filename,
    mediaType: PDF_MEDIA_TYPE,
    source: maxSizedSource.subarray(0, byteLength),
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
