import {
  DocumentNormalizationError,
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_DOCUMENT_SOURCE_BYTES,
  type DocumentNormalizationInput,
} from "./document-normalizer.js";
import {
  archiveEntryHeading,
  inflateGzip,
  listSafeZipFiles,
  stripGzipExtension,
} from "./document-archive-extract.js";
import {
  decodeXmlEntities,
  extractDocText,
  extractOfficeMarkdown,
  extractSpreadsheetMarkdown,
  hasOleSignature,
  hasZipSignature,
} from "./document-office-extract.js";
import {
  codeFenceLanguage,
  isInProcessDocumentSource,
  resolveDocumentSourceKind,
} from "./document-source-kind.js";

export { isInProcessDocumentSource, resolveDocumentSourceKind };

const MAX_ARCHIVE_NESTING = 1;

function nextArchiveDepth(current: number | undefined): number {
  const depth = current ?? 0;
  if (depth >= MAX_ARCHIVE_NESTING) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED");
  }
  return depth + 1;
}

export async function normalizeDocumentContent(
  input: DocumentNormalizationInput,
  maxOutputBytes = MAX_DOCUMENT_MARKDOWN_BYTES,
): Promise<Uint8Array> {
  if (input.source.byteLength > MAX_DOCUMENT_SOURCE_BYTES) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
  }
  const kind = resolveDocumentSourceKind(input);
  let markdown: string;
  switch (kind) {
    case "pdf":
      markdown = await (
        await import("./document-pdf-extract.js")
      ).extractPdfMarkdown(input.source);
      break;
    case "doc":
      markdown = hasZipSignature(input.source)
        ? await extractOfficeMarkdown(input.source, "docx")
        : await extractDocText(input.source);
      break;
    case "docx":
      markdown = hasOleSignature(input.source)
        ? await extractDocText(input.source)
        : await extractOfficeMarkdown(input.source, "docx");
      break;
    case "xlsx":
      markdown = await extractSpreadsheetMarkdown(input.source);
      break;
    case "pptx":
    case "odt":
    case "ods":
    case "odp":
    case "epub":
      markdown = await extractOfficeMarkdown(input.source, kind);
      break;
    case "mail":
      markdown = await (
        await import("./document-mail-extract.js")
      ).extractMailMarkdown(input.source);
      break;
    case "zip":
      markdown = await extractZipMarkdown(input);
      break;
    case "gzip":
      markdown = await extractGzipMarkdown(input);
      break;
    case "svg":
      markdown = (await import("./document-image-extract.js")).svgToMarkdown(
        decodeUtf8Text(input.source),
        input.filename,
      );
      break;
    case "image":
      markdown = await (
        await import("./document-image-extract.js")
      ).rasterImageToMarkdown(input.source, input.filename);
      break;
    case "html":
      markdown = htmlToMarkdown(decodeUtf8Text(input.source));
      break;
    case "csv":
      markdown = delimitedToMarkdown(decodeUtf8Text(input.source), ",");
      break;
    case "tsv":
      markdown = delimitedToMarkdown(decodeUtf8Text(input.source), "\t");
      break;
    case "json":
      markdown = jsonToMarkdown(decodeUtf8Text(input.source));
      break;
    case "xml":
      markdown = fencedBlock("xml", decodeUtf8Text(input.source));
      break;
    case "yaml":
      markdown = fencedBlock("yaml", decodeUtf8Text(input.source));
      break;
    case "code":
      markdown = fencedBlock(
        codeFenceLanguage(input.filename),
        decodeUtf8Text(input.source),
      );
      break;
    case "markdown":
    case "plain":
      markdown = decodeUtf8Text(input.source);
      break;
    default:
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED");
  }
  return canonicalizeMarkdown(markdown, maxOutputBytes);
}

export function canonicalizeMarkdown(
  markdown: string,
  maxOutputBytes = MAX_DOCUMENT_MARKDOWN_BYTES,
): Uint8Array {
  const normalized = markdown
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .normalize("NFC")
    .replace(/\n+$/u, "");
  if (!normalized.trim()) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_EMPTY");
  }
  const encoded = new TextEncoder().encode(`${normalized}\n`);
  if (encoded.byteLength > maxOutputBytes) {
    throw new DocumentNormalizationError("DOCUMENT_MARKDOWN_TOO_LARGE");
  }
  return encoded;
}

async function extractZipMarkdown(
  input: DocumentNormalizationInput,
): Promise<string> {
  const nestedDepth = nextArchiveDepth(input.archiveDepth);
  const entries = await listSafeZipFiles(input.source);
  const sections: string[] = [];
  for (const entry of entries) {
    try {
      const markdown = await normalizeDocumentContent({
        archiveDepth: nestedDepth,
        filename: entry.filename,
        mediaType: "application/octet-stream",
        source: entry.bytes,
      });
      const body = new TextDecoder().decode(markdown).trim();
      if (!body) continue;
      sections.push(`## ${archiveEntryHeading(entry.filename)}\n\n${body}`);
    } catch (error) {
      if (!(error instanceof DocumentNormalizationError)) throw error;
      if (
        error.code === "DOCUMENT_SOURCE_TOO_LARGE" ||
        error.code === "DOCUMENT_MARKDOWN_TOO_LARGE"
      ) {
        throw error;
      }
    }
  }
  return sections.join("\n\n");
}

async function extractGzipMarkdown(
  input: DocumentNormalizationInput,
): Promise<string> {
  const nestedDepth = nextArchiveDepth(input.archiveDepth);
  const inflated = inflateGzip(input.source);
  return new TextDecoder().decode(
    await normalizeDocumentContent({
      archiveDepth: nestedDepth,
      filename: stripGzipExtension(input.filename),
      mediaType: "application/octet-stream",
      source: inflated,
    }),
  );
}

function decodeUtf8Text(source: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  if (decoded.includes("\u0000")) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  return decoded;
}

function htmlToMarkdown(html: string): string {
  let value = html
    .replace(/<script\b[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[\s\S]*?<\/style>/giu, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<br\s*\/?>/giu, "\n");
  value = value.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu,
    (_match, level: string, inner: string) =>
      `\n${"#".repeat(Number(level))} ${stripHtml(inner)}\n`,
  );
  value = value.replace(
    /<li\b[^>]*>([\s\S]*?)<\/li>/giu,
    (_match, inner: string) => `\n- ${stripHtml(inner)}`,
  );
  value = value.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/giu,
    (_match, inner: string) => `\n\n${stripHtml(inner)}\n`,
  );
  return decodeXmlEntities(stripHtml(value))
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/gu, " ")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function delimitedToMarkdown(text: string, delimiter: string): string {
  const rows = parseDelimitedRows(text, delimiter);
  if (rows.length === 0) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_EMPTY");
  }
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) =>
    Array.from({ length: width }, (_, index) =>
      (row[index] ?? "").replaceAll("\n", " ").replaceAll("|", "\\|"),
    ),
  );
  const header = padded[0] ?? [];
  const body = padded.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (character === "\r") continue;
    field += character;
  }
  if (inQuotes) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function jsonToMarkdown(text: string): string {
  try {
    return fencedBlock("json", JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}

function fencedBlock(language: string, body: string): string {
  const normalized = body.replace(/^\uFEFF/u, "").replace(/\n+$/u, "");
  return `\`\`\`${language}\n${normalized}\n\`\`\``;
}
