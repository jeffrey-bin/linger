import {
  Cancel01Icon,
  Clock01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import {
  actOnComputerPermission,
  type ComputerPermissionAction,
  computerPermissionsQueryKey,
  computerPermissionsQueryOptions,
  type ComputerPermissionStatus,
} from "@/features/local-computer/computer-permissions-api";
import {
  desktopPermissions,
  type DesktopPermissionStep,
  useDesktopComputer,
} from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { CardActions, CardError } from "./approval-card-parts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

type Subject = ComputerPermissionAction["subject"];
type PermissionId = NonNullable<ComputerPermissionAction["permission"]>;
type Entry =
  ComputerPermissionStatus["subjects"][number]["permissions"][number];
type CardState = "waiting" | "relaunch" | "granted" | "declined" | "expired";
type FinishedState = Extract<CardState, "granted" | "declined" | "expired">;

const label = "System permission requested";
const subjectLabels: Record<Subject, string> = {
  linger: "Linger",
  computer_use: "Computer use (CuaDriver)",
};
const permissionLabels: Record<PermissionId, string> = {
  accessibility: "Accessibility",
  screen_recording: "Screen Recording",
};
const stateLabels: Record<Entry["state"], string> = {
  denied: "Not allowed",
  granted: "Granted",
  not_determined: "Not requested yet",
  unknown: "Unknown",
};
const finishedCopy: Record<
  FinishedState,
  { icon: IconSvgElement; text: string; tone: ReceiptTone }
> = {
  declined: { icon: Cancel01Icon, text: "Declined", tone: "muted" },
  expired: { icon: Clock01Icon, text: "Expired", tone: "muted" },
  granted: { icon: Tick02Icon, text: "Granted", tone: "success" },
};

function cardState(
  card: DecisionMessageCard,
  entries: readonly Entry[],
  now: number,
): CardState {
  if (card.status === "answered") return "granted";
  if (card.status === "denied") return "declined";
  if (
    card.status === "expired" ||
    (card.expires_at !== undefined && Date.parse(card.expires_at) <= now)
  )
    return "expired";
  return entries.some((entry) => entry.relaunch_required)
    ? "relaunch"
    : "waiting";
}

/** The one step that moves a permission forward, or none once granted. */
function nextAction(
  subject: Subject,
  entry: Entry,
): { action: ComputerPermissionAction; label: string } | undefined {
  if (entry.state === "granted") return undefined;
  if (entry.relaunch_required && subject === "linger")
    return {
      action: { action: "relaunch", subject },
      label: "Relaunch Linger",
    };
  if (entry.prompt === "available" && entry.state === "not_determined")
    return {
      action: { action: "prompt", subject, permission: entry.id },
      label: "Request",
    };
  return {
    action: { action: "open_settings", subject, permission: entry.id },
    label: "Open Settings",
  };
}

/** The step as the desktop app can take it on its own Mac, if it can. */
function desktopStep(
  action: ComputerPermissionAction,
): DesktopPermissionStep | undefined {
  const { permission } = action;
  if (action.action === "relaunch")
    return action.subject === "linger"
      ? { action: "relaunch", subject: "linger" }
      : undefined;
  if (!permission) return undefined;
  if (action.action === "open_settings")
    return { action: "open_settings", subject: action.subject, permission };
  return action.subject === "linger"
    ? { action: "prompt", subject: "linger", permission }
    : undefined;
}

/**
 * Asks the owner of an Agent's Local Computer to grant macOS privacy
 * permissions. The steps run on that Mac wherever the owner clicks: the
 * desktop app running the Computer takes its own steps over IPC, and every
 * other page sends them through TeamHub to the Computer's daemon. Nothing
 * here answers the card: TeamHub answers it once a permission read sees
 * everything granted, which wakes the Agent.
 */
export function ComputerPermissionDecision({
  card,
  currentActorId,
  messageId,
  onDecision,
  tenantId,
}: {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
  tenantId: string;
}) {
  const view = card.computer_permission;
  const computerId = view?.computer_id ?? "";
  const subject: Subject = view?.subject ?? "linger";
  const requested = view?.permissions ?? [];
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const desktop = useDesktopComputer();
  const [now] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = currentActorId === card.decision_owner.id;
  const pending = card.status === "pending";
  const local =
    Boolean(computerId) && desktop?.status?.computerId === computerId;
  const interactive = owner && pending && Boolean(computerId);

  // Each read also lets TeamHub settle the card, so it polls on every page.
  const status = useQuery({
    ...computerPermissionsQueryOptions(client, tenantId, computerId, true),
    enabled: interactive,
  });
  const inventory = useQuery({
    ...localComputersQueryOptions(client, tenantId),
    enabled: interactive && !local,
  });
  const computerName =
    inventory.data?.items.find((item) => item.computer_id === computerId)
      ?.display_name ?? "that Mac";
  const act = useMutation({
    mutationFn: async (action: ComputerPermissionAction) => {
      const ipc = local ? desktopPermissions() : undefined;
      const step = ipc ? desktopStep(action) : undefined;
      if (!ipc || !step)
        return actOnComputerPermission(client, tenantId, computerId, action);
      await ipc.act(step);
      return undefined;
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "The step did not run.",
      ),
    onMutate: () => setError(""),
    onSuccess: (next) => {
      const key = computerPermissionsQueryKey(tenantId, computerId);
      if (next) queryClient.setQueryData(key, next);
      else void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const offline =
    status.error instanceof TeamHubError &&
    status.error.code === "LOCAL_COMPUTER_OFFLINE";
  const statusError =
    status.error && !offline
      ? status.error instanceof Error
        ? status.error.message
        : "The Mac's permissions could not be read."
      : "";

  const liveEntries = interactive
    ? (status.data?.subjects.find((item) => item.subject === subject)
        ?.permissions ?? [])
    : [];
  const rows = requested.map((id) => ({
    id,
    entry: liveEntries.find((entry) => entry.id === id),
  }));
  const state = cardState(
    card,
    rows.flatMap(({ entry }) => (entry ? [entry] : [])),
    now,
  );
  async function decline() {
    setBusy(true);
    setError("");
    try {
      await onDecision({
        decision: "deny",
        expectedVersion: card.version,
        messageId,
        requestId: card.decision_id,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The card could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  const finished =
    state === "granted" || state === "declined" || state === "expired"
      ? finishedCopy[state]
      : null;

  return (
    <>
      <CardBox heading={card.title} label={label}>
        <ul className="flex flex-col">
          {rows.map(({ id, entry }) => {
            const step =
              entry && interactive ? nextAction(subject, entry) : undefined;
            const granted = state === "granted" || entry?.state === "granted";
            return (
              <li
                className="flex min-w-0 items-center gap-2.5 rounded-lg p-2"
                key={id}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-app-ink">
                    {subjectLabels[subject]} · {permissionLabels[id]}
                  </p>
                  {entry && !granted ? (
                    <p className="truncate text-xs text-app-muted">
                      {entry.relaunch_required
                        ? "Relaunch Linger to apply"
                        : stateLabels[entry.state]}
                    </p>
                  ) : null}
                </div>
                {granted ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-app-success">
                    <Icon icon={Tick02Icon} size={14} />
                    Granted
                  </span>
                ) : step ? (
                  <Button
                    disabled={busy || act.isPending}
                    onClick={() => act.mutate(step.action)}
                    size="large"
                    tone="subtle"
                  >
                    {step.label}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {finished ? (
          <CardDone
            icon={finished.icon}
            text={finished.text}
            tone={finished.tone}
          />
        ) : (
          <>
            {interactive && offline ? (
              <p className="pb-1 text-xs text-app-muted">
                Open Linger on that Mac to grant these permissions.
              </p>
            ) : null}
            {interactive && status.data && !local ? (
              <p className="pb-1 [overflow-wrap:anywhere] text-xs text-app-muted">
                Opens on {computerName}
              </p>
            ) : null}
            {owner && pending ? (
              <CardActions>
                <Button
                  disabled={busy}
                  onClick={() => void decline()}
                  size="large"
                  tone="subtle"
                >
                  Don't allow
                </Button>
              </CardActions>
            ) : null}
          </>
        )}
        {error || statusError ? (
          <CardError>{error || statusError}</CardError>
        ) : null}
      </CardBox>
    </>
  );
}
