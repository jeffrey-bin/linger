import type { components } from "@linger/wire-contracts/linger-installer/types";

export type EnvironmentReport = components["schemas"]["EnvironmentReport"];
export type InstallerConfig = components["schemas"]["InstallerConfig"];
export type InstallationInput = components["schemas"]["InstallationInput"];
export type InstallationJob = components["schemas"]["InstallationJob"];
export type InstallationEvent = components["schemas"]["InstallationEvent"];
export type LoginInformation = components["schemas"]["LoginInformation"];
export type InstanceStatus = components["schemas"]["InstanceStatus"];

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      error?.message ?? `Request failed (${response.status}). Please retry.`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** What the desktop client asks to install right away. */
export interface StartPlan {
  setupChoice?: string;
}

/**
 * Only the fragment carries the one-use bootstrap secret. Never persist it.
 * The desktop client adds `start=1` and its plan (`choice`) there.
 */
export async function authenticate(): Promise<StartPlan | undefined> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (location.hash)
    history.replaceState(null, "", location.pathname + location.search);
  const token = fragment.get("token");
  if (token) await request("/session", { token });
  if (fragment.get("start") !== "1") return;
  const setupChoice = fragment.get("choice");
  return setupChoice ? { setupChoice } : {};
}

export function parseEventFrame(frame: string): InstallationEvent | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;
  try {
    return JSON.parse(data) as InstallationEvent;
  } catch {
    return;
  }
}

/** A disconnected browser never sends cancel. Reconnect from the last observed sequence. */
export async function watchJob(
  id: string,
  initialSequence: number,
  signal: AbortSignal,
  onEvent: (event: InstallationEvent) => void,
  onConnection: (connected: boolean) => void,
  onHeartbeat: () => void,
): Promise<void> {
  let sequence = initialSequence;
  while (!signal.aborted) {
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(id)}/events`,
        {
          credentials: "same-origin",
          cache: "no-store",
          signal,
          headers: {
            Accept: "text/event-stream",
            "Last-Event-ID": String(sequence),
          },
        },
      );
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      onConnection(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        onHeartbeat();
        pending = (pending + decoder.decode(value, { stream: true })).replace(
          /\r\n/g,
          "\n",
        );
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const event = parseEventFrame(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
          if (
            event &&
            (event.kind === "snapshot" || event.sequence > sequence)
          ) {
            sequence = Math.max(sequence, event.sequence);
            onEvent(event);
          }
        }
      }
    } catch {
      /* Stream loss is recoverable; the task continues on the host. */
    }
    if (signal.aborted) return;
    onConnection(false);
    await new Promise<void>((resolve) => {
      const abort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 1500);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
