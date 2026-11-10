import { describe, expect, it } from "vitest";

import { connectorWriteApproval } from "./connector-approval.js";
import { commandManifest } from "./command-manifest.js";
import { commandDefinitions } from "./domain-commands.js";

describe("command manifest", () => {
  const manifest = commandManifest();
  const find = (...command: string[]) =>
    manifest.commands.find(
      (entry) => entry.command.join(" ") === command.join(" "),
    );

  it("lists every command once", () => {
    const keys = manifest.commands.map((entry) => entry.command.join(" "));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(90);
  });

  it("classifies TeamHub, connector, and generic app commands", () => {
    expect(find("message", "send")?.approval).toBe("allow");
    // A question card waits for no one, so hosts never review it.
    expect(find("message", "ask-user")?.approval).toBe("allow");
    expect(find("gmail", "list")?.approval).toBe("allow");
    expect(find("gmail", "send")?.approval).toBe("confirm");
    expect(find("gmail", "draft")?.approval).toBe("allow");
    expect(find("gcal", "create")?.approval).toBe("judge");
    expect(find("slack", "react")?.approval).toBe("judge");
    expect(find("apps", "execute")?.approval).toBe("judge");
    expect(find("apps", "search")?.approval).toBe("allow");
    // Agent changes open their own sponsor card when TeamHub requires one.
    expect(find("agent", "list")?.approval).toBe("allow");
    expect(find("agent", "get")?.approval).toBe("allow");
    expect(find("agent", "create")?.approval).toBe("confirm");
    expect(find("agent", "update")?.approval).toBe("confirm");
  });

  it("classifies every connector write explicitly", () => {
    const writes = commandDefinitions
      .filter(
        (definition) =>
          definition.toolName.startsWith("connector_") && !definition.readOnly,
      )
      .map((definition) => definition.command.join(" "))
      .sort();
    expect(writes).toEqual(Object.keys(connectorWriteApproval).sort());
    expect(
      Object.values(connectorWriteApproval).filter(
        (value) => value === "confirm",
      ),
    ).toHaveLength(10);
  });

  // Hosts match command prefixes, so an allowed command must never cover a
  // judged command.
  const covers = (prefix: readonly string[], command: readonly string[]) =>
    prefix.every((part, index) => command[index] === part);

  it("never lets an allowed prefix cover a judged command", () => {
    for (const allowed of manifest.commands.filter(
      (entry) => entry.approval !== "judge",
    ))
      for (const judged of manifest.commands.filter(
        (entry) => entry.approval === "judge",
      ))
        expect(
          covers(allowed.command, judged.command),
          `${allowed.command.join(" ")} is a prefix of ${judged.command.join(" ")}`,
        ).toBe(false);
  });
});
