import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";

import "./message-markdown.css";

import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";

import type {
  TeamHubActorRef,
  TeamHubMessageDocumentSegment,
  TeamHubMessageSegment,
} from "@/features/teamhub/teamhub-types";
import { teamHubMentionTokenAliases } from "@/features/teamhub/teamhub-message-content";

import { useAgentMentionStyle } from "./agent-mention-style";
import { followChatExternalLink } from "./chat-external-link";

const mentionUrlPrefix = "linger-actor:";
const documentUrlPrefix = "linger-document:";

const humanElements = [
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
];

const agentElements = [
  ...humanElements,
  "span",
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
];

interface MessageMarkdownProps {
  readOnlyReferences?: boolean;
  authorKind: "agent" | "human";
  body: string;
  segments?: TeamHubMessageSegment[];
  documentReferences?: TeamHubMessageDocumentSegment[];
  documentTitles?: Readonly<Record<string, string>>;
  mentions?: TeamHubActorRef[];
  onOpenActor?: (actorId: string) => void;
  onOpenDocument?: (document: TeamHubMessageDocumentSegment) => void;
  onOpenUrl?: (url: string) => void;
}

const MarkdownActionsContext = createContext<
  Pick<
    MessageMarkdownProps,
    | "documentTitles"
    | "onOpenActor"
    | "onOpenDocument"
    | "onOpenUrl"
    | "readOnlyReferences"
  >
>({});
const EMPTY_DOCUMENT_REFERENCES: TeamHubMessageDocumentSegment[] = [];
const EMPTY_MENTIONS: TeamHubActorRef[] = [];

export function MessageMarkdown({
  documentTitles,
  onOpenActor,
  onOpenDocument,
  onOpenUrl,
  readOnlyReferences,
  ...content
}: MessageMarkdownProps) {
  const actions = useMemo(
    () => ({
      documentTitles,
      onOpenActor,
      onOpenDocument,
      onOpenUrl,
      readOnlyReferences,
    }),
    [
      documentTitles,
      onOpenActor,
      onOpenDocument,
      onOpenUrl,
      readOnlyReferences,
    ],
  );
  return (
    <MarkdownActionsContext.Provider value={actions}>
      <MemoizedMarkdownContent {...content} />
    </MarkdownActionsContext.Provider>
  );
}

const MemoizedMarkdownContent = memo(function MarkdownContent({
  authorKind,
  body,
  segments,
  documentReferences = EMPTY_DOCUMENT_REFERENCES,
  mentions = EMPTY_MENTIONS,
}: Omit<
  MessageMarkdownProps,
  "documentTitles" | "onOpenActor" | "onOpenDocument" | "readOnlyReferences"
>) {
  const mentionContent = prepareMentionContent(body, segments, mentions);
  const markdownBody =
    authorKind === "agent"
      ? normalizeAgentReplyMarkdown(mentionContent.body)
      : mentionContent.body;
  const mentionsByUrl = new Map(
    [...mentionContent.tokens.values()].map((mention) => [
      mentionUrl(mention.actorId),
      mention,
    ]),
  );
  const documentsByUrl = new Map(
    documentReferences.map((document) => [
      documentUrl(document.document_id),
      document,
    ]),
  );
  const components: Components = {
    a({ children, href }) {
      return (
        <MarkdownLink
          href={href}
          authorKind={authorKind}
          mentionsByUrl={mentionsByUrl}
          documentsByUrl={documentsByUrl}
        >
          {children}
        </MarkdownLink>
      );
    },
    blockquote({ children }) {
      return <blockquote>{children}</blockquote>;
    },
    code({ children }) {
      return <code>{children}</code>;
    },
    h1({ children }) {
      return <h1>{children}</h1>;
    },
    h2({ children }) {
      return <h2>{children}</h2>;
    },
    h3({ children }) {
      return <h3>{children}</h3>;
    },
    li({ children }) {
      return <li>{children}</li>;
    },
    ol({ children }) {
      return <ol>{children}</ol>;
    },
    p({ children }) {
      return <p>{children}</p>;
    },
    pre({ children }) {
      return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
    },
    table({ children }) {
      return (
        <div className="tiptap-table-scroll-wrapper">
          <div className="tiptap-table-scroll-viewport">
            <table>{children}</table>
          </div>
        </div>
      );
    },
    td({ children }) {
      return <td>{children}</td>;
    },
    th({ children }) {
      return <th>{children}</th>;
    },
    ul({ children }) {
      return <ul>{children}</ul>;
    },
  };

  return (
    <div className="message-markdown min-w-0 max-w-full [overflow-wrap:anywhere]">
      <ReactMarkdown
        allowedElements={authorKind === "agent" ? agentElements : humanElements}
        components={components}
        remarkPlugins={[
          remarkBreaks,
          // CommonMark ignores ** next to CJK punctuation, such as a fullwidth colon
          // (U+FF1A) right before the closing ** that CJK text follows directly.
          remarkCjkFriendly,
          ...(authorKind === "agent" ? [remarkGfm] : []),
          ...(authorKind === "agent" ? [unavailableCitationPlugin] : []),
          structuredMentionPlugin(mentionContent.tokens),
          ...(documentReferences.length
            ? [structuredDocumentPlugin(documentReferences)]
            : []),
        ]}
        skipHtml
        unwrapDisallowed
        urlTransform={(url) =>
          mentionsByUrl.has(url) || documentsByUrl.has(url)
            ? url
            : defaultUrlTransform(url)
        }
      >
        {markdownBody}
      </ReactMarkdown>
    </div>
  );
});

function MarkdownLink({
  children,
  href,
  authorKind,
  mentionsByUrl,
  documentsByUrl,
}: {
  children?: import("react").ReactNode;
  href?: string;
  authorKind: "agent" | "human";
  mentionsByUrl: Map<string, MentionToken>;
  documentsByUrl: Map<string, TeamHubMessageDocumentSegment>;
}) {
  const {
    documentTitles = {},
    onOpenActor,
    onOpenDocument,
    readOnlyReferences,
  } = useContext(MarkdownActionsContext);

  const document = href ? documentsByUrl.get(href) : undefined;
  if (document) {
    if (readOnlyReferences)
      return <span className="message-composer-reference">{children}</span>;
    return (
      <button
        aria-label={`Open ${documentTitles[document.document_id] ?? document.content.slice(1)}`}
        className="message-composer-reference"
        data-reference-kind="document"
        onClick={() => onOpenDocument?.(document)}
        type="button"
      >
        {children}
      </button>
    );
  }
  const mentionedActor = href ? mentionsByUrl.get(href) : undefined;
  if (mentionedActor?.kind === "agent")
    return (
      <AgentMention
        actorId={mentionedActor.actorId}
        label={mentionedActor.label}
        name={mentionedActor.name}
        onOpen={
          onOpenActor ? () => onOpenActor(mentionedActor.actorId) : undefined
        }
      />
    );
  if (mentionedActor) {
    if (onOpenActor) {
      return (
        <button
          className="actor-profile-inline-trigger whitespace-nowrap bg-[var(--app-mention-surface)] px-1 font-semibold text-[var(--app-mention-text)] transition-colors hover:bg-[var(--app-mention-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus [border-radius:var(--app-control-radius)]"
          onClick={() => onOpenActor(mentionedActor.actorId)}
          type="button"
        >
          {children}
        </button>
      );
    }
    return (
      <mark className="whitespace-nowrap bg-[var(--app-mention-surface)] px-1 text-[var(--app-mention-text)] [border-radius:var(--app-control-radius)]">
        {children}
      </mark>
    );
  }
  if (!href) {
    return <span>{children}</span>;
  }
  if (readOnlyReferences) {
    try {
      const target = new URL(href, window.location.origin);
      if (
        target.origin === window.location.origin ||
        !["https:", "http:"].includes(target.protocol)
      )
        return <span>{children}</span>;
    } catch {
      return <span>{children}</span>;
    }
  }
  if (authorKind === "agent" && isLocalFileReference(href)) {
    return <span>{children}</span>;
  }

  return <MarkdownExternalLink href={href}>{children}</MarkdownExternalLink>;
}

function MarkdownExternalLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  const { onOpenUrl } = useContext(MarkdownActionsContext);
  return (
    <a
      className="underline underline-offset-2"
      href={href}
      onClick={(event) => followChatExternalLink(event, href, onOpenUrl)}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

// A single # before text is a tag or issue number such as #1, not a heading.
const streamedHeadingWithoutSpace = /^([ \t]{0,3})(#{2,6})(?=[^\s#!])/;
const fencedCodeBlock = /^[ \t]{0,3}(```|~~~)/;

function normalizeAgentReplyMarkdown(content: string) {
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (fencedCodeBlock.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(streamedHeadingWithoutSpace, "$1$2 ");
    })
    .join("\n");
}

const LOCAL_FILE_PATH_PATTERN =
  /\/(?:v0\/)?(?:document|artifact|playground)[-/]/i;

function isLocalFileReference(href: string) {
  if (
    href.startsWith("./") ||
    href.startsWith("../") ||
    href.startsWith("sandbox:") ||
    href.startsWith("file:")
  ) {
    return true;
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(href)) {
    return /(?:^|\/)[^/?#]+\.[a-z\d]{1,12}(?:[?#].*)?$/i.test(href);
  }
  try {
    const url = new URL(href);
    return (
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
      LOCAL_FILE_PATH_PATTERN.test(url.pathname)
    );
  } catch {
    return false;
  }
}

interface MarkdownNode {
  children?: MarkdownNode[];
  type: string;
  url?: string;
  value?: string;
  data?: {
    hName: string;
    hProperties: { className: string };
  };
}

// Source IDs have no URL mapping in historical messages. Preserve the raw
// message and code examples; replace only rendered prose citations.
function unavailableCitationPlugin() {
  return (tree: MarkdownNode) => {
    const replace = (parent: MarkdownNode): void => {
      if (
        !parent.children ||
        parent.type === "code" ||
        parent.type === "inlineCode"
      )
        return;
      parent.children = parent.children.flatMap<MarkdownNode>((child) => {
        if (child.type !== "text" || !child.value) {
          replace(child);
          return [child];
        }
        return child.value
          .split(/(\uE200cite\uE202[^\uE200\uE201]*\uE201)/u)
          .map<MarkdownNode>((part, index) =>
            index % 2 === 1
              ? {
                  type: "unavailableCitation",
                  data: {
                    hName: "span",
                    hProperties: { className: "text-app-muted" },
                  },
                  children: [
                    { type: "text", value: "Source link unavailable" },
                  ],
                }
              : { type: "text", value: part },
          );
      });
    };
    replace(tree);
  };
}

interface MentionToken {
  actorId: string;
  /** Known from the message's mentions; unknown Actors keep the plain chip. */
  kind?: "agent" | "human";
  label: string;
  name: string;
  source: string;
}

function prepareMentionContent(
  body: string,
  segments: TeamHubMessageSegment[] | undefined,
  mentions: TeamHubActorRef[],
) {
  const tokens = new Map<string, MentionToken>();
  if (!segments?.some((segment) => segment.type === "reference")) {
    for (const actor of mentions) {
      for (const label of teamHubMentionTokenAliases(actor)) {
        tokens.set(label, {
          actorId: actor.id,
          kind: actor.kind,
          label,
          name: actor.display_name,
          source: label,
        });
      }
    }
    return { body, tokens };
  }

  // Preserve each reference's position and identity through Markdown parsing.
  const literalTokens = new Set(body.match(/LINGERMENTION\d+END/g) ?? []);
  let tokenId = 0;
  const content = segments
    .map((segment, index) => {
      if (segment.type !== "reference") return segment.content;
      // CLI senders drop the whitespace-only text between two mentions.
      const gap = segments[index - 1]?.type === "reference" ? " " : "";
      const label = segment.content.trim();
      // Actor display names are at most 120 Unicode characters. Historical
      // senders could put an entire reply in this field; render that as prose
      // rather than hiding Markdown inside a single unwrappable mention.
      if (
        /[\r\n\u2028\u2029]/u.test(segment.content) ||
        [...label.replace(/^@/, "")].length > 120
      ) {
        return gap + segment.content;
      }
      let token = `LINGERMENTION${tokenId++}END`;
      while (literalTokens.has(token)) token = `LINGERMENTION${tokenId++}END`;
      const actor = mentions.find((item) => item.id === segment.target);
      tokens.set(token, {
        actorId: segment.target,
        kind: actor?.kind,
        label: label.startsWith("@") ? label : `@${label}`,
        name: actor?.display_name ?? label.replace(/^@/, ""),
        source: segment.content,
      });
      return gap + token;
    })
    .join("");
  return { body: content, tokens };
}

function structuredMentionPlugin(mentionsByToken: Map<string, MentionToken>) {
  const tokens = [...mentionsByToken.keys()].sort(
    (first, second) => second.length - first.length,
  );
  const tokenPattern = tokens.length
    ? new RegExp(`(${tokens.map(escapeRegularExpression).join("|")})`, "g")
    : null;

  return () => (tree: MarkdownNode) => {
    if (tokenPattern) {
      replaceMentionText(tree, mentionsByToken, tokenPattern);
    }
  };
}

function structuredDocumentPlugin(documents: TeamHubMessageDocumentSegment[]) {
  const documentsByToken = new Map(
    documents.map((document) => [document.content, document]),
  );
  const tokens = [...documentsByToken.keys()].sort(
    (first, second) => second.length - first.length,
  );
  const tokenPattern = tokens.length
    ? new RegExp(`(${tokens.map(escapeRegularExpression).join("|")})`, "g")
    : null;

  return () => (tree: MarkdownNode) => {
    if (tokenPattern) {
      replaceDocumentText(tree, documentsByToken, tokenPattern);
    }
  };
}

function replaceDocumentText(
  parent: MarkdownNode,
  documentsByToken: Map<string, TeamHubMessageDocumentSegment>,
  tokenPattern: RegExp,
) {
  if (
    !parent.children ||
    parent.type === "code" ||
    parent.type === "inlineCode" ||
    parent.type === "link" ||
    parent.type === "linkReference"
  ) {
    return;
  }

  parent.children = parent.children.flatMap<MarkdownNode>((child) => {
    if (child.type !== "text" || !child.value) {
      replaceDocumentText(child, documentsByToken, tokenPattern);
      return [child];
    }

    return child.value
      .split(tokenPattern)
      .filter(Boolean)
      .map<MarkdownNode>((part) => {
        const document = documentsByToken.get(part);
        return document
          ? {
              children: [{ type: "text", value: part }],
              type: "link",
              url: documentUrl(document.document_id),
            }
          : { type: "text", value: part };
      });
  });
}

function replaceMentionText(
  parent: MarkdownNode,
  mentionsByToken: Map<string, MentionToken>,
  tokenPattern: RegExp,
  inactive = false,
) {
  const literal =
    inactive ||
    parent.type === "code" ||
    parent.type === "inlineCode" ||
    parent.type === "link" ||
    parent.type === "linkReference";
  if (literal && parent.value) {
    parent.value = parent.value.replace(
      tokenPattern,
      (token) => mentionsByToken.get(token)?.source ?? token,
    );
  }
  if (parent.url) {
    parent.url = parent.url.replace(
      tokenPattern,
      (token) => mentionsByToken.get(token)?.source ?? token,
    );
  }
  if (!parent.children) return;

  parent.children = parent.children.flatMap<MarkdownNode>((child) => {
    if (child.type !== "text" || !child.value) {
      replaceMentionText(child, mentionsByToken, tokenPattern, literal);
      return [child];
    }

    return child.value
      .split(tokenPattern)
      .filter(Boolean)
      .map<MarkdownNode>((part) => {
        const mention = mentionsByToken.get(part);
        return mention && !literal
          ? {
              children: [{ type: "text", value: mention.label }],
              type: "link",
              url: mentionUrl(mention.actorId),
            }
          : { type: "text", value: mention?.source ?? part };
      });
  });
}

function mentionUrl(actorId: string) {
  return `${mentionUrlPrefix}${encodeURIComponent(actorId)}`;
}

function documentUrl(documentId: string) {
  return `${documentUrlPrefix}${encodeURIComponent(documentId)}`;
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A fenced code block with a copy button in its top-right corner. */
function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="message-code-block">
      <pre ref={preRef}>{children}</pre>
      <button
        aria-label={copied ? "Copied" : "Copy code"}
        className="message-code-copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(preRef.current?.textContent ?? "")
            .then(() => setCopied(true));
        }}
        title={copied ? "Copied" : "Copy code"}
        type="button"
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
      </button>
    </div>
  );
}

/**
 * An Agent mention reads as the Agent itself: its avatar and name, the name
 * in the avatar's background colour (darkened when too light to read) on a
 * faint tint of it.
 */
function AgentMention({
  actorId,
  label,
  name,
  onOpen,
}: {
  actorId: string;
  /** The written mention, so assistive tech still hears "@Name". */
  label: string;
  name: string;
  onOpen?: () => void;
}) {
  const style = useAgentMentionStyle(actorId, name);
  const content = (
    <>
      <span aria-hidden="true">
        <ActorAvatar
          actorId={actorId}
          kind="agent"
          name={name}
          showTitle={false}
          size="micro"
        />
      </span>
      {name}
    </>
  );
  return onOpen ? (
    <button
      aria-label={label}
      className="agent-mention"
      data-actor-id={actorId}
      onClick={onOpen}
      style={style}
      type="button"
    >
      {content}
    </button>
  ) : (
    <mark
      aria-label={label}
      className="agent-mention"
      data-actor-id={actorId}
      style={style}
    >
      {content}
    </mark>
  );
}
