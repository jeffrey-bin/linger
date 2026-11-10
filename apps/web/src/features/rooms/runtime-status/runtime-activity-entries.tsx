import type {
  RuntimeActivityContentBlock,
  RuntimeActivityEntry,
} from "./runtime-presentation-events";

export function RuntimeActivityEntries({
  entries,
  title,
}: {
  entries: readonly RuntimeActivityEntry[];
  title: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div aria-label={`${title} details`} className="mt-1.5 space-y-1.5">
      {entries.map((entry, index) =>
        entry.type === "content" ? (
          <RuntimeActivityContentBlockView
            block={entry.block}
            key={JSON.stringify([
              entry.type,
              entry.block.format,
              entry.block.label,
              index,
            ])}
          />
        ) : (
          <div
            className="flex min-w-0 items-start gap-1.5 text-[12px] leading-4 text-app-muted"
            key={JSON.stringify([entry.type, entry.detail, index])}
          >
            <span
              aria-hidden="true"
              className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-app-border-strong"
            />
            <span className="min-w-0 break-words">{entry.detail}</span>
          </div>
        ),
      )}
    </div>
  );
}

function RuntimeActivityContentBlockView({
  block,
}: {
  block: RuntimeActivityContentBlock;
}) {
  return (
    <div>
      {block.label ? (
        <p className="mb-0.5 text-[10px] font-medium uppercase text-app-subtle">
          {block.label}
        </p>
      ) : null}
      {block.format === "text" ? (
        <p className="whitespace-pre-wrap break-words text-[12px] leading-4 text-app-muted">
          {block.content}
        </p>
      ) : (
        <pre className="workspace-scrollbar max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-app-border bg-app-surface-soft px-2 py-1.5 text-[12px] leading-4 text-app-body">
          <code>{block.content}</code>
        </pre>
      )}
    </div>
  );
}
