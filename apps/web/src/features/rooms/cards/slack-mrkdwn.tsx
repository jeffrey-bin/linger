import type { ReactNode } from "react";

import "../chat/message-markdown.css";

/**
 * Slack's own markup, which is not Markdown: *bold*, _italic_, ~strike~,
 * `code`, ```blocks```, > quotes, and <url|text> links and mentions.
 * Everything else, including # and list markers, is shown as written.
 */
export function SlackMrkdwn({ text }: { text: string }) {
  return (
    <div className="message-markdown min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]">
      {mrkdwnBlocks(text).map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre key={index}>
              <code>{decodeEntities(block.text)}</code>
            </pre>
          );
        }
        if (block.kind === "quote") {
          return <blockquote key={index}>{inline(block.text)}</blockquote>;
        }
        return <div key={index}>{inline(block.text)}</div>;
      })}
    </div>
  );
}

interface Block {
  kind: "code" | "quote" | "text";
  text: string;
}

function mrkdwnBlocks(source: string): Block[] {
  const parts = source.split("```");
  // An unmatched fence is literal text.
  if (parts.length % 2 === 0) {
    const last = parts.pop() ?? "";
    parts[parts.length - 1] += "```" + last;
  }
  const blocks: Block[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({
        kind: "code",
        text: part.replace(/^\n/, "").replace(/\n$/, ""),
      });
      return;
    }
    // The line break next to a fence belongs to the code block.
    let text = part;
    if (index > 0) text = text.replace(/^\n/, "");
    if (index < parts.length - 1) text = text.replace(/\n$/, "");
    if (text === "") return;
    let lines: string[] = [];
    let quoting = false;
    const flush = () => {
      if (lines.length) {
        blocks.push({
          kind: quoting ? "quote" : "text",
          text: lines.join("\n"),
        });
      }
      lines = [];
    };
    for (const line of text.split("\n")) {
      const quote = /^(?:>|&gt;) ?(.*)$/.exec(line);
      if (Boolean(quote) !== quoting) flush();
      quoting = Boolean(quote);
      lines.push(quote ? (quote[1] ?? "") : line);
    }
    flush();
  });
  return blocks;
}

// Bold, italic, and strike need a non-word character (or an edge) outside the
// markers and no space just inside them, as in Slack.
const inlinePattern =
  /`([^`\n]+)`|<([^<>\n]+)>|(?<![\p{L}\p{N}*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\p{L}\p{N}~])/gu;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let position = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [whole, code, angle, bold, italic, strike] = match;
    if (match.index > position) {
      nodes.push(decodeEntities(text.slice(position, match.index)));
    }
    const key = match.index;
    if (code !== undefined) {
      nodes.push(<code key={key}>{decodeEntities(code)}</code>);
    } else if (angle !== undefined) {
      nodes.push(angleNode(angle, whole, key));
    } else if (bold !== undefined) {
      nodes.push(<strong key={key}>{inline(bold)}</strong>);
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{inline(italic)}</em>);
    } else {
      nodes.push(<del key={key}>{inline(strike ?? "")}</del>);
    }
    position = match.index + whole.length;
  }
  if (position < text.length) nodes.push(decodeEntities(text.slice(position)));
  return nodes;
}

/** A link, mention, or special token written as <...>. */
function angleNode(content: string, whole: string, key: number): ReactNode {
  const bar = content.indexOf("|");
  const target = bar === -1 ? content : content.slice(0, bar);
  const label = bar === -1 ? "" : decodeEntities(content.slice(bar + 1));
  if (target.startsWith("@")) return label ? `@${label}` : target;
  if (target.startsWith("#")) return label ? `#${label}` : target;
  if (target.startsWith("!")) {
    if (label) return label;
    return `@${target.slice(1).split("^")[0]}`;
  }
  const url = decodeEntities(target);
  if (/^(?:https?:|mailto:)/i.test(url)) {
    return (
      <a
        className="underline underline-offset-2"
        href={url}
        key={key}
        rel="noreferrer"
        target="_blank"
      >
        {label || url}
      </a>
    );
  }
  // Not a Slack control sequence: show the angle brackets as written.
  return decodeEntities(whole);
}

function decodeEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
