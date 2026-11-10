import type {
  TeamHubArtifactContent,
  TeamHubDocumentVersion,
} from "@/features/teamhub/teamhub-types";
import { digestBlobSha256 } from "@/features/teamhub/sha256-digest";

type ArtifactIntegrityMetadata = Pick<
  TeamHubDocumentVersion,
  "media_type" | "sha256" | "size_bytes"
>;

export async function verifyArtifactDownloadIntegrity(
  version: ArtifactIntegrityMetadata,
  content: TeamHubArtifactContent,
) {
  if (content.blob.size !== version.size_bytes) {
    throw new Error(
      "The downloaded bytes do not match its immutable Version metadata.",
    );
  }

  const metadataMediaType = normalizedMediaType(version.media_type);
  const responseMediaType = normalizedMediaType(content.mediaType);
  const blobMediaType = normalizedMediaType(content.blob.type);
  if (!metadataMediaType) {
    throw new Error("The immutable Version has no usable media type.");
  }
  if (
    !isCompatibleTransferMediaType(responseMediaType, metadataMediaType) ||
    !isCompatibleTransferMediaType(blobMediaType, metadataMediaType)
  ) {
    throw new Error(
      "The downloaded media type does not match its immutable Version metadata.",
    );
  }

  const expectedSha256 = version.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("The immutable Version has no usable SHA-256 digest.");
  }
  const actualSha256 =
    content.sha256?.toLowerCase() ?? (await digestBlobSha256(content.blob));
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      "The downloaded SHA-256 does not match its immutable Version metadata.",
    );
  }

  return {
    blob:
      blobMediaType === metadataMediaType
        ? content.blob
        : content.blob.slice(0, content.blob.size, metadataMediaType),
    mediaType: metadataMediaType,
  };
}

function isCompatibleTransferMediaType(
  transferMediaType: string,
  metadataMediaType: string,
) {
  return (
    !transferMediaType ||
    transferMediaType === "application/octet-stream" ||
    transferMediaType === metadataMediaType
  );
}

function normalizedMediaType(value: string) {
  return value.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}
