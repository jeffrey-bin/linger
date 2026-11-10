import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  defaultMoveTarget,
  describeMissingDefault,
  describeMoveTarget,
  type LocalComputer,
  moveTargetComputers,
  moveTargetOptions,
  moveTargetValue,
} from "@/features/rooms/members/agent-move-target";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";

import {
  DELETE_AGENT_CHOICE,
  RemoveComputerAgentRow,
} from "./remove-computer-agent-row";
import {
  type AgentMovePlan,
  useMoveAgentsThenRemove,
} from "./use-move-agents-then-remove";

export const NO_OTHER_COMPUTER_NOTICE =
  "No other computer can take these Agents. Connect your new computer first.";

function moveLabel(count: number) {
  return `Move ${count} Agent${count === 1 ? "" : "s"} and remove`;
}

export function RemoveComputerDialog({
  agents,
  computer,
  computers,
  error,
  onClose,
  onConfirm,
  onConnect,
  pending,
  tenantId,
}: {
  /** Agents currently assigned to the Computer; refreshed as they move. */
  agents: TeamHubTenantAgent[];
  computer: LocalComputer;
  computers: readonly LocalComputer[];
  error?: Error | null;
  onClose: () => void;
  onConfirm: () => void;
  onConnect: () => void;
  pending: boolean;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  // Rows keep the Agents assigned when the dialog opened, so finished ones
  // stay listed with their outcome while the refreshed list shrinks.
  const [rows] = useState(() => agents);
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      agents.map((agent) => {
        const target = defaultMoveTarget(agent, computers);
        return [agent.actor.id, target ? moveTargetValue(target) : ""];
      }),
    ),
  );
  const move = useMoveAgentsThenRemove({ client, tenantId });
  const busy = move.running || pending;
  const plans = rows.map((row) => {
    const agent = agents.find((item) => item.actor.id === row.actor.id) ?? row;
    const choice = choices[row.actor.id] ?? "";
    const options = moveTargetOptions(row, computers);
    const option = options.find((item) => item.value === choice);
    const plan: AgentMovePlan | undefined =
      choice === DELETE_AGENT_CHOICE && agent.agent_type !== "anotherme"
        ? { action: "delete", agent }
        : option
          ? { action: "move", agent, target: option.target }
          : undefined;
    const candidates = moveTargetComputers(row, computers);
    const hint = option
      ? describeMoveTarget(
          row,
          option.target,
          computers.find(
            (item) => item.computer_id === option.target.computerId,
          ),
        )
      : plan?.action === "delete"
        ? "Removes this Agent from every Room and deletes your direct chat with it."
        : candidates.length === 0
          ? agent.agent_type === "anotherme"
            ? "Another Me can't be deleted. Connect another computer to move it."
            : "Connect another computer to move this Agent, or delete it."
          : describeMissingDefault(row, candidates);
    return { candidates, hint, options, plan, row };
  });
  const remaining = plans.filter(({ row }) => !move.isFinished(row.actor.id));
  const ready = remaining.every(({ plan }) => plan);
  const noTargetComputer =
    remaining.length > 0 &&
    remaining.every(({ candidates }) => candidates.length === 0);
  const moves = remaining.filter(({ plan }) => plan?.action === "move").length;
  const deletes = remaining.filter(
    ({ plan }) => plan?.action === "delete",
  ).length;
  const label = move.failed
    ? "Retry"
    : remaining.length === 0
      ? "Remove"
      : !ready
        ? moveLabel(remaining.length)
        : moves && deletes
          ? "Move, delete and remove"
          : deletes
            ? "Delete and remove"
            : moveLabel(moves);

  async function confirm() {
    if (!ready || busy) return;
    const complete = await move.run(
      plans.flatMap(({ plan }) => (plan ? [plan] : [])),
    );
    if (complete) onConfirm();
  }

  return (
    <ModalDialog
      description={
        <>
          This revokes <strong>{computer.display_name}</strong> and removes it
          from this workspace. Reconnecting requires a new setup.
        </>
      }
      onClose={() => {
        if (!move.running) onClose();
      }}
      size="md"
      title="Remove Local Computer"
      footer={
        <>
          <Button disabled={move.running} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            loading={busy}
            onClick={() => void confirm()}
            tone="danger"
          >
            {label}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        {noTargetComputer ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] px-3 py-2.5 text-sm text-app-warning"
            role="status"
          >
            <p>{NO_OTHER_COMPUTER_NOTICE}</p>
            <Button onClick={onConnect} size="compact">
              Connect a computer
            </Button>
          </div>
        ) : null}
        {rows.length ? (
          <section aria-label="Assigned Agents">
            <h3 className="text-xs font-medium text-muted-foreground">
              Assigned Agents move first
            </h3>
            <ul className="mt-1 divide-y divide-border">
              {plans.map(({ hint, options, row }) => (
                <RemoveComputerAgentRow
                  agent={row}
                  disabled={busy || move.isFinished(row.actor.id)}
                  hint={hint}
                  key={row.actor.id}
                  onChange={(value) =>
                    setChoices((current) => ({
                      ...current,
                      [row.actor.id]: value,
                    }))
                  }
                  options={options}
                  progress={move.progress.get(row.actor.id)}
                  value={choices[row.actor.id] ?? ""}
                />
              ))}
            </ul>
          </section>
        ) : null}
        {error ? (
          <p className="text-sm text-app-danger" role="alert">
            {error.message}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}
