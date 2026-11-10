import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { runnerGatewayEnvelopeSchema } from "@linger/wire-contracts/runner-gateway/schema";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeViewPlan } from "../../../src/agent/executor/workspace.js";
import { encodeExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import {
  createContextViewContent,
  type ContextViewContent,
} from "../../../src/agent/runner-gateway/context-view-content.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function sourceRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-view-content-"));
  roots.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

function plan(memory: string, playground: string): RuntimeViewPlan {
  return {
    ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
    contextKey: encodeExecutionContextRef({
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    }),
    mappings: [
      {
        kind: "memory",
        sourcePath: memory,
        targetPath: "/workspace/memory",
        access: "read_only",
      },
      {
        kind: "playground",
        sourcePath: playground,
        targetPath: "/workspace/playground",
        access: "read_write",
      },
    ],
  };
}

function content(current = new Set(["computer-1:1"])): ContextViewContent {
  return createContextViewContent({
    publicOrigin: "https://agent.example",
    signingKey: "k".repeat(32),
    isCurrentConnection: (computerId, epoch) =>
      current.has(`${computerId}:${epoch}`),
  });
}

function token(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function validateManifest(manifest: unknown): boolean {
  const wireRequire = createRequire(
    import.meta.resolve("@linger/wire-contracts/runner-gateway/validator"),
  );
  const { Ajv2020 } = wireRequire("ajv/dist/2020.js");
  const addFormats = wireRequire("ajv-formats");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(runnerGatewayEnvelopeSchema);
  const validate = ajv.compile({
    $ref: `${runnerGatewayEnvelopeSchema.$id}#/$defs/ContextViewManifest`,
  });
  const valid = validate(manifest) as boolean;
  if (!valid) throw new Error(JSON.stringify(validate.errors));
  return valid;
}

describe("Context View content", () => {
  it("names a View by its manifest digest and serves it and its files to the current connection", async () => {
    const memory = await sourceRoot({
      "MEMORY.md": "remember\n",
      "notes/run.sh": "echo hi\n",
    });
    await chmod(path.join(memory, "notes", "run.sh"), 0o755);
    const playground = await sourceRoot({ "draft.txt": "draft\n" });
    const views = content();
    const snapshot = await views.snapshot({
      computerId: "computer-1",
      plan: plan(memory, playground),
      runtimeInstanceId: "runtime-1",
      skills: [
        {
          package_name: "demo",
          manifest_id: "manifest-1",
          package_sha256: "b".repeat(64),
        },
      ],
      signal: new AbortController().signal,
    });
    const url = views.contentUrl("computer-1", 1);
    expect(url).toMatch(/^https:\/\/agent\.example\/v1\/context-content\//);

    const response = await views.handle(
      token(url),
      "views",
      snapshot.viewDigest,
      new Request(`${url}/views/${snapshot.viewDigest}`),
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      snapshot.viewDigest,
    );
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    expect(validateManifest(manifest)).toBe(true);
    expect(manifest.mappings[0]).toMatchObject({
      kind: "memory",
      target_path: "memory",
      access: "read_only",
    });
    const files = manifest.mappings[0].files;
    expect(
      files.map((file: { relative_path: string }) => file.relative_path),
    ).toEqual(["MEMORY.md", "notes/run.sh"]);
    if (process.platform !== "win32")
      expect(files[1]).toMatchObject({ executable: true });

    const file = await views.handle(
      token(url),
      "files",
      files[0].sha256,
      new Request(`${url}/files/${files[0].sha256}`),
    );
    expect(await file.text()).toBe("remember\n");
  });

  it("refuses another connection, an unknown View and a source that changed", async () => {
    const memory = await sourceRoot({ "MEMORY.md": "first\n" });
    const playground = await sourceRoot({});
    const current = new Set(["computer-1:1"]);
    const views = content(current);
    const snapshot = await views.snapshot({
      computerId: "computer-1",
      plan: plan(memory, playground),
      runtimeInstanceId: "runtime-1",
      skills: [],
      signal: new AbortController().signal,
    });
    const url = views.contentUrl("computer-1", 1);
    const get = (kind: string, id: string, at = url) =>
      views.handle(token(at), kind, id, new Request(`${at}/${kind}/${id}`));

    expect((await get("views", "c".repeat(64))).status).toBe(404);
    const forged = url.slice(0, -1) + (url.endsWith("A") ? "B" : "A");
    expect((await get("views", snapshot.viewDigest, forged)).status).toBe(404);
    const manifest = await (await get("views", snapshot.viewDigest)).json();
    const sha = manifest.mappings[0].files[0].sha256;

    await writeFile(path.join(memory, "MEMORY.md"), "second\n");
    expect((await get("files", sha)).status).toBe(409);

    current.clear();
    current.add("computer-1:2");
    expect((await get("views", snapshot.viewDigest)).status).toBe(404);
    const next = views.contentUrl("computer-1", 2);
    expect((await get("views", snapshot.viewDigest, next)).status).toBe(200);
  });

  it("names the shared Task scope in the manifest", async () => {
    const views = content();
    const snapshot = await views.snapshot({
      computerId: "computer-1",
      plan: {
        ...plan(await sourceRoot({}), await sourceRoot({})),
        sharedTaskScope: {
          version: 1,
          tenantId: "tenant-1",
          agentId: "agent-1",
          originRoomId: "room-1",
          role: "alter_ego",
          taskId: "task-1",
        },
      },
      runtimeInstanceId: "runtime-1",
      skills: [],
      signal: new AbortController().signal,
    });
    const url = views.contentUrl("computer-1", 1);
    const manifest = await (
      await views.handle(
        token(url),
        "views",
        snapshot.viewDigest,
        new Request(`${url}/views/${snapshot.viewDigest}`),
      )
    ).json();
    expect(validateManifest(manifest)).toBe(true);
    expect(manifest.shared_task_scope).toEqual({
      version: 1,
      tenant_id: "tenant-1",
      agent_id: "agent-1",
      origin_room_id: "room-1",
      role: "alter_ego",
      task_id: "task-1",
    });
  });

  it("keeps a View published until every snapshot of it is released", async () => {
    const memory = await sourceRoot({ "MEMORY.md": "kept\n" });
    const playground = await sourceRoot({});
    const views = content();
    const input = {
      computerId: "computer-1",
      plan: plan(memory, playground),
      runtimeInstanceId: "runtime-1",
      skills: [],
      signal: new AbortController().signal,
    };
    const first = await views.snapshot(input);
    const second = await views.snapshot(input);
    expect(second.viewDigest).toBe(first.viewDigest);
    const url = views.contentUrl("computer-1", 1);
    const status = async () =>
      (
        await views.handle(
          token(url),
          "views",
          first.viewDigest,
          new Request(`${url}/views/${first.viewDigest}`),
        )
      ).status;

    first.release();
    first.release();
    expect(await status()).toBe(200);
    second.release();
    expect(await status()).toBe(404);
  });
});
