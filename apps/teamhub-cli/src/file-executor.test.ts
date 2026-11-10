import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeamHubClient } from "./http-client.js";
import { executeFileCommand } from "./file-executor.js";
import { displayText } from "./display-text.js";
import { requestUrlText } from "./test-support/fetch-text.js";

const directories: string[] = [];
const digest = (content: string) =>
  createHash("sha256").update(content).digest("hex");
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "teamhub-files-"));
  directories.push(cwd);
  const source = path.join(cwd, "report.md");
  await writeFile(source, "original");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, options) => {
      const content = await (options!.body as Blob).text();
      return Response.json({
        document_id: "document_abc",
        revision_id: "revision_two",
        history_entry_id: "history_two",
        sha256: digest(content),
        unchanged: false,
        read_only: false,
      });
    });
  const client = createTeamHubClient(
    {
      url: "https://teamhub.example",
      token: "th_agent_fixture",
      identityKey: digest("fixture-agent"),
      scope: { kind: "room", id: "room_one" },
    },
    { fetch: fetcher },
  );
  return { cwd, source, fetcher, client };
}
async function trackedCopy(f: Awaited<ReturnType<typeof fixture>>) {
  await rm(f.source);
  f.fetcher.mockResolvedValueOnce(
    new Response("original", {
      headers: {
        "x-content-sha256": digest("original"),
        "x-document-version-id": "revision_one",
        "x-document-read-only": "true",
        "x-document-filename": Buffer.from("report.md").toString("base64url"),
      },
    }),
  );
  await executeFileCommand(
    {
      route: "docs/get",
      body: { name: "document_abc", target_path: f.source, format: "html" },
    },
    f.client,
    async () => {},
  );
  f.fetcher.mockClear();
}
const replaceCommand = (file_path: string) => ({
  route: "docs/replace",
  body: { file_path, document_id: "document_abc" },
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe("independent CLI local files", () => {
  it.each(["publish", "update", "tree", "unknown"])(
    "rejects removed or unknown route %s before filesystem or network access",
    async (route) => {
      const f = await fixture();
      await expect(
        executeFileCommand({ route, body: {} }, f.client, async () => {}),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([".teamhub", ".agents", ".git", "node_modules"])(
    "rejects direct and symlink ancestor access to %s before network",
    async (name) => {
      const f = await fixture();
      const secret = path.join(f.cwd, name, "private");
      await mkdir(secret, { recursive: true });
      await writeFile(
        path.join(secret, "credential"),
        "private-token-never-upload",
      );
      const alias = path.join(f.cwd, "innocent");
      await symlink(path.dirname(secret), alias, "junction");
      for (const file_path of [
        secret,
        path.join(alias, "private"),
        path.join(alias, "private", "credential"),
      ]) {
        await expect(
          executeFileCommand(
            {
              route: "docs/replace",
              body: { file_path, document_id: "document_abc" },
            },
            f.client,
            async () => {},
          ),
        ).rejects.toMatchObject({ code: "forbidden" });
      }
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(
    [
      ".env",
      ".env.production",
      ".env.example",
      "node_modules/private.txt",
    ].flatMap((name) =>
      ["direct", "symlink alias"].map((access) => ({ name, access })),
    ),
  )(
    "rejects nested $name through $access before upload",
    async ({ name, access }) => {
      const f = await fixture();
      const source = path.join(f.cwd, "nested", name);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, "FAKE_PRIVATE_SENTINEL=fixture-only");
      let target =
        access === "direct" ? source : path.join(f.cwd, "public.txt");
      if (access !== "direct") {
        if (process.platform === "win32") {
          const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
          if (!fixtureRoot)
            throw new Error("LINGER_TEST_WINDOWS_FILE_LINKS is required");
          const directory = (
            {
              ".env": "env",
              ".env.production": "env-production",
              ".env.example": "env-example",
              "node_modules/private.txt": "node-modules",
            } as Record<string, string>
          )[name]!;
          target = path.join(fixtureRoot, directory, "public.txt");
        } else await symlink(source, target);
      }
      await expect(
        executeFileCommand(replaceCommand(target), f.client, async () => {}),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  // Spawns a child process and syncs files on disk; under CI load this exceeds the 5s default.
  it("replaces tracked native bytes with the captured revision CAS", async () => {
    const f = await fixture();
    await trackedCopy(f);
    await writeFile(f.source, "edited");
    const emit = vi.fn<(result: Record<string, unknown>) => Promise<void>>(
      async () => {},
    );
    await executeFileCommand(replaceCommand(f.source), f.client, emit);
    const endpoint = new URL(displayText(f.fetcher.mock.calls[0]![0]));
    expect(endpoint.pathname).toBe("/api/agent/v1/files/document_abc/body");
    expect(endpoint.searchParams.get("base_revision_id")).toBe("revision_one");
    expect(endpoint.searchParams.get("operation_id")).toMatch(
      /^docs-replace:[0-9a-f]{64}$/,
    );
    for (const key of [
      "tenant_id",
      "agent_id",
      "context_session_id",
      "context_generation_id",
      "file_path",
    ])
      expect(endpoint.searchParams.has(key)).toBe(false);
    expect(await (f.fetcher.mock.calls[0]![1]!.body as Blob).text()).toBe(
      "edited",
    );
    expect(emit.mock.calls[0]![0]).toMatchObject({
      status: "replaced",
      document_id: "document_abc",
      revision_id: "revision_two",
      history_entry_id: "history_two",
    });
  }, 30_000);
  it("requires the exact downloaded Document identity before replacing", async () => {
    const f = await fixture();
    await expect(
      executeFileCommand(replaceCommand(f.source), f.client, async () => {}),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await trackedCopy(f);
    await expect(
      executeFileCommand(
        {
          route: "docs/replace",
          body: { file_path: f.source, document_id: "document_other" },
        },
        f.client,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("preserves local edits and the captured baseline after CAS rejection", async () => {
    const f = await fixture();
    await trackedCopy(f);
    await writeFile(f.source, "edited");
    const normal = f.fetcher.getMockImplementation()!;
    f.fetcher.mockResolvedValueOnce(
      Response.json(
        { error: { code: "version_conflict", message: "Concurrent edit" } },
        { status: 409 },
      ),
    );
    await expect(
      executeFileCommand(replaceCommand(f.source), f.client, async () => {}),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(await readFile(f.source, "utf8")).toBe("edited");
    f.fetcher.mockImplementation(normal);
    await executeFileCommand(
      replaceCommand(f.source),
      f.client,
      async () => {},
    );
    const endpoints = f.fetcher.mock.calls.map(
      ([url]) => new URL(requestUrlText(url)),
    );
    expect(
      endpoints.map((url) => url.searchParams.get("base_revision_id")),
    ).toEqual(["revision_one", "revision_one"]);
    expect(endpoints.every((url) => url.pathname.endsWith("/body"))).toBe(true);
  });
  it("keeps the downloaded base after a lost response so a retry is checked by TeamHub's CAS", async () => {
    const f = await fixture();
    await trackedCopy(f);
    await writeFile(f.source, "edited");
    const normal = f.fetcher.getMockImplementation()!;
    f.fetcher.mockRejectedValueOnce(new Error("response lost"));
    const command = replaceCommand(f.source);
    await expect(
      executeFileCommand(command, f.client, async () => {}),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    await writeFile(f.source, "new local edit");
    f.fetcher.mockImplementation(normal);
    await executeFileCommand(command, f.client, async () => {});
    const urls = f.fetcher.mock.calls.map(
      ([url]) => new URL(requestUrlText(url)),
    );
    expect(urls[1]!.searchParams.get("base_revision_id")).toBe(
      urls[0]!.searchParams.get("base_revision_id"),
    );
    expect(urls[1]!.searchParams.get("operation_id")).not.toBe(
      urls[0]!.searchParams.get("operation_id"),
    );
    expect(await (f.fetcher.mock.calls[1]![1]!.body as Blob).text()).toBe(
      "new local edit",
    );
  });
  it("records a committed replacement before output, so a rerun after a stdout failure writes nothing", async () => {
    const f = await fixture();
    await trackedCopy(f);
    await writeFile(f.source, "edited");
    const command = replaceCommand(f.source);
    await expect(
      executeFileCommand(command, f.client, async () => {
        throw new Error("EPIPE");
      }),
    ).rejects.toThrow("EPIPE");
    const emit = vi.fn(async () => {});
    await executeFileCommand(command, f.client, emit);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]).toBeDefined();
  });
  it("downloads on the local machine and verifies digest before installation", async () => {
    const f = await fixture();
    const target = path.join(f.cwd, "download.md");
    f.fetcher.mockResolvedValue(
      new Response("downloaded", {
        headers: {
          "x-content-sha256": digest("downloaded"),
          "x-document-version-id": "version_download",
          "x-document-read-only": "false",
          "x-document-filename":
            Buffer.from("download.md").toString("base64url"),
        },
      }),
    );
    await executeFileCommand(
      {
        route: "docs/get",
        body: { name: "document_abc", target_path: target },
      },
      f.client,
      async () => {},
    );
    expect(await readFile(target, "utf8")).toBe("downloaded");
    expect(displayText(f.fetcher.mock.calls[0]![0])).toContain(
      "/api/agent/v1/files/document_abc/content",
    );
  });
  it.each(
    [false, true].flatMap((readOnly) =>
      ["'", "\u2018", "\u2019", "\u201a", "\u201b"].map((quote) => ({
        readOnly,
        quote,
      })),
    ),
  )(
    "emits a native shell save command without executing path text ($readOnly, $quote)",
    async ({ readOnly, quote }) => {
      const f = await fixture();
      const target = path.join(
        f.cwd,
        `Rapport é file${quote}; Write-Output INJECTED; #.md`,
      );
      f.fetcher.mockResolvedValue(
        new Response("downloaded", {
          headers: {
            "x-content-sha256": digest("downloaded"),
            "x-document-version-id": "version_download",
            "x-document-read-only": String(readOnly),
            "x-document-filename":
              Buffer.from("report.md").toString("base64url"),
          },
        }),
      );
      let saved: Record<string, unknown> = {};
      await executeFileCommand(
        {
          route: "docs/get",
          body: {
            name: "document_abc",
            target_path: target,
            ...(readOnly ? { format: "blocks" } : {}),
          },
        },
        f.client,
        async (result) => {
          saved = result;
        },
      );
      if (!readOnly) {
        expect(saved).not.toHaveProperty("save_command");
        expect(saved).not.toHaveProperty("save_command_shell");
        expect(saved).not.toHaveProperty("save_command_bash");
        return;
      }
      const command = String(saved.save_command);
      if (process.platform === "win32") {
        expect(saved.save_command_shell).toBe("powershell");
        expect(saved.save_command_bash).toEqual(expect.any(String));
      }
      const args =
        process.platform === "win32"
          ? JSON.parse(
              execFileSync(
                path.join(
                  process.env.SystemRoot!,
                  "System32",
                  "WindowsPowerShell",
                  "v1.0",
                  "powershell.exe",
                ),
                [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); function teamhub { $args | ConvertTo-Json -Compress }; ${command}`,
                ],
                { encoding: "utf8" },
              ),
            )
          : execFileSync(
              "/bin/sh",
              ["-c", `teamhub() { printf '%s\\n' "$@"; }; ${command}`],
              { encoding: "utf8" },
            )
              .trimEnd()
              .split("\n");
      expect(args).toEqual([
        "docs",
        "replace",
        "document_abc",
        await realpath(target),
      ]);
    },
    15_000,
  );
  it("refuses symlink sources", async () => {
    const f = await fixture();
    await trackedCopy(f);
    await rm(f.source);
    const actual = path.join(f.cwd, "actual.md");
    await writeFile(actual, "original");
    const alias = f.source;
    if (process.platform === "win32") {
      const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
      if (!fixtureRoot)
        throw new Error("LINGER_TEST_WINDOWS_FILE_LINKS is required");
      await rename(
        path.join(fixtureRoot, "tracked-original", "prepared-link"),
        alias,
      );
    } else await symlink(actual, alias);
    await expect(
      executeFileCommand(replaceCommand(alias), f.client, async () => {}),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects damaged downloads and preserves an existing local file", async () => {
    const f = await fixture();
    const target = path.join(f.cwd, "download.md");
    const headers = {
      "x-content-sha256": digest("expected"),
      "x-document-version-id": "version_one",
      "x-document-read-only": "false",
      "x-document-filename": Buffer.from("download.md").toString("base64url"),
    };
    f.fetcher.mockResolvedValueOnce(new Response("damaged", { headers }));
    const command = {
      route: "docs/get",
      body: { name: "document_abc", target_path: target },
    };
    await expect(
      executeFileCommand(command, f.client, async () => {}),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(target, "local work");
    f.fetcher.mockResolvedValueOnce(new Response("expected", { headers }));
    await expect(
      executeFileCommand(command, f.client, async () => {}),
    ).rejects.toMatchObject({ code: "file_exists" });
    expect(await readFile(target, "utf8")).toBe("local work");
  });
});
