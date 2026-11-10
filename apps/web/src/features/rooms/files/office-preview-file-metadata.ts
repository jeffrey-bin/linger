export const officePreviewMediaTypes = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export type OfficePreviewExtension = keyof typeof officePreviewMediaTypes;

const genericBinaryMediaTypes = new Set(["", "application/octet-stream"]);

export function getOfficePreviewExtension(
  filename: string,
): OfficePreviewExtension | undefined {
  const separator = filename.lastIndexOf(".");
  const extension =
    separator < 0 ? "" : filename.slice(separator + 1).toLowerCase();
  return isOfficePreviewExtension(extension) ? extension : undefined;
}

export function isOfficePreviewExtension(
  extension: string,
): extension is OfficePreviewExtension {
  return extension in officePreviewMediaTypes;
}

export function isOfficePreviewMediaTypeCompatible(
  extension: OfficePreviewExtension,
  mediaType: string,
) {
  const normalizedMediaType =
    mediaType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    normalizedMediaType === officePreviewMediaTypes[extension] ||
    genericBinaryMediaTypes.has(normalizedMediaType)
  );
}
