import { describe, expect, it } from "vitest";

import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";

import { computerReadiness } from "./computer-readiness";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

function computer(
  runtimes: LocalComputer["runtimes"],
  overrides: Partial<LocalComputer> = {},
): LocalComputer {
  return {
    active_operations: 0,
    computer_id: "computer-a",
    display_name: "Computer A",
    runtimes,
    status: "online",
    upgrade_required: false,
    workspace_grants: [],
    ...overrides,
  };
}

describe("computerReadiness", () => {
  it("is ready as soon as one AI app is, whatever the others report", () => {
    expect(
      computerReadiness(
        computer([
          { models: [], status: "authentication_required", type: "claude" },
          { models: [], status: "ready", type: "codex" },
          { models: [], status: "not_installed", type: "pi" },
        ]),
        "online",
      ),
    ).toEqual({ app: "codex", kind: "ready" });
  });

  it("asks to sign in before suggesting a new app", () => {
    expect(
      computerReadiness(
        computer([
          { models: [], status: "not_installed", type: "claude" },
          { models: [], status: "authentication_required", type: "pi" },
        ]),
        "online",
      ),
    ).toEqual({ app: "pi", kind: "signIn" });
    expect(computerReadiness(computer([]), "online")).toEqual({
      app: "claude",
      kind: "setUp",
    });
  });

  it("points at an installed app that is outdated or unchecked before suggesting a new one", () => {
    expect(
      computerReadiness(
        computer([
          { models: [], status: "unknown", type: "claude" },
          { models: [], status: "incompatible", type: "codex" },
        ]),
        "online",
      ),
    ).toEqual({ app: "codex", kind: "updateApp" });
    expect(
      computerReadiness(
        computer([
          { models: [], status: "unknown", type: "claude" },
          { models: [], status: "error", type: "pi" },
        ]),
        "online",
      ),
    ).toEqual({ app: "pi", kind: "check" });
    expect(
      computerReadiness(
        computer([{ models: [], status: "unknown", type: "codex" }]),
        "online",
      ),
    ).toEqual({ app: "codex", kind: "check" });
  });

  it("puts a required update ahead of being offline, and reconnecting ahead of both", () => {
    const outdated = computer([], {
      status: "offline",
      upgrade_required: true,
    });
    expect(computerReadiness(outdated, "offline")).toEqual({ kind: "update" });
    expect(computerReadiness(outdated, "reconnecting")).toEqual({
      kind: "reconnecting",
    });
    expect(
      computerReadiness(computer([], { status: "offline" }), "offline"),
    ).toEqual({ kind: "offline" });
  });
});
