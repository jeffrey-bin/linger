import { useCallback, useEffect, useState } from "react";

// The part of the desktop shell API (`window.lingerDesktop`, exposed by the
// Electron preload) that the Agent creation flow uses. In a browser it is
// absent and the CLI setup instructions are shown instead.
export interface DesktopComputerStatus {
  readonly bridge: string;
  readonly runtime: string;
  readonly computerId?: string;
  readonly activeOperations: number;
}

interface DesktopComputerApi {
  getStatus(): Promise<DesktopComputerStatus>;
  onStatus(callback: (status: DesktopComputerStatus) => void): () => void;
  enroll(): Promise<{ computerId: string }>;
}

const desktopComputerApi = (): DesktopComputerApi | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { computer?: DesktopComputerApi } })
        .lingerDesktop?.computer;

export interface DesktopComputer {
  readonly status: DesktopComputerStatus | undefined;
  readonly connecting: boolean;
  readonly error: string | undefined;
  connect(): void;
}

// The computer this desktop app runs on, or undefined in a browser.
export function useDesktopComputer(): DesktopComputer | undefined {
  const [api] = useState(desktopComputerApi);
  const [status, setStatus] = useState<DesktopComputerStatus>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .getStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => undefined);
    const off = api.onStatus((next) => setStatus(next));
    return () => {
      active = false;
      off();
    };
  }, [api]);

  const connect = useCallback(() => {
    if (!api) return;
    setConnecting(true);
    setError(undefined);
    api
      .enroll()
      .then(({ computerId }) =>
        setStatus((current) =>
          current ? { ...current, computerId } : current,
        ),
      )
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Could not connect",
        ),
      )
      .finally(() => setConnecting(false));
  }, [api]);

  return api ? { status, connecting, error, connect } : undefined;
}

// A permission step the desktop app takes on its own Mac without TeamHub.
// It runs Linger's own steps and opens any System Settings pane; CuaDriver's
// prompt and restart need the daemon.
export type DesktopPermissionStep =
  | {
      readonly action: "prompt";
      readonly subject: "linger";
      readonly permission: "screen_recording" | "accessibility";
    }
  | {
      readonly action: "open_settings";
      readonly subject: "linger" | "computer_use";
      readonly permission: "screen_recording" | "accessibility";
    }
  | { readonly action: "relaunch"; readonly subject: "linger" };

export interface DesktopPermissions {
  act(step: DesktopPermissionStep): Promise<void>;
}

// The desktop app's permission steps, or undefined in a browser or off macOS.
export function desktopPermissions(): DesktopPermissions | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { permissions?: DesktopPermissions } })
        .lingerDesktop?.permissions;
}
