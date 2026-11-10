import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { parseDomainCommand } from "./domain-commands.js";
import { displayText } from "./display-text.js";
import { writeCliConfig } from "./test-support/cli-config.js";

const token = "th_agent_fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function run(args: string[], response: Response) {
  const cwd = await mkdtemp(path.join(tmpdir(), "teamhub-cli-files-"));
  const configDirectory = await mkdtemp(
    path.join(tmpdir(), "teamhub-cli-files-config-"),
  );
  roots.push(cwd, configDirectory);
  await writeFile(path.join(cwd, "report.md"), "content");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    cwd,
    env: writeCliConfig(configDirectory, {
      token,
      scope: { kind: "room", id: "room_fixture" },
    }),
    fetch: fetcher,
    stdout: (value) => {
      stdout.push(value);
    },
    stderr: (value) => {
      stderr.push(value);
    },
  });
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    fetcher,
    cwd,
  };
}
describe("document command syntax", () => {
  it.each([
    ["build", "get"],
    ["build", "status"],
    ["build", "name"],
    ["build", "prompt"],
    ["build", "skills"],
    ["build", "draft"],
    ["skill", "search"],
  ])(
    "rejects retired Builder command %j before network access",
    async (...command) => {
      const result = await run(
        [...command, "--input", "-", "--json"],
        Response.json({}),
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "usage" },
      });
      expect(result.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      ["docs", "replace", "document_abc", "body.json"],
      "docs/replace",
      {
        document_id: "document_abc",
        file_path: path.resolve("/workspace/body.json"),
      },
    ],
    [
      ["docs", "get", "report.md", "-o", "refs/report.md"],
      "docs/get",
      {
        name: "report.md",
        target_path: path.resolve("/workspace/refs/report.md"),
      },
    ],
    [
      ["docs", "get", "document_abc", "--raw"],
      "docs/get",
      {
        name: "document_abc",
        target_path: path.resolve("/workspace/document_abc"),
        raw: true,
      },
    ],
    [
      ["docs", "get", "document_abc", "--format", "blocks"],
      "docs/get",
      {
        name: "document_abc",
        target_path: path.resolve("/workspace/document_abc"),
        format: "blocks",
      },
    ],
    [["docs", "list", "--shared"], "docs/ls", { shared_with_me: true }],
  ] as const)("normalizes %j", async (args, route, input) => {
    const parsed = await parseDomainCommand(args, { cwd: "/workspace" });
    expect(parsed.descriptor.fileRoute).toBe(route);
    expect(parsed.body.input).toEqual(input);
    expect(parsed.json).toBe(false);
  });
  it.each([
    [],
    ["docs"],
    ["publish"],
    ["publish", "a", "b"],
    ["docs", "ls"],
    ["docs", "list", "--force"],
    ["docs", "get", "x", "-o"],
    ["docs", "get", "../secret"],
    ["update", "document_one", "report.md"],
    ["docs", "replace", "body.json"],
    ["docs", "get", "x", "--format"],
    ["docs", "get", "x", "--format", "pdf"],
    ["docs", "get", "x", "--format", "html", "--format", "html"],
    ["docs", "get", "x", "--force"],
    ["docs", "request", "document_abc"],
    ["docs", "list", "--shared", "true"],
    ["share", "report.md"],
    ["skill", "publish", "a"],
  ])("rejects invalid or retired %j", async (...args) => {
    await expect(
      parseDomainCommand(args, { cwd: "/workspace" }),
    ).rejects.toThrow();
  });
  it("accepts a capability URL as an opaque document reference", async () => {
    const url = `https://example.test/shared-documents#doc_link_${"a".repeat(43)}`;
    const parsed = await parseDomainCommand(
      ["docs", "get", url, "-o", "report.txt"],
      { cwd: "/workspace" },
    );
    expect(parsed.body.input).toEqual({
      name: url,
      target_path: path.resolve("/workspace/report.txt"),
    });
  });
});
describe("standalone file CLI output", () => {
  it("labels the Windows save commands with their required shells", async () => {
    const result = await run(
      ["docs", "get", "document_abc", "--format", "blocks"],
      new Response("downloaded", {
        headers: {
          "x-content-sha256": createHash("sha256")
            .update("downloaded")
            .digest("hex"),
          "x-document-version-id": "version_download",
          "x-document-read-only": "true",
          "x-document-format": "blocks",
          "x-document-filename": Buffer.from("report.md").toString("base64url"),
        },
      }),
    );
    expect(result.code).toBe(0);
    if (process.platform === "win32") {
      expect(result.stdout).toContain("Save (PowerShell): teamhub ");
      expect(result.stdout).toContain("Save (Git Bash): teamhub ");
    } else {
      expect(result.stdout).toContain("Save: teamhub ");
      expect(result.stdout).not.toContain("Save (Git Bash)");
    }
  });

  it("lists readable metadata and keeps the JSON shape", async () => {
    const file = {
      name: "report.md",
      document_id: "document_1",
      role: "viewer",
      version_id: "version_2",
      version_number: 2,
      editable: false,
      read_only: false,
      sources: ["Room A"],
      shared_with_me: true,
    };
    const human = await run(["docs", "list"], Response.json({ files: [file] }));
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("document_1 · report.md");
    expect(human.stdout).toContain("Shared with you: true");
    expect(new URL(displayText(human.fetcher.mock.calls[0]![0])).pathname).toBe(
      "/api/agent/v1/files",
    );
    expect(
      new Headers(human.fetcher.mock.calls[0]![1]!.headers).get(
        "authorization",
      ),
    ).toBe(`Bearer ${token}`);
    const json = await run(
      ["docs", "list", "--json"],
      Response.json({ files: [file] }),
    );
    expect(JSON.parse(json.stdout)).toEqual({ documents: [file] });
    expect(
      new URL(displayText(json.fetcher.mock.calls[0]![0])).searchParams.has(
        "shared_with_me",
      ),
    ).toBe(false);
    const shared = await run(
      ["docs", "list", "--shared", "--json"],
      Response.json({ files: [file] }),
    );
    expect(
      new URL(displayText(shared.fetcher.mock.calls[0]![0])).searchParams.get(
        "shared_with_me",
      ),
    ).toBe("true");
  });
  it("prints the committed Document ID without an HTTP acknowledgement roundtrip", async () => {
    const result = await run(
      ["message", "send", "--attach", "report.md"],
      Response.json({
        accepted: true,
        target: { type: "room", id: "room_fixture" },
        inbox_id: "room:room_fixture",
        message_id: "message_one",
        duplicate_request: false,
        resources: [
          {
            kind: "document",
            segment_index: 0,
            status: "published",
            document_id: "document_abc",
            version_id: "version_one",
            name: "report.md",
          },
        ],
      }),
    );
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("document_abc");
    expect(result.stdout).toContain("version_one");
    expect(
      new URL(displayText(result.fetcher.mock.calls[0]![0])).pathname,
    ).toBe("/api/agent/v1/messages/commit");
    expect(result.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["forbidden", 4],
    ["not_found", 5],
    ["too_large", 2],
    ["invalid_path", 2],
    ["invalid_input", 2],
    ["ambiguous_name", 2],
  ] as const)("maps %s to exit %s", async (code, exitCode) => {
    const result = await run(
      ["message", "send", "--attach", "report.md", "--json"],
      Response.json(
        { error: { code, message: "Cannot publish" } },
        { status: 403 },
      ),
    );
    expect(result.code).toBe(exitCode);
    expect(JSON.parse(result.stderr).error.code).toBe(code);
    expect(result.stdout).toBe("");
  });
  it.each([false, true])(
    "explains version conflict details (nested=%s)",
    async (nested) => {
      const details = {
        base_version_id: "version-a",
        current_version_id: "version-b",
      };
      const result = await run(
        [
          "docs",
          "update",
          "document_abc",
          "--command",
          "append",
          "--content",
          "More",
        ],
        Response.json(
          {
            error: {
              code: "version_conflict",
              message: "Conflict",
              ...(nested ? { details } : details),
            },
          },
          { status: 409 },
        ),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("version-a");
      expect(result.stderr).toContain("version-b");
      expect(result.stderr).toContain("different path");
      expect(result.stderr).not.toContain("--force");
    },
  );
  it("does not expose non-JSON upstream errors or credentials", async () => {
    const result = await run(
      ["docs", "list"],
      new Response(`<html>${token}</html>`, { status: 502 }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).not.toContain("<html>");
  });
});
