import type {
  TeamHubDocument,
  TeamHubDocumentVersion,
} from "@/features/teamhub/teamhub-types";
import {
  artifactFileKind,
  artifactFileTypeLabel,
  type ArtifactFileKind,
} from "./artifact-file-kind";

export type DocumentCardMetadata = Pick<
  TeamHubDocument,
  "title" | "format" | "representation_format"
> &
  Partial<Pick<TeamHubDocument, "current_version">> & {
    version?: Pick<TeamHubDocumentVersion, "filename" | "media_type">;
  };

export function documentCardPresentation(document?: DocumentCardMetadata): {
  filename: string;
  iconKind: ArtifactFileKind;
  typeLabel: string;
} {
  if (!document) {
    return {
      filename: "Document",
      iconKind: "document",
      typeLabel: "Document",
    };
  }
  if (document.format === "blocknote") {
    return {
      filename: document.title,
      iconKind: "document",
      typeLabel: "Online document",
    };
  }
  // The representation comes from TeamHub; titles and message labels are not formats.
  const format = document.representation_format || document.format;
  if (format === "binary" && document.version) {
    return {
      filename: document.title,
      iconKind: artifactFileKind(
        document.version.filename,
        document.version.media_type,
      ),
      typeLabel: artifactFileTypeLabel(
        document.version.filename,
        document.version.media_type,
      ),
    };
  }
  const typeFilename = `document.${format === "plain_text" ? "txt" : format}`;
  return {
    filename: document.title,
    iconKind: artifactFileKind(typeFilename),
    typeLabel: artifactFileTypeLabel(typeFilename),
  };
}
