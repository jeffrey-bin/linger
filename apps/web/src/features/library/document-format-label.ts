export function documentFormatLabel(format: string) {
  switch (format.toLocaleLowerCase()) {
    case "blocknote":
    case "markdown":
      return "md";
    case "plain_text":
      return "txt";
    default:
      return format.replaceAll("_", " ").toLocaleLowerCase();
  }
}
