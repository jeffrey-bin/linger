const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/;
const tableDelimiter = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const thematicBreak = /^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/;

/**
 * Plain text for message previews such as the sidebar, reply quotes and
 * search results, so Agent Markdown does not show `##`, `**` or table pipes.
 * Previews sit on the initial bundle, which cannot afford a Markdown parser,
 * so this is a line-based approximation rather than a CommonMark renderer.
 */
export function markdownPlainText(markdown: string): string {
  const source = markdown.split(/\r?\n/);
  const lines: string[] = [];
  let fence = "";
  let table = false;
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    const marker = fenceMarker.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence[0]!) && marker.length >= fence.length)
        fence = "";
      else lines.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (
      !table &&
      line.includes("|") &&
      tableDelimiter.test(source[index + 1] ?? "")
    ) {
      table = true;
      index++;
      lines.push(tableRow(line));
      continue;
    }
    if (table && line.includes("|")) {
      lines.push(tableRow(line));
      continue;
    }
    table = false;
    if (thematicBreak.test(line)) continue;
    lines.push(
      inlinePlainText(
        line
          .replace(/^(?:\s{0,3}>\s?)+/, "")
          .replace(/^\s{0,3}(?:#{1,6}(?:\s+|$)|#{2,6}(?=[^\s#]))/, "")
          .replace(/\s+#+\s*$/, "")
          .replace(/^(\s*)[-*+]\s+/, "$1")
          .replace(/^(\s*(?:\d+[.)]\s+)?)\[[ xX]\]\s+/, "$1"),
      ),
    );
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tableRow(line: string) {
  return line
    .trim()
    .replace(/^\||(?<!\\)\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => inlinePlainText(cell.trim()))
    .filter(Boolean)
    .join(" · ");
}

function inlinePlainText(text: string) {
  // Parts cycle through prose, a code span's backticks and its literal content.
  return text
    .split(/(`+)(.+?)\1/)
    .map((part, index) => {
      if (index % 3 === 1) return "";
      if (index % 3 === 2) return part;
      const escaped: string[] = [];
      return part
        .replace(
          /\\([!-/:-@[-`{-~])/g,
          (_, char: string) => `\uE000${escaped.push(char) - 1}\uE001`,
        )
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
        .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
        .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, "$2")
        .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
        .replace(
          /(^|[^\p{L}\p{N}_])_(\S(?:.*?\S)?)_(?![\p{L}\p{N}_])/gu,
          "$1$2",
        )
        .replace(/\uE000(\d+)\uE001/g, (_, at: string) => escaped[Number(at)]!);
    })
    .join("");
}
