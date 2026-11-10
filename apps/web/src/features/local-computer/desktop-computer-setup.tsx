import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import type {
  DesktopComputer,
  DesktopComputerStatus,
} from "./desktop-computer";

// The desktop app connects its own computer and finds Codex and Claude Code
// by itself, so it never asks the user to run setup commands.
export function DesktopComputerSetup({
  desktop,
}: {
  desktop: DesktopComputer;
}) {
  if (!desktop.status) return null;
  if (!desktop.status.computerId) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-app-muted">
          Connect this computer to run Agents with the Codex or Claude Code
          installed on it.
        </p>
        <Button
          tone="primary"
          disabled={desktop.connecting}
          onClick={desktop.connect}
        >
          {desktop.connecting ? "Connecting…" : "Connect this computer"}
        </Button>
        {desktop.error ? (
          <p role="alert" className="text-xs text-app-danger">
            {desktop.error}
          </p>
        ) : null}
      </div>
    );
  }
  // The search only ends once the computer comes online, so a state it cannot
  // leave by itself is shown instead of a spinner that never stops.
  const problem = desktopSetupProblem(desktop.status);
  if (problem) {
    return (
      <p role="alert" className="text-xs text-app-danger">
        {problem}
      </p>
    );
  }
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-app-muted"
      role="status"
    >
      <Spinner size={13} />
      Looking for Codex and Claude Code on this computer…
    </p>
  );
}

// Same states as the desktop tray summary (apps/desktop/src/main/status.ts).
function desktopSetupProblem(status: DesktopComputerStatus) {
  switch (status.bridge) {
    case "auth_failed":
      return "This computer's sign-in expired. Choose Reconnect This Computer in the Linger menu bar menu.";
    case "upgrade_required":
      return "Update the Linger app to connect this computer.";
    case "disconnected":
      return "The Linger background service is not running. Quit and reopen the app.";
  }
  if (status.runtime === "crashed")
    return "Codex and Claude Code could not be checked because the local runtime stopped. Linger is restarting it.";
  return undefined;
}
