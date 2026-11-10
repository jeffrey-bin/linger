import { describe, expect, it } from "vitest";

import {
  goVariableNames,
  parseExampleNames,
  runEnvInventoryCheck,
  typeScriptVariableNames,
  validateInventory,
  type EnvInventory,
} from "./check-env-inventory.js";

const readers = (entries: Record<string, string[]>) =>
  new Map(
    Object.entries(entries).map(([name, files]) => [name, new Set(files)]),
  );

const inventory = (overrides: Partial<EnvInventory> = {}): EnvInventory => ({
  indirect: {},
  unlisted: {},
  ...overrides,
});

describe("env inventory", () => {
  it("parses active and commented-out .env.example assignments", () => {
    expect(
      parseExampleNames(
        "# comment\nTEAMHUB_BASE_URL=http://localhost:8080\n# OPTIONAL_KEY=\n  NOT_A_VAR=1\n",
      ),
    ).toEqual(new Set(["TEAMHUB_BASE_URL", "OPTIONAL_KEY"]));
  });

  it("sees variables read directly and through named lookup helpers", () => {
    expect(
      typeScriptVariableNames(
        [
          "const a = process.env.DIRECT_READ;",
          'const b = env["INDEXED_READ"];',
          'const c = requiredEnvironment(env, "HELPER_READ");',
          'const d = required("SONIOX_API_KEY");',
          'const e = required("lowercase");',
          'const f = readListenAddress(\n  env,\n  "LISTEN_READ",\n  fallback,\n);',
        ].join("\n"),
      ).sort(),
    ).toEqual([
      "DIRECT_READ",
      "HELPER_READ",
      "INDEXED_READ",
      "LISTEN_READ",
      "SONIOX_API_KEY",
    ]);
  });

  it("sees variables kept as data and read later", () => {
    expect(
      typeScriptVariableNames(
        '{ runtime: "codex", environmentKey: "LINGER_CODEX_PATH" }',
      ),
    ).toEqual(["LINGER_CODEX_PATH"]);
  });

  it("sees Go reads through literals, constants and environment snapshots", () => {
    expect(
      goVariableNames(
        [
          'timeout := os.Getenv("DIRECT_READ")',
          'const ConfigPathEnv = "CONSTANT_READ"',
          "path := os.Getenv(ConfigPathEnv)",
          'setDurationEnvironment(&value, "HELPER_READ")',
          'command := environment["SNAPSHOT_READ"]',
          'label := "NOT_AN_ENV_READ"',
        ].join("\n"),
      ).sort(),
    ).toEqual(["CONSTANT_READ", "DIRECT_READ", "HELPER_READ", "SNAPSHOT_READ"]);
  });

  it("rejects a variable that code reads but nobody lists", () => {
    const errors = validateInventory(
      readers({ NEW_SETTING: ["apps/node-services/src/config.ts"] }),
      new Set(),
      inventory(),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        "NEW_SETTING is read by apps/node-services/src/config.ts but is neither",
      ),
    ]);
  });

  it("rejects .env.example entries nobody reads unless an indirect reader is named", () => {
    expect(
      validateInventory(readers({}), new Set(["STALE_SETTING"]), inventory()),
    ).toEqual([
      expect.stringContaining(
        "STALE_SETTING is in .env.example but no code reads it",
      ),
    ]);
    expect(
      validateInventory(
        readers({}),
        new Set(["COMPOSE_PROJECT_NAME"]),
        inventory({ indirect: { COMPOSE_PROJECT_NAME: "docker compose" } }),
      ),
    ).toEqual([]);
  });

  it("keeps the inventory itself current", () => {
    const errors = validateInventory(
      readers({
        BOTH: ["apps/teamhub/internal/config/config.go"],
        READ: ["apps/node-services/src/a.ts"],
      }),
      new Set(["BOTH", "READ"]),
      inventory({
        indirect: { READ: "someone", MISSING: "someone" },
        unlisted: {
          teamhub: {
            owner: "docs",
            description: "",
            names: ["BOTH", "GONE"],
          },
        },
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BOTH is in .env.example; remove it from"),
        expect.stringContaining(
          "GONE in scripts/env-inventory.json group teamhub is no longer read",
        ),
        expect.stringContaining(
          "MISSING is listed as indirect but is not in .env.example",
        ),
        expect.stringContaining(
          'READ is read by our code; remove it from "indirect"',
        ),
      ]),
    );
  });

  it("has every variable read by runtime code accounted for in this repository", async () => {
    const messages: string[] = [];
    const exitCode = await runEnvInventoryCheck({
      stderr: (message) => messages.push(message),
    });
    expect(messages).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
