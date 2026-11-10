import { describe, expect, it } from "vitest";

import {
  resolveTeamHubCommand,
  teamHubServeEnvironment,
} from "./realtime-e2e-environment.js";

describe("Room Document TeamHub process commands", () => {
  it.each([
    ["./cmd/migrate", "ROOM_DOCUMENT_E2E_MIGRATE_BINARY", "/tmp/migrate"],
    ["./cmd/demo-seed", "ROOM_DOCUMENT_E2E_DEMO_SEED_BINARY", "/tmp/demo-seed"],
    ["./cmd/teamhub", "ROOM_DOCUMENT_E2E_TEAMHUB_BINARY", "/tmp/teamhub"],
  ])("uses the prepared binary for %s", (mainPackage, variable, binary) => {
    expect(resolveTeamHubCommand(mainPackage, { [variable]: binary })).toEqual({
      command: binary,
      args: [],
    });
  });

  it("falls back to go run for local development", () => {
    expect(resolveTeamHubCommand("./cmd/teamhub", {})).toEqual({
      command: "go",
      args: ["run", "./cmd/teamhub"],
    });
  });

  it("skips built-in Skill installation except for the production startup proof", () => {
    expect(teamHubServeEnvironment({ A: "1" })).toEqual({
      A: "1",
      TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION: "1",
    });
    expect(
      teamHubServeEnvironment({ VERIFY_ROOM_STARTUP_PRODUCTION: "1" }),
    ).toEqual({ VERIFY_ROOM_STARTUP_PRODUCTION: "1" });
  });
});
