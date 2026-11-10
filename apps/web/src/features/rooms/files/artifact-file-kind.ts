const archiveExtensions = new Set([
  "7z",
  "bz2",
  "gz",
  "gzip",
  "rar",
  "tar",
  "xz",
  "zip",
]);
const audioExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
]);
const codeExtensions = new Set([
  "c",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "less",
  "mmd",
  "py",
  "rs",
  "scss",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);
const imageExtensions = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);
const spreadsheetExtensions = new Set(["csv", "ods", "tsv", "xls", "xlsx"]);
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "webm"]);
const pdfExtensions = new Set(["pdf"]);
const wordExtensions = new Set(["doc", "docx"]);
const powerpointExtensions = new Set(["ppt", "pptx"]);
const markdownExtensions = new Set(["md", "markdown"]);
const htmlExtensions = new Set(["htm", "html"]);
const textExtensions = new Set(["log", "txt"]);
const knownExtensions = new Set([
  ...archiveExtensions,
  ...audioExtensions,
  ...codeExtensions,
  ...htmlExtensions,
  ...imageExtensions,
  ...markdownExtensions,
  ...pdfExtensions,
  ...powerpointExtensions,
  ...spreadsheetExtensions,
  ...textExtensions,
  ...videoExtensions,
  ...wordExtensions,
  "workflow",
]);

export type ArtifactFileKind =
  | "archive"
  | "audio"
  | "code"
  | "document"
  | "html"
  | "image"
  | "markdown"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "video"
  | "workflow";

const fileKindLabels: Record<ArtifactFileKind, string> = {
  archive: "Archive",
  audio: "Audio",
  code: "Code",
  document: "Document",
  html: "HTML",
  image: "Image",
  markdown: "Markdown",
  pdf: "PDF",
  presentation: "PowerPoint",
  spreadsheet: "Excel",
  video: "Video",
  workflow: "Workflow",
};

export function artifactFileKind(
  filename: string,
  mediaType?: string,
): ArtifactFileKind {
  const separator = filename.lastIndexOf(".");
  const suffix =
    separator >= 0 ? filename.slice(separator + 1).toLowerCase() : "";
  if (!knownExtensions.has(suffix)) {
    const mediaKind = kindFromMediaType(mediaType);
    if (mediaKind) return mediaKind;
  }
  const extension = fileExtension(filename);
  if (extension === "workflow") return "workflow";
  if (pdfExtensions.has(extension)) return "pdf";
  if (wordExtensions.has(extension)) return "document";
  if (powerpointExtensions.has(extension)) return "presentation";
  if (markdownExtensions.has(extension)) return "markdown";
  if (htmlExtensions.has(extension)) return "html";
  if (spreadsheetExtensions.has(extension)) return "spreadsheet";
  if (imageExtensions.has(extension)) return "image";
  if (audioExtensions.has(extension)) return "audio";
  if (videoExtensions.has(extension)) return "video";
  if (archiveExtensions.has(extension)) return "archive";
  if (codeExtensions.has(extension)) return "code";
  return kindFromMediaType(mediaType) ?? "document";
}

export function artifactFileTypeLabel(filename: string, mediaType?: string) {
  const extension = fileExtension(filename);
  if (extension === "doc" || extension === "docx") return "Word";
  if (extension === "csv" || extension === "tsv") return "CSV";
  if (textExtensions.has(extension)) return "Text";
  return fileKindLabels[artifactFileKind(filename, mediaType)];
}

function fileExtension(filename: string) {
  const separator = filename.lastIndexOf(".");
  if (separator >= 0) {
    const extension = filename.slice(separator + 1).toLowerCase();
    if (knownExtensions.has(extension)) return extension;
  }

  for (const token of filename.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (knownExtensions.has(token)) return token;
  }
  return "";
}

function kindFromMediaType(
  mediaType: string | undefined,
): ArtifactFileKind | undefined {
  if (!mediaType) return undefined;
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!normalized || normalized === "application/octet-stream") {
    return undefined;
  }
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/html") return "html";
  if (normalized === "text/markdown") return "markdown";
  if (normalized === "text/csv" || normalized.includes("spreadsheet")) {
    return "spreadsheet";
  }
  if (
    normalized.includes("presentation") ||
    normalized.includes("powerpoint")
  ) {
    return "presentation";
  }
  if (normalized.includes("wordprocessing")) return "document";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (
    normalized === "application/zip" ||
    normalized === "application/gzip" ||
    normalized === "application/x-tar"
  ) {
    return "archive";
  }
  return undefined;
}
