import { artifactFileKind } from "@/features/rooms/files/artifact-file-kind";
import {
  documentFileName,
  documentRepresentationFormat,
} from "./document-display-name";
import type { TeamHubDocumentTreeSummary } from "@/features/teamhub/teamhub-types";

export const documentFileTypes = [
  { value: "", label: "All types" },
  { value: "md", label: "Markdown" },
  { value: "pdf", label: "PDF" },
  { value: "word", label: "Word" },
  { value: "spreadsheet", label: "Spreadsheets (Excel / CSV)" },
  { value: "presentation", label: "PowerPoint" },
  { value: "html", label: "HTML" },
  { value: "text", label: "Plain text" },
  { value: "image", label: "Images" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
  { value: "archive", label: "Archives" },
  { value: "code", label: "Code" },
  { value: "others", label: "Others" },
] as const;

export function documentFileType(
  document: Pick<
    TeamHubDocumentTreeSummary,
    "format" | "representation_format" | "title"
  >,
): string {
  const format = documentRepresentationFormat(document);
  if (format === "markdown") return "md";
  if (format === "plain_text") return "text";
  if (format === "csv") return "spreadsheet";
  const name = documentFileName(document);
  if (/\.(txt|log)$/i.test(name)) return "text";
  if (/\.(doc|docx)$/i.test(name)) return "word";
  const kind = artifactFileKind(name);
  if (kind === "markdown") return "md";
  return kind === "document" || kind === "workflow" ? "others" : kind;
}

export function matchesDocumentFileType(
  document: Pick<
    TeamHubDocumentTreeSummary,
    "format" | "representation_format" | "title"
  >,
  type: string,
) {
  return !type || documentFileType(document) === type;
}
