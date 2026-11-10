import { SquareLock02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";

import { Icon } from "@/components/ui/icon";

import { DetailBlock, FullCallBlock } from "./approval-card-parts";
import type { DecisionMessageCard } from "./decision-card";

type RuntimePermissionView = NonNullable<
  DecisionMessageCard["runtime_permission"]
>;

/**
 * The full Runtime tool call waiting for approval: the call, and the diff,
 * script, or page element it acts on. The judge's reason reads in the card's
 * prompt and the screen before a GUI action shows on its own.
 */
export function RuntimePermissionDecisionView({
  view,
}: {
  view: RuntimePermissionView;
}) {
  return (
    <>
      <FullCallBlock input={view.input} tool={view.tool} />
      {view.patch ? <DiffBlock patch={view.patch} /> : null}
      {view.script ? <ScriptBlock script={view.script} /> : null}
      {view.page ? <PageBlock page={view.page} /> : null}
    </>
  );
}

/**
 * The screen the host captured before a GUI action, target marked. TeamHub
 * serves it to the decision owner only, so everyone else sees a note.
 */
export function PermissionScreenshot({
  canSee,
  ownerName,
  screenshot,
}: {
  canSee: boolean;
  ownerName: string;
  screenshot: NonNullable<RuntimePermissionView["screenshot"]>;
}) {
  const [failed, setFailed] = useState(false);
  if (!canSee || failed) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Icon className="shrink-0" icon={SquareLock02Icon} size={14} />
        {canSee
          ? "The screenshot is no longer available."
          : `Only ${ownerName} can see the screenshot.`}
      </p>
    );
  }
  return (
    <figure className="m-0 overflow-hidden rounded-lg border border-app-border bg-app-surface">
      <img
        alt="The screen before this action, with its target marked"
        className="block h-auto w-full"
        height={screenshot.height}
        loading="lazy"
        onError={() => setFailed(true)}
        src={screenshot.url}
        width={screenshot.width}
      />
      <figcaption className="border-t border-app-border bg-app-surface-soft px-3 py-1.5 text-xs text-app-muted">
        Before the action · the target is marked
      </figcaption>
    </figure>
  );
}

/** How many lines a patch adds and removes. */
export function diffStats(patch: string) {
  const lines = patch.split("\n");
  return {
    added: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    lines,
    removed: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
  };
}

function DiffBlock({ patch }: { patch: string }) {
  const { added, lines, removed } = diffStats(patch);
  return (
    <DetailBlock label={`Diff · +${added} −${removed}`}>
      <div className="max-h-80 overflow-auto py-1 font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <div
            className={`min-w-max whitespace-pre px-3 ${diffLineClassName(line)}`}
            key={index}
          >
            {line || " "}
          </div>
        ))}
      </div>
    </DetailBlock>
  );
}

function diffLineClassName(line: string) {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("***")
  ) {
    return "text-app-muted";
  }
  if (line.startsWith("@@")) return "bg-app-surface-soft text-app-subtle";
  if (line.startsWith("+"))
    return "bg-[var(--app-status-success-surface)] text-[var(--app-status-success-text)]";
  if (line.startsWith("-"))
    return "bg-[var(--app-status-danger-surface)] text-[var(--app-status-danger-text)]";
  return "text-app-ink";
}

function ScriptBlock({
  script,
}: {
  script: NonNullable<RuntimePermissionView["script"]>;
}) {
  const lines = script.body.split("\n");
  return (
    <DetailBlock
      label={
        <>
          Script · {script.path}
          {script.sha256 ? ` · sha256 ${script.sha256.slice(0, 12)}` : null}
        </>
      }
    >
      <div className="max-h-80 overflow-auto py-1 font-mono text-xs leading-5 text-app-ink">
        {lines.map((line, index) => (
          <div
            className="grid min-w-max grid-cols-[2.25rem_auto] whitespace-pre pr-3"
            key={index}
          >
            <span className="select-none pr-2.5 text-right text-app-subtle">
              {index + 1}
            </span>
            <span>{line || " "}</span>
          </div>
        ))}
      </div>
    </DetailBlock>
  );
}

function PageBlock({
  page,
}: {
  page: NonNullable<RuntimePermissionView["page"]>;
}) {
  const element = [
    page.target_role,
    page.target_name && `"${page.target_name}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <DetailBlock label="Page element">
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-xs leading-5">
        <dt className="text-app-muted">Page</dt>
        <dd className="[overflow-wrap:anywhere] font-mono text-app-ink">
          {page.url}
        </dd>
        {page.title ? (
          <>
            <dt className="text-app-muted">Title</dt>
            <dd className="[overflow-wrap:anywhere] text-app-ink">
              {page.title}
            </dd>
          </>
        ) : null}
        {element ? (
          <>
            <dt className="text-app-muted">Element</dt>
            <dd className="[overflow-wrap:anywhere] font-mono text-app-ink">
              {element}
            </dd>
          </>
        ) : null}
      </dl>
    </DetailBlock>
  );
}
