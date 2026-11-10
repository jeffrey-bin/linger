import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTeamHubClient } from "./http-client.js";
import { executeFileCommand } from "./file-executor.js";

const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const enabled = process.platform === "win32" && !!fixtureRoot;

it
  .runIf(enabled)
  .each(["env", "env-production", "env-example", "node-modules"])(
  "rejects precreated sensitive file link %s before upload",
  async (name) => {
    const root = path.join(fixtureRoot!, name);
    const target = path.join(
      root,
      "nested",
      name === "env"
        ? ".env"
        : name === "env-production"
          ? ".env.production"
          : name === "env-example"
            ? ".env.example"
            : "node_modules/private.txt",
    );
    const alias = path.join(root, "public.txt");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await realpath(alias)).toBe(await realpath(target));
    const before = await readFile(target);
    const fetcher = vi.fn<typeof fetch>();
    const client = createTeamHubClient(
      {
        url: "https://teamhub.example",
        token: "th_agent_fixture",
        identityKey: digest("fixture-agent"),
        scope: { kind: "room", id: "room_one" },
      },
      { fetch: fetcher },
    );
    await expect(
      executeFileCommand(
        {
          route: "docs/replace",
          body: { file_path: alias, document_id: "document_abc" },
        },
        client,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(before);
  },
);

it.runIf(enabled)(
  "rejects a precreated link replacing a tracked working copy",
  async () => {
    const root = path.join(fixtureRoot!, "tracked");
    const target = path.join(root, "actual.md");
    const alias = path.join(root, "prepared-link");
    const report = path.join(root, "report.md");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await realpath(alias)).toBe(await realpath(target));
    const before = await readFile(target);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("original", {
        headers: {
          "x-content-sha256": digest("original"),
          "x-document-version-id": "revision_one",
          "x-document-read-only": "true",
          "x-document-filename": Buffer.from("report.md").toString("base64url"),
        },
      }),
    );
    const client = createTeamHubClient(
      {
        url: "https://teamhub.example",
        token: "th_agent_fixture",
        identityKey: digest("fixture-agent"),
        scope: { kind: "room", id: "room_one" },
      },
      { fetch: fetcher },
    );
    await executeFileCommand(
      {
        route: "docs/get",
        body: { name: "document_abc", target_path: report, format: "html" },
      },
      client,
      async () => {},
    );
    fetcher.mockClear();
    await rm(report);
    await rename(alias, report);
    expect((await lstat(report)).isSymbolicLink()).toBe(true);
    expect(await realpath(report)).toBe(await realpath(target));
    await expect(
      executeFileCommand(
        {
          route: "docs/replace",
          body: { file_path: report, document_id: "document_abc" },
        },
        client,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(before);
  },
);
