import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Fragment } from "react";

import { Icon } from "@/components/ui/icon";

export interface AgentFieldChange {
  field: "name" | "description" | "prompt";
  before?: string;
  after: string;
}

const fieldLabel: Record<AgentFieldChange["field"], string> = {
  description: "Description",
  name: "Name",
  prompt: "Instructions",
};

/** The name and description: the current value, then the new one. Shared by
 * the Agent change card and the Room notice of an identity change. */
export function AgentChangeFields({
  changes,
}: {
  changes: readonly AgentFieldChange[];
}) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs leading-5">
      {changes.map((change) => (
        <Fragment key={change.field}>
          <dt className="text-app-muted">{fieldLabel[change.field]}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-app-ink">
            {change.before === undefined ? null : (
              <>
                <del className="whitespace-pre-wrap [overflow-wrap:anywhere] text-app-muted">
                  {change.before || "None"}
                </del>
                <Icon
                  className="shrink-0 text-app-muted"
                  icon={ArrowRight01Icon}
                  size={12}
                />
              </>
            )}
            <ins className="whitespace-pre-wrap no-underline [overflow-wrap:anywhere]">
              {change.after}
            </ins>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
