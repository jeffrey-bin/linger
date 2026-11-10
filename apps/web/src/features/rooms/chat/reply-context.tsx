import { markdownPlainText } from "@/features/teamhub/markdown-plain-text";

export interface ReplyContextMessage {
  author: { display_name: string; id: string };
  key: string;
  rawMessage: string;
}

/**
 * The Messages a reply answers, shown as faded bubbles above it with the
 * quoted text only, aligned with the reply's own bubble.
 */
export function ReplyContext({
  label,
  messages,
  own,
}: {
  label: string;
  messages: readonly ReplyContextMessage[];
  own: boolean;
}) {
  return (
    <div
      aria-label={label}
      className={`mt-1 mb-1 flex flex-col gap-1 ${own ? "items-end" : "items-start"}`}
    >
      {messages.map((message) => (
        <p className="reply-context-bubble truncate" key={message.key}>
          {markdownPlainText(message.rawMessage)}
        </p>
      ))}
    </div>
  );
}
