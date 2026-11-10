import { useQuery } from "@tanstack/react-query";
import { ChromeIcon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { ComputerRow, ProgressChip, RowMark, StatusDot } from "../computer-row";
import { browserConnectionQueryOptions } from "./browser-connection-api";
import {
  browserConnectionErrorMessage,
  browserConnectionStateCopy,
} from "./browser-connection-copy";
import type { TeamHubBrowserConnectionStatus } from "@/features/teamhub/teamhub-types";

const BrowserConnectionDialog = lazy(() =>
  import("./browser-connection-dialog").then((module) => ({
    default: module.BrowserConnectionDialog,
  })),
);

/** One Local Computer's browser, as a summary chip or an Access row. */
export function ComputerBrowserConnection({
  computerId,
  online,
  tenantId,
  variant,
}: {
  computerId: string;
  online: boolean;
  tenantId: string;
  variant: "chip" | "row";
}) {
  const { client } = useTeamHubRuntime();
  const [open, setOpen] = useState(false);
  const status = useQuery({
    ...browserConnectionQueryOptions(client, tenantId, computerId),
    enabled: online,
  });
  const state = status.data?.state;
  // A Personal Cloud Computer has no everyday Chrome to connect, so the chip
  // waits for the status rather than appearing and then vanishing.
  if (state === "unsupported") return null;
  if (variant === "chip" && online && status.isPending) return null;
  const connected = state === "connected";
  const copy = status.data
    ? browserConnectionStateCopy(status.data.state)
    : null;
  const explanation = !online
    ? "Unavailable while this computer is offline."
    : status.data
      ? browserExplanation(status.data.state)
      : status.isError
        ? browserConnectionErrorMessage(status.error)
        : "Checking browser status…";
  const dialog = open ? (
    <Suspense fallback={null}>
      <BrowserConnectionDialog
        computerId={computerId}
        onClose={() => setOpen(false)}
        tenantId={tenantId}
      />
    </Suspense>
  ) : null;

  if (variant === "chip")
    return (
      <>
        <ProgressChip
          hint={
            connected
              ? "Agents can use your Chrome"
              : "Optional · let Agents use your Chrome"
          }
          icon={ChromeIcon}
          label={connected ? "Chrome" : "Connect Chrome"}
          onClick={connected || !online ? undefined : () => setOpen(true)}
          state={connected ? "done" : "optional"}
        />
        {dialog}
      </>
    );

  return (
    <>
      <ComputerRow
        action={
          online ? (
            <Button
              onClick={() => setOpen(true)}
              size="compact"
              tone={connected ? "ghost" : "secondary"}
            >
              {connected ? "Manage" : "Connect"}
            </Button>
          ) : null
        }
        dimmed={!online}
        mark={
          <RowMark>
            <Icon icon={ChromeIcon} size={20} />
          </RowMark>
        }
        subtitle={explanation}
        title={
          <span className="flex items-center gap-2">
            Chrome
            {online && copy ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {/* Not connecting is a valid choice, so it never reads as a problem. */}
                <StatusDot
                  tone={
                    status.data?.state === "not_connected"
                      ? "neutral"
                      : copy.tone
                  }
                />
                {copy.short}
              </span>
            ) : null}
          </span>
        }
      />
      {dialog}
    </>
  );
}

/**
 * The second line of the Chrome row. Browser tools work without a connection;
 * connecting only decides whose Chrome, and so whose sign-ins, they use.
 */
function browserExplanation(state: TeamHubBrowserConnectionStatus["state"]) {
  switch (state) {
    case "connected":
      return "Agents use your sign-ins.";
    case "isolated":
      return "Agents browse without your sign-ins.";
    case "not_connected":
      return "Agents ask before browsing.";
    default:
      return browserConnectionStateCopy(state).label;
  }
}
