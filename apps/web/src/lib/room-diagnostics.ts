/**
 * Room timing diagnostics (`room.*` console.debug events) cost serialization,
 * timers and animation frames on every render, so they run only when asked:
 * `localStorage.setItem("linger.roomDiagnostics", "1")`, then reload.
 */
export const ROOM_DIAGNOSTICS_STORAGE_KEY = "linger.roomDiagnostics";

let enabled: boolean | undefined;

export function roomDiagnosticsEnabled(): boolean {
  if (enabled === undefined) {
    try {
      enabled =
        globalThis.localStorage?.getItem(ROOM_DIAGNOSTICS_STORAGE_KEY) === "1";
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

/** Logs one Room diagnostic event when diagnostics are on. */
export function roomDiagnostic(event: string, fields: Record<string, unknown>) {
  if (roomDiagnosticsEnabled()) console.debug(event, fields);
}

export function setRoomDiagnosticsEnabledForTest(value: boolean | undefined) {
  enabled = value;
}
