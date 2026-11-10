import { simpleParser } from "mailparser";

import { DocumentNormalizationError } from "./document-normalizer.js";
import { extractOfficeMarkdown } from "./document-office-extract.js";

export async function extractMailMarkdown(source: Uint8Array): Promise<string> {
  try {
    const mail = await simpleParser(Buffer.from(source), {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: 32 * 1024 * 1024,
    });
    if (mail.headers.size === 0) throw new Error("Missing MIME headers");
    const body = mail.html
      ? await extractOfficeMarkdown(Buffer.from(mail.html), "html")
      : (mail.text ?? "");
    // Subject/header-only messages are not a substitute for an extractable body.
    if (!body.trim())
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_EMPTY");
    return [
      mail.subject ? `# ${mail.subject.replace(/[\r\n]/g, " ")}` : "",
      mail.from?.text ? `From: ${mail.from.text}` : "",
      body,
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch (error) {
    if (error instanceof DocumentNormalizationError) throw error;
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}
