// The one extension table of file types: the Document representation format
// and the media type a file is stored with. It has no Node dependency, so the
// CLI and the Web read the same table.
const fileTypes = new Map<string, readonly [string, string]>([
  ["avif", ["avif", "image/avif"]],
  ["bmp", ["bmp", "image/bmp"]],
  ["css", ["css", "text/css"]],
  ["csv", ["csv", "text/csv"]],
  ["doc", ["doc", "application/msword"]],
  [
    "docx",
    [
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  ],
  ["gif", ["gif", "image/gif"]],
  ["htm", ["html", "text/html"]],
  ["html", ["html", "text/html"]],
  ["jpeg", ["jpeg", "image/jpeg"]],
  ["jpg", ["jpeg", "image/jpeg"]],
  ["js", ["javascript", "text/javascript"]],
  ["json", ["json", "application/json"]],
  ["m4a", ["m4a", "audio/mp4"]],
  ["m4v", ["m4v", "video/mp4"]],
  ["markdown", ["markdown", "text/markdown"]],
  ["md", ["markdown", "text/markdown"]],
  ["mjs", ["javascript", "text/javascript"]],
  ["mov", ["mov", "video/quicktime"]],
  ["mp3", ["mp3", "audio/mpeg"]],
  ["mp4", ["mp4", "video/mp4"]],
  ["ogv", ["ogv", "video/ogg"]],
  ["otf", ["otf", "font/otf"]],
  ["pdf", ["pdf", "application/pdf"]],
  ["png", ["png", "image/png"]],
  ["ppt", ["ppt", "application/vnd.ms-powerpoint"]],
  [
    "pptx",
    [
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ],
  ["svg", ["svg", "image/svg+xml"]],
  ["ttf", ["ttf", "font/ttf"]],
  ["txt", ["plain_text", "text/plain"]],
  ["wasm", ["wasm", "application/wasm"]],
  ["wav", ["wav", "audio/wav"]],
  ["webm", ["webm", "video/webm"]],
  ["webp", ["webp", "image/webp"]],
  ["woff", ["woff", "font/woff"]],
  ["woff2", ["woff2", "font/woff2"]],
  ["xls", ["xls", "application/vnd.ms-excel"]],
  [
    "xlsx",
    [
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ],
  ["xml", ["xml", "application/xml"]],
]);

function fileExtension(filename: string): string {
  const basename = filename.split(/[\\/]/u).at(-1) ?? "";
  const separator = basename.lastIndexOf(".");
  return separator > 0 ? basename.slice(separator + 1).toLowerCase() : "";
}

/** The media type the table stores for an extension, without its dot. */
export function mediaTypeForExtension(extension: string): string | undefined {
  return fileTypes.get(extension.toLowerCase())?.[1];
}

/** Fill missing/generic metadata only; an explicit MIME remains authoritative.
 * Extension inference is metadata, not validation of the file's contents.
 */
export function inferDocumentMediaType(
  filename: string,
  declaredMediaType = "",
): string {
  const declared = declaredMediaType.trim();
  const normalized = declared.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return declared;
  return (
    fileTypes.get(fileExtension(filename))?.[1] ?? "application/octet-stream"
  );
}

/** Filename metadata is shared by CLI file publication and atomic messages. */
export function inferFileMetadata(name: string): {
  representation_format: string;
  media_type: string;
} {
  const extension = fileExtension(name);
  const [representation_format, media_type] = fileTypes.get(extension) ?? [
    extension || "binary",
    "application/octet-stream",
  ];
  return { representation_format, media_type };
}
