import { useLayoutEffect, useRef, useState } from "react";

import {
  SettingsGroup,
  SettingsGroupAction,
} from "@/components/ui/settings-group";

import {
  presentAgentInstructions,
  UNSET_AGENT_INSTRUCTIONS,
} from "./agent-instruction-text";

const COLLAPSED_LINES = "line-clamp-4";

export function AgentInstructions({
  instructions,
  onEdit,
}: {
  instructions: string;
  onEdit?: () => void;
}) {
  const presented = presentAgentInstructions(instructions);
  const text = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = text.current;
    if (!node || expanded) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, presented]);
  return (
    <SettingsGroup
      action={
        onEdit ? (
          <SettingsGroupAction aria-label="Edit instructions" onClick={onEdit}>
            Edit
          </SettingsGroupAction>
        ) : null
      }
      ariaLabel="Agent instructions"
      label="Instructions"
    >
      <div className="border-t border-border px-3.5 py-3">
        {presented ? (
          <p
            aria-label="Instructions content"
            className={`whitespace-pre-wrap break-words text-[14px] leading-5 text-app-body [overflow-wrap:anywhere] ${
              expanded ? "" : COLLAPSED_LINES
            }`}
            ref={text}
          >
            {presented}
          </p>
        ) : (
          <p className="text-[14px] leading-5 text-muted-foreground">
            {UNSET_AGENT_INSTRUCTIONS}
          </p>
        )}
        {clipped || expanded ? (
          <button
            aria-expanded={expanded}
            className="-mx-1 mt-1.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
