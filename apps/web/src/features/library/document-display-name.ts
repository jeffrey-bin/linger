import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

type DocumentDisplayNameInput = Pick<
  TeamHubDocument,
  "format" | "representation_format" | "title"
> &
  Partial<Pick<TeamHubDocument, "draft_capability">>;

const extensionByRepresentation: Readonly<Record<string, string>> = {
  csv: "csv",
  html: "html",
  markdown: "md",
  pdf: "pdf",
  plain_text: "txt",
};

export function documentRepresentationFormat(
  document: DocumentDisplayNameInput,
) {
  return (
    document.representation_format ??
    (document.format === "blocknote" ? "markdown" : document.format)
  );
}

export function documentLogicalTitle(document: DocumentDisplayNameInput) {
  const title = document.title.trim();
  if (document.draft_capability === "none") return title;
  const extension =
    extensionByRepresentation[documentRepresentationFormat(document)];
  const suffix = extension ? `.${extension}` : "";
  return suffix && title.toLowerCase().endsWith(suffix)
    ? title.slice(0, -suffix.length)
    : title;
}

export function documentFileName(document: DocumentDisplayNameInput) {
  const title = documentLogicalTitle(document);
  const extension =
    extensionByRepresentation[documentRepresentationFormat(document)];
  if (!extension || title.toLowerCase().endsWith(`.${extension}`)) return title;
  return `${title}.${extension}`;
}
