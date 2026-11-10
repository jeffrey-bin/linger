import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";

import { Icon } from "@/components/ui/icon";

import { AgentChangeFields } from "./agent-change-fields";
import type { DecisionMessageCard } from "./decision-card";

type AgentChangeView = NonNullable<DecisionMessageCard["agent_change"]>;
type AgentChange = AgentChangeView["changes"][number];

/**
 * The view of an Agent that asked to create an Agent or to change an Agent's
 * name, description, or instructions: each field's current and
 * new value.
 */
export function AgentChangeDecisionView({ view }: { view: AgentChangeView }) {
  const fields = view.changes.filter((change) => change.field !== "prompt");
  const prompt = view.changes.find((change) => change.field === "prompt");
  return (
    <>
      {fields.length ? <AgentChangeFields changes={fields} /> : null}
      {prompt ? <InstructionsChange change={prompt} /> : null}
    </>
  );
}

/**
 * Instructions can run to 50,000 characters, so the card shows their opening
 * lines. Expanding shows the whole text and, for a change, the current text it
 * replaces.
 */
function InstructionsChange({ change }: { change: AgentChange }) {
  const [open, setOpen] = useState(false);
  const replacing = change.before !== undefined;
  const expandable =
    replacing ||
    change.after.length > 240 ||
    change.after.split("\n").length > 4;
  return (
    <>
      <InstructionsText
        label={replacing ? "New instructions" : "Instructions"}
        open={open}
        text={change.after}
      />
      {open && replacing ? (
        <InstructionsText
          label="Current instructions"
          open
          text={change.before ?? ""}
        />
      ) : null}
      {expandable ? (
        <button
          aria-expanded={open}
          className="typed-card-tone inline-flex items-center gap-1 self-start text-xs font-medium [border-radius:var(--app-control-radius)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <Icon
            className={`transition-transform duration-[var(--app-floating-duration)] motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            icon={ArrowDown01Icon}
            size={14}
          />
          {open ? "Show less" : "Show full instructions"}
        </button>
      ) : null}
    </>
  );
}

function InstructionsText({
  label,
  open,
  text,
}: {
  label: string;
  open: boolean;
  text: string;
}) {
  return (
    <section
      aria-label={label}
      className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs leading-5"
    >
      <h4 className="text-app-muted">{label}</h4>
      <p
        className={`whitespace-pre-wrap [overflow-wrap:anywhere] text-app-ink ${open ? "max-h-64 overflow-auto" : "line-clamp-4"}`}
      >
        {text || "None"}
      </p>
    </section>
  );
}
