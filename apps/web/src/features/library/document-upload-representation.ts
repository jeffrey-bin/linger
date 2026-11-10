export function documentUploadRepresentationFormat(
  file: Pick<File, "name">,
): string {
  const name = file.name;
  if (!name.includes(".") || name.endsWith(".")) return "binary";
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (!extension) return "binary";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt" || extension === "log") return "plain_text";
  if (extension === "htm" || extension === "html") return "html";
  return extension;
}
