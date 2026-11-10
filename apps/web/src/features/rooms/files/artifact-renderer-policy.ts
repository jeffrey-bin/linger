import { mediaTypeForExtension } from "@linger/document-files/media-type";
import { artifactPreviewMaxFileBytes } from "./artifact-preview-limits";
import {
  isOfficePreviewExtension,
  isOfficePreviewMediaTypeCompatible,
} from "./office-preview-file-metadata";

export type ArtifactRendererKind =
  | "csv"
  | "download"
  | "html"
  | "image"
  | "markdown"
  | "media"
  | "mermaid"
  | "office"
  | "pdf"
  | "svg"
  | "text";

export interface ArtifactRendererDecision {
  kind: ArtifactRendererKind;
  reason?: string;
}

const dataMediaByExtension: Record<string, string[]> = {
  csv: ["application/csv", "text/csv", "text/plain"],
  tsv: ["text/plain", "text/tab-separated-values"],
};
const sourceExtensions = new Set([
  "c",
  "cpp",
  "css",
  "go",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "py",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);
const imageMediaByExtension: Record<string, string[]> = {
  avif: ["image/avif"],
  bmp: ["image/bmp"],
  gif: ["image/gif"],
  jpeg: ["image/jpeg"],
  jpg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};
const mediaTypesByExtension: Record<string, string[]> = {
  aac: ["audio/aac"],
  flac: ["audio/flac", "audio/x-flac"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  mp3: ["audio/mpeg"],
  oga: ["audio/ogg"],
  ogg: ["audio/ogg", "video/ogg"],
  ogv: ["video/ogg"],
  wav: ["audio/wav", "audio/x-wav"],
  m4v: ["video/mp4"],
  mov: ["video/quicktime"],
  mp4: ["video/mp4"],
  webm: ["audio/webm", "video/webm"],
};
const yamlMediaTypes = new Set([
  "application/x-yaml",
  "application/yaml",
  "text/x-yaml",
  "text/yaml",
]);
const genericBinaryMediaTypes = new Set(["", "application/octet-stream"]);

export function resolveArtifactPreviewMediaType(
  filename: string,
  mediaType: string,
) {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!genericBinaryMediaTypes.has(normalized)) {
    return normalized;
  }
  return canonicalMediaTypeForExtension(fileExtension(filename)) ?? normalized;
}

export function selectArtifactRenderer(input: {
  filename: string;
  mediaType: string;
  sizeBytes: number;
}): ArtifactRendererDecision {
  const extension = fileExtension(input.filename);
  const mediaType = resolveArtifactPreviewMediaType(
    input.filename,
    input.mediaType,
  );

  if (extension === "md" || extension === "markdown") {
    return matchingTextRenderer(
      [
        "application/x-markdown",
        "text/markdown",
        "text/plain",
        "text/x-markdown",
      ],
      mediaType,
      input.sizeBytes,
      "markdown",
      "Markdown",
    );
  }

  if (extension === "mmd" || extension === "mermaid") {
    return matchingTextRenderer(
      ["text/plain", "text/vnd.mermaid"],
      mediaType,
      input.sizeBytes,
      "mermaid",
      "Mermaid",
    );
  }

  if (extension === "html" || extension === "htm") {
    return matchingTextRenderer(
      ["text/html"],
      mediaType,
      input.sizeBytes,
      "html",
      "HTML",
    );
  }

  if (extension === "svg") {
    if (mediaType !== "image/svg+xml") {
      return mismatchDecision();
    }
    return input.sizeBytes <= artifactPreviewMaxFileBytes
      ? { kind: "svg" }
      : {
          kind: "download",
          reason: "This file is larger than the safe SVG preview limit.",
        };
  }

  if (extension === "pdf") {
    if (mediaType !== "application/pdf") {
      return mismatchDecision();
    }
    return input.sizeBytes <= artifactPreviewMaxFileBytes
      ? { kind: "pdf" }
      : {
          kind: "download",
          reason: "This file is larger than the safe PDF preview limit.",
        };
  }

  const expectedDataMedia = dataMediaByExtension[extension];
  if (expectedDataMedia) {
    return expectedDataMedia.includes(mediaType)
      ? { kind: "csv" }
      : mismatchDecision();
  }

  if (isOfficePreviewExtension(extension)) {
    if (!isOfficePreviewMediaTypeCompatible(extension, mediaType)) {
      return mismatchDecision();
    }
    return input.sizeBytes <= artifactPreviewMaxFileBytes
      ? { kind: "office" }
      : {
          kind: "download",
          reason:
            "This file is larger than the 50 MiB basic Office preview limit.",
        };
  }

  const expectedImageMedia = imageMediaByExtension[extension];
  if (expectedImageMedia) {
    if (!expectedImageMedia.includes(mediaType)) {
      return mismatchDecision();
    }
    return input.sizeBytes <= artifactPreviewMaxFileBytes
      ? { kind: "image" }
      : {
          kind: "download",
          reason: "This image is larger than the safe preview limit.",
        };
  }

  if (
    sourceExtensions.has(extension) &&
    (mediaType.startsWith("text/") ||
      mediaType === "application/json" ||
      mediaType === "application/xml" ||
      ((extension === "yaml" || extension === "yml") &&
        yamlMediaTypes.has(mediaType)))
  ) {
    return input.sizeBytes <= artifactPreviewMaxFileBytes
      ? { kind: "text" }
      : {
          kind: "download",
          reason: "This text file is larger than the safe preview limit.",
        };
  }

  const expectedMediaTypes = mediaTypesByExtension[extension];
  if (expectedMediaTypes) {
    return expectedMediaTypes.includes(mediaType)
      ? { kind: "media" }
      : mismatchDecision();
  }

  return {
    kind: "download",
    reason: "This format is available as a download only.",
  };
}

function matchingTextRenderer(
  allowedMediaTypes: string[],
  mediaType: string,
  sizeBytes: number,
  kind: ArtifactRendererKind,
  label: string,
): ArtifactRendererDecision {
  if (!allowedMediaTypes.includes(mediaType)) {
    return mismatchDecision();
  }

  return sizeBytes <= artifactPreviewMaxFileBytes
    ? { kind }
    : {
        kind: "download",
        reason: `This file is larger than the safe ${label} preview limit.`,
      };
}

function mismatchDecision(): ArtifactRendererDecision {
  return {
    kind: "download",
    reason: "The filename and media type do not agree, so preview is disabled.",
  };
}

// Generic metadata takes the media type of the shared file type table; the
// preview tables only fill extensions that table does not know.
function canonicalMediaTypeForExtension(extension: string) {
  const shared = mediaTypeForExtension(extension);
  if (shared) return shared;
  if (extension === "mmd" || extension === "mermaid") return "text/plain";
  if (extension === "yaml" || extension === "yml") return "application/yaml";
  if (sourceExtensions.has(extension)) return "text/plain";
  return (
    dataMediaByExtension[extension]?.[0] ??
    mediaTypesByExtension[extension]?.[0]
  );
}

function fileExtension(filename: string) {
  const separator = filename.lastIndexOf(".");
  return separator < 0 ? "" : filename.slice(separator + 1).toLowerCase();
}
