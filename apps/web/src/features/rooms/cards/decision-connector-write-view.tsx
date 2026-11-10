import DOMPurify from "dompurify";
import { ArrowDown01Icon, Attachment01Icon } from "@hugeicons/core-free-icons";
import { Fragment, useMemo, useState } from "react";

import { Icon } from "@/components/ui/icon";

import { MessageMarkdown } from "../chat/message-markdown";
import { FullCallBlock } from "./approval-card-parts";
import type { DecisionMessageCard } from "./decision-card";
import { SlackMrkdwn } from "./slack-mrkdwn";

type ConnectorWriteView = NonNullable<DecisionMessageCard["connector_write"]>;
type ConnectorWriteMessage = NonNullable<ConnectorWriteView["message"]>;
type ConnectorWriteField = NonNullable<ConnectorWriteView["fields"]>[number];

/**
 * The full view of one connected app write that TeamHub holds: what will be
 * sent or changed, and the full call under Details. The app and account it
 * acts as read in the card's summary row.
 */
export function ConnectorWriteDecisionView({
  view,
}: {
  view: ConnectorWriteView;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <>
      {view.message ? <MessagePreview message={view.message} /> : null}
      {view.fields?.length ? <ChangeFields fields={view.fields} /> : null}
      <button
        aria-expanded={detailsOpen}
        className="typed-card-tone inline-flex items-center gap-1 self-start text-xs font-medium [border-radius:var(--app-control-radius)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
        onClick={() => setDetailsOpen((open) => !open)}
        type="button"
      >
        <Icon
          className={`transition-transform duration-[var(--app-floating-duration)] motion-reduce:transition-none ${detailsOpen ? "rotate-180" : ""}`}
          icon={ArrowDown01Icon}
          size={14}
        />
        {detailsOpen ? "Hide details" : "Details"}
      </button>
      {detailsOpen ? (
        <FullCallBlock input={view.input} tool={view.tool} />
      ) : null}
    </>
  );
}

/** The message exactly as it will be sent: headers, body, attachments. */
function MessagePreview({ message }: { message: ConnectorWriteMessage }) {
  const rows: [string, string | undefined][] = [
    ["To", message.to?.join(", ")],
    ["Cc", message.cc?.join(", ")],
    ["Bcc", message.bcc?.join(", ")],
    ["Subject", message.subject],
    ["Where", message.destination],
  ];
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));
  return (
    <section
      aria-label="Message preview"
      className="overflow-hidden rounded-lg border border-app-border bg-app-surface"
    >
      {shown.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-app-border px-3 py-2 text-xs leading-5">
          {shown.map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-app-muted">{label}</dt>
              <dd
                className={`[overflow-wrap:anywhere] text-app-ink ${label === "Subject" ? "font-semibold" : ""}`}
              >
                {value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {message.body.trim() ? (
        <MessageBody body={message.body} format={message.format} />
      ) : (
        <p className="px-3 py-2.5 text-xs text-app-muted">No message text.</p>
      )}
      {message.attachments?.length ? (
        <ul
          aria-label="Attachments"
          className="flex flex-wrap gap-1.5 border-t border-app-border px-3 py-2"
        >
          {message.attachments.map((name, index) => (
            <li
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-app-border bg-app-surface-soft px-2 py-0.5 text-xs text-app-body"
              key={`${index}:${name}`}
            >
              <Icon
                className="shrink-0 text-app-muted"
                icon={Attachment01Icon}
                size={12}
              />
              <span className="truncate">{name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function MessageBody({
  body,
  format,
}: {
  body: string;
  format: ConnectorWriteMessage["format"];
}) {
  if (format === "html") return <HtmlMessageBody html={body} />;
  return (
    <div
      className="max-h-80 overflow-auto px-3 py-2.5"
      data-testid="message-body"
    >
      {format === "markdown" ? (
        <MessageMarkdown authorKind="agent" body={body} readOnlyReferences />
      ) : format === "mrkdwn" ? (
        <SlackMrkdwn text={body} />
      ) : (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-app-ink">
          {body}
        </p>
      )}
    </div>
  );
}

const htmlBodyMinHeight = 48;
const htmlBodyMaxHeight = 320;

/**
 * An HTML email in its own sandboxed document, so its styles stay inside the
 * preview. Nothing in it runs or loads: DOMPurify strips scripts, the
 * sandbox has no allow-scripts, and the policy blocks remote resources. The
 * frame grows with the email up to a cap, then scrolls.
 */
function HtmlMessageBody({ html }: { html: string }) {
  const [height, setHeight] = useState(120);
  const source = useMemo(() => htmlEmailDocument(html), [html]);
  return (
    <iframe
      className="block w-full border-0 bg-white"
      onLoad={(event) => {
        const root = event.currentTarget.contentDocument?.documentElement;
        if (!root) return;
        setHeight(
          Math.min(
            Math.max(root.scrollHeight, htmlBodyMinHeight),
            htmlBodyMaxHeight,
          ),
        );
      }}
      // Same origin only lets the card measure the email; without
      // allow-scripts nothing inside can use it. Links open a new tab.
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      srcDoc={source}
      style={{ height }}
      title="Message body"
    />
  );
}

function htmlEmailDocument(html: string) {
  const root = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    WHOLE_DOCUMENT: true,
  }) as HTMLElement;
  const owner = root.ownerDocument;
  let head = root.querySelector("head");
  if (!head) {
    head = owner.createElement("head");
    root.prepend(head);
  }
  const policy = owner.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
  const charset = owner.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  // The email's own styles come later and win.
  const base = owner.createElement("style");
  base.textContent =
    "html{color-scheme:light}body{margin:0;padding:10px 12px;background:#fff;color:#202020;font:14px/1.5 Inter,system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}";
  head.prepend(charset, policy, base);
  for (const link of root.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return `<!doctype html>${root.outerHTML}`;
}

/** A change's target and key values; multi-line values keep their lines. */
function ChangeFields({ fields }: { fields: ConnectorWriteField[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs leading-5">
      {fields.map((field, index) => (
        <Fragment key={`${index}:${field.label}`}>
          <dt className="text-app-muted">{field.label}</dt>
          <dd className="min-w-0 text-app-ink">
            {field.value.includes("\n") ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-app-surface-soft px-2 py-1.5 font-mono [overflow-wrap:anywhere]">
                {field.value}
              </pre>
            ) : (
              <span className="[overflow-wrap:anywhere]">{field.value}</span>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
