import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { ToolExecutionError } from "../../domain-support/errors.js";

const markdown = unified().use(remarkParse).use(remarkGfm).freeze();

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Validate the entire batch before any message or sequence is published. */
export function assertMessageCitations(messages: readonly string[]): void {
  for (const message of messages) {
    if (hasCitation(markdown.parse(message))) {
      throw new ToolExecutionError(
        "unsupported_message_citation",
        "No messages were sent. Replace provider-internal citations with standard Markdown links [source title](real URL), then call this same tool again with the corrected messages. Resolve missing source URLs; do not invent them. Put literal citation syntax in code when explaining it.",
        { details: { sent: false } },
      );
    }
  }
}

function hasCitation(node: MarkdownNode): boolean {
  if (node.type === "code" || node.type === "inlineCode") return false;
  return Boolean(
    node.value?.includes("\uE200cite\uE202") ||
    node.children?.some(hasCitation),
  );
}
