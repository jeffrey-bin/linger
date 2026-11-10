import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
  mkdir,
  link,
  open,
  readdir,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMessageSend } from "./message-send-executor.js";
import type { TeamHubHttpClient } from "./http-client.js";
import { displayText } from "./display-text.js";

const roots: string[] = [];
async function root() {
  const value = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "teamhub-send-")),
  );
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});
function client(
  fetcher: (body: FormData) => Promise<Response>,
): TeamHubHttpClient {
  return {
    config: {
      url: "https://example.test",
      token: "secret",
      identityKey: "test-identity",
      identity: { tenantId: "tenant", agentId: "agent" },
    },
    request: async (_endpoint, options) => fetcher(options!.body as FormData),
    get api(): TeamHubHttpClient["api"] {
      throw Error("unexpected JSON request");
    },
  };
}
function result(body: FormData) {
  const metadata = JSON.parse(displayText(body.get("metadata")));
  return Response.json({
    accepted: true,
    target: { type: "room", id: "room_example" },
    inbox_id: "room_example",
    message_id: "message_example",
    resources: metadata.segments.map((_: unknown, index: number) => ({
      kind: "document",
      segment_index: index,
      status: "published",
      document_id: `document_${index}`,
      version_id: `version_${index}`,
      name: "report.pdf",
    })),
    duplicate_request: false,
  });
}
describe("atomic message resource execution", () => {
  it("sends the continuation declaration only when declared and one invocation per operation", async () => {
    const cwd = await root();
    const observed: unknown[] = [];
    const invocations: string[] = [];
    const transport = client(async (body) => {
      const metadata = JSON.parse(body.get("metadata") as string);
      observed.push(
        Object.hasOwn(metadata, "continues") ? metadata.continues : "absent",
      );
      invocations.push(metadata.invocation_id);
      return Response.json({
        accepted: true,
        target: { type: "room", id: "room_example" },
        inbox_id: "room_example",
        message_id: "message_example",
        resources: [],
        duplicate_request: false,
      });
    });
    const send = (continues: boolean, operationId: string) =>
      executeMessageSend(
        {
          inbox_id: "room_example",
          message_segments: [{ type: "text", content: "On it" }],
          ...(continues ? { continues: true } : {}),
        },
        {
          client: transport,
          cwd,
          stateRoot: cwd,
          operationId,
          target: { type: "room", id: "room_example" },
        },
      );
    await send(true, "operation_ack");
    await send(true, "operation_ack");
    await send(false, "operation_final");
    expect(observed).toEqual([true, true, "absent"]);
    // TeamHub deduplicates by invocation: a retry of one operation repeats
    // it, and a second send in the same Run is a separate operation.
    expect(invocations[1]).toBe(invocations[0]);
    expect(invocations[2]).not.toBe(invocations[0]);
  });

  it("does not submit resources when a hardlink appears after the initial file check", async () => {
    const cwd = await root();
    const source = path.join(cwd, "report.pdf");
    await writeFile(source, "private alias fixture");
    const probe = await open(source, "r");
    const inode = (await probe.stat({ bigint: true })).ino;
    const prototype = Object.getPrototypeOf(probe) as {
      stat: FileHandle["stat"];
    };
    await probe.close();
    const original = prototype.stat;
    let linked = false;
    prototype.stat = async function (this: FileHandle, ...args: unknown[]) {
      const metadata = await Reflect.apply(original, this, args);
      if (!linked && metadata.ino === inode) {
        linked = true;
        await link(source, path.join(cwd, "alias.pdf"));
        return Reflect.apply(original, this, args);
      }
      return metadata;
    } as FileHandle["stat"];
    let submissions = 0;
    const transport = client(async (body) => {
      submissions += 1;
      return result(body);
    });
    try {
      await expect(
        executeMessageSend(
          {
            inbox_id: "room_example",
            message_segments: [
              { type: "document", "content-path": "report.pdf", mode: "file" },
            ],
          },
          {
            client: transport,
            cwd,
            stateRoot: cwd,
            operationId: "hardlink-race",
            target: { type: "room", id: "room_example" },
          },
        ),
      ).rejects.toThrow(/alias|hard.?link/i);
      expect(linked).toBe(true);
      expect(submissions).toBe(0);
    } finally {
      prototype.stat = original;
    }
  });
  it("publishes files under a projected workspace directory without allowing private directory aliases", async () => {
    const cwd = await root();
    const shared = await root();
    await mkdir(path.join(shared, "room"));
    await writeFile(path.join(shared, "room", "report.md"), "projected report");
    await symlink(shared, path.join(cwd, "playground"), "junction");
    const payloads: string[] = [];
    const transport = client(async (body) => {
      payloads.push(await (body.get("file") as File).text());
      return result(body);
    });
    const context = {
      client: transport,
      cwd,
      stateRoot: cwd,
      operationId: "projected-report",
      target: { type: "room", id: "room_example" },
    };
    await executeMessageSend(
      {
        inbox_id: "room_example",
        message_segments: [
          {
            type: "document",
            "content-path": "playground/room/report.md",
            mode: "file",
          },
        ],
      },
      context,
    );
    expect(payloads).toEqual(["projected report"]);

    await mkdir(path.join(shared, ".teamhub"));
    await writeFile(path.join(shared, ".teamhub", "secret.md"), "private");
    await symlink(
      path.join(shared, ".teamhub"),
      path.join(cwd, "public-alias"),
      "junction",
    );
    await expect(
      executeMessageSend(
        {
          inbox_id: "room_example",
          message_segments: [
            { type: "document", "content-path": "public-alias/secret.md" },
          ],
        },
        {
          ...context,
          operationId: "private-alias",
        },
      ),
    ).rejects.toThrow();
    expect(payloads).toEqual(["projected report"]);
  });
  it("keeps no local state: a retry rereads its files under the same invocation", async () => {
    const cwd = await root();
    await writeFile(path.join(cwd, "report.pdf"), "original");
    let calls = 0;
    const payloads: string[] = [];
    const invocations: string[] = [];
    const transport = client(async (body) => {
      calls++;
      payloads.push(await (body.get("file") as File).text());
      invocations.push(
        JSON.parse(displayText(body.get("metadata"))).invocation_id,
      );
      if (calls === 1) throw Error("lost response");
      return result(body);
    });
    const input = {
      inbox_id: "room_example",
      message_segments: [{ type: "document", "content-path": "report.pdf" }],
    };
    const context = {
      client: transport,
      cwd,
      stateRoot: cwd,
      operationId: "operation-1",
      target: { type: "room", id: "room_example" },
    };
    await expect(executeMessageSend(input, context)).rejects.toThrow();
    await writeFile(path.join(cwd, "report.pdf"), "changed");
    await executeMessageSend(input, context);
    // The retry sends the file as it is now. TeamHub returns the first commit
    // only for identical input; changed bytes under the same ID get
    // idempotency_conflict.
    expect(payloads).toEqual(["original", "changed"]);
    expect(invocations[1]).toBe(invocations[0]);
    expect(await readdir(cwd)).toEqual(["report.pdf"]);
  });
  it("rejects every bad resource before any network side effect", async () => {
    const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
    if (process.platform === "win32" && !fixtureRoot)
      throw new Error("LINGER_TEST_WINDOWS_FILE_LINKS is required");
    const cwd =
      process.platform === "win32"
        ? path.join(fixtureRoot!, "message")
        : await root();
    if (process.platform !== "win32") {
      await writeFile(path.join(cwd, "valid.pdf"), "valid");
      await mkdir(path.join(cwd, ".teamhub"));
      await writeFile(path.join(cwd, ".teamhub", "private.pdf"), "secret");
      await symlink(
        path.join(cwd, ".teamhub", "private.pdf"),
        path.join(cwd, "alias.pdf"),
      );
    }
    let calls = 0;
    const transport = client(async (body) => {
      calls++;
      return result(body);
    });
    await expect(
      executeMessageSend(
        {
          inbox_id: "room_example",
          message_segments: [
            { type: "document", "content-path": "valid.pdf" },
            { type: "document", "content-path": "alias.pdf" },
          ],
        },
        {
          client: transport,
          cwd,
          stateRoot: cwd,
          operationId: "operation-2",
          target: { type: "room", id: "room_example" },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("preserves directory bytes, empty directories and ordering in the atomic manifest", async () => {
    const cwd = await root();
    await mkdir(path.join(cwd, "site", "empty"), { recursive: true });
    await writeFile(path.join(cwd, "site", "index.html"), "<h1>Site</h1>");
    await writeFile(path.join(cwd, "site", "readme.md"), "raw ![x](image.png)");
    let observed: unknown;
    const transport = client(async (body) => {
      observed = JSON.parse(displayText(body.get("metadata")));
      return Response.json({
        accepted: true,
        target: { type: "room", id: "room_example" },
        inbox_id: "room_example",
        message_id: "message_example",
        resources: [
          {
            kind: "tree",
            segment_index: 0,
            status: "published",
            publication_group_id: "group",
            root_placement_path: "site",
            file_count: 2,
            directory_count: 2,
            total_bytes: Buffer.byteLength("<h1>Site</h1>raw ![x](image.png)"),
            documents: [
              {
                relative_path: "index.html",
                document_id: "document_index",
                document_version_id: "version_index",
              },
              {
                relative_path: "readme.md",
                document_id: "document_readme",
                document_version_id: "version_readme",
              },
            ],
          },
        ],
        duplicate_request: false,
      });
    });
    await executeMessageSend(
      {
        inbox_id: "room_example",
        message_segments: [
          { type: "document", "content-path": "site", mode: "tree" },
        ],
      },
      {
        client: transport,
        cwd,
        stateRoot: cwd,
        operationId: "operation-3",
        target: { type: "room", id: "room_example" },
      },
    );
    expect(observed).toMatchObject({
      segments: [
        {
          type: "document",
          mode: "tree",
          root_name: "site",
          entries: [
            { kind: "directory", relative_path: "empty" },
            { kind: "file", relative_path: "index.html" },
            { kind: "file", relative_path: "readme.md" },
          ],
        },
      ],
    });
  });
});
