import { afterEach, expect, it, vi } from "vitest";

import {
  ROOM_DIAGNOSTICS_STORAGE_KEY,
  roomDiagnostic,
  setRoomDiagnosticsEnabledForTest,
} from "./room-diagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setRoomDiagnosticsEnabledForTest(true);
});

it("stays silent unless the browser opts in", () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
  });
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  setRoomDiagnosticsEnabledForTest(undefined);
  roomDiagnostic("room.example", { roomId: "room-1" });
  expect(debug).not.toHaveBeenCalled();

  stored.set(ROOM_DIAGNOSTICS_STORAGE_KEY, "1");
  setRoomDiagnosticsEnabledForTest(undefined);
  roomDiagnostic("room.example", { roomId: "room-1" });
  expect(debug).toHaveBeenCalledWith("room.example", { roomId: "room-1" });
});

it("stays silent when storage is blocked", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
  });
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  setRoomDiagnosticsEnabledForTest(undefined);
  roomDiagnostic("room.example", {});
  expect(debug).not.toHaveBeenCalled();
});
