import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  CommandExecutionContext,
  CommandInputReader,
} from "./command-definition.js";
import { parseArguments } from "./command-input.js";
import { documentCommandDefinitions } from "./document-commands.js";
import { documentImageCommandDefinitions } from "./document-image-commands.js";

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);
const definition = (...parts: string[]) =>
  [...documentCommandDefinitions, ...documentImageCommandDefinitions].find(
    (item) => item.command.join(" ") === parts.join(" "),
  )!;
const reader = (cwd: string): CommandInputReader => ({
  cwd,
  text: vi.fn(),
  json: vi.fn(),
});
const normalize = (cwd: string, parts: string[], args: string[]) => {
  const def = definition(...parts);
  return def.normalize(parseArguments(args, def.options), reader(cwd));
};

describe("docs image commands", () => {
  it("uploads the image, then places it with one operation identity", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "docs-image-"));
    await writeFile(path.join(cwd, "card.png"), png);
    const normalized = await normalize(
      cwd,
      ["docs", "image", "put"],
      [
        "document_one",
        "card.png",
        "--replace",
        "block_card",
        "--caption",
        "Blue",
      ],
    );
    expect(normalized.input).toMatchObject({
      document_id: "document_one",
      command: "image_replace",
      block_id: "block_card",
      caption: "Blue",
      filename: "card.png",
    });
    const request = vi.fn(async () =>
      Response.json({ asset_id: "document_asset_new", replayed: false }),
    );
    const POST = vi.fn(async () => ({
      data: {
        semantic_mutation_id: "mutation_one",
        status: "applied",
        revision_id: "revision_two",
      },
    }));
    const result = await definition("docs", "image", "put").execute!(
      normalized.input,
      {
        client: { request, api: { POST } },
        cwd,
        stateRoot: cwd,
        operationId: "operation_card_blue",
      } as unknown as CommandExecutionContext,
    );
    expect(request).toHaveBeenCalledWith(
      "/api/agent/v1/files/document_one/assets?filename=card.png&operation_id=operation_card_blue",
      expect.objectContaining({ method: "POST", body: png }),
    );
    expect(POST).toHaveBeenCalledWith(
      "/api/agent/v1/document-semantic-mutations",
      {
        body: expect.objectContaining({
          document_id: "document_one",
          semantic_change: [
            {
              kind: "edit_document",
              parser_version: "markdown-v1",
              command: "image_replace",
              block_id: "block_card",
              asset_id: "document_asset_new",
              caption: "Blue",
            },
          ],
        }),
        headers: { "x-teamhub-operation-id": "operation_card_blue" },
      },
    );
    expect(result).toEqual({
      document_id: "document_one",
      asset_id: "document_asset_new",
      status: "applied",
      revision_id: "revision_two",
    });
  });

  it("uploads a file and places it as a file block named after it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "docs-file-"));
    const pdf = Buffer.from("%PDF-1.7 proposal");
    await writeFile(path.join(cwd, "プラン.pdf"), pdf);
    const normalized = await normalize(
      cwd,
      ["docs", "file", "put"],
      ["document_one", "プラン.pdf", "--after", "block_signature"],
    );
    expect(normalized.input).toMatchObject({
      document_id: "document_one",
      block_id: "block_signature",
      filename: "プラン.pdf",
    });
    const request = vi.fn(async () =>
      Response.json({ asset_id: "document_asset_plan", replayed: false }),
    );
    const POST = vi.fn(async () => ({
      data: { status: "applied", revision_id: "revision_two" },
    }));
    const result = await definition("docs", "file", "put").execute!(
      normalized.input,
      {
        client: { request, api: { POST } },
        cwd,
        stateRoot: cwd,
        operationId: "operation_attach_plan",
      } as unknown as CommandExecutionContext,
    );
    expect(request).toHaveBeenCalledWith(
      `/api/agent/v1/files/document_one/assets?${new URLSearchParams({ filename: "プラン.pdf", operation_id: "operation_attach_plan" }).toString()}`,
      expect.objectContaining({ method: "POST", body: pdf }),
    );
    expect(POST).toHaveBeenCalledWith(
      "/api/agent/v1/document-semantic-mutations",
      expect.objectContaining({
        body: expect.objectContaining({
          semantic_change: [
            {
              kind: "edit_document",
              parser_version: "markdown-v1",
              command: "file_insert_after",
              block_id: "block_signature",
              asset_id: "document_asset_plan",
              name: "プラン.pdf",
            },
          ],
        }),
      }),
    );
    expect(result).toMatchObject({
      asset_id: "document_asset_plan",
      status: "applied",
    });
    await expect(
      normalize(cwd, ["docs", "file", "put"], ["document_one", "プラン.pdf"]),
    ).rejects.toThrow("--after");
  });

  it("rejects ambiguous placement and missing files before any request", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "docs-image-"));
    await writeFile(path.join(cwd, "card.png"), png);
    await expect(
      normalize(cwd, ["docs", "image", "put"], ["document_one", "card.png"]),
    ).rejects.toThrow("--after or --replace");
    await expect(
      normalize(
        cwd,
        ["docs", "image", "put"],
        ["document_one", "card.png", "--after", "a", "--replace", "b"],
      ),
    ).rejects.toThrow("--after or --replace");
    await expect(
      normalize(
        cwd,
        ["docs", "image", "put"],
        ["document_one", "missing.png", "--after", "a"],
      ),
    ).rejects.toThrow("regular image file");
  });

  it("saves an image block's original and never overwrites a file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "docs-image-"));
    const normalized = await normalize(
      cwd,
      ["docs", "image", "get"],
      ["document_one", "block_card"],
    );
    const request = vi.fn(async (endpoint: string) =>
      endpoint.endsWith("format=blocks")
        ? Response.json({
            schema_version: 1,
            blocks: [
              { id: "intro", type: "paragraph", children: [] },
              {
                id: "block_card",
                type: "image",
                props: { url: "document-asset:document_asset_old" },
              },
            ],
          })
        : new Response(png, {
            headers: {
              "x-document-filename":
                Buffer.from("card.png").toString("base64url"),
            },
          }),
    );
    const context = {
      client: { request },
      cwd,
      stateRoot: cwd,
    } as unknown as CommandExecutionContext;
    const get = definition("docs", "image", "get");
    expect(await get.execute!(normalized.input, context)).toEqual({
      document_id: "document_one",
      block_id: "block_card",
      asset_id: "document_asset_old",
      path: path.join(cwd, "card.png"),
      size_bytes: png.length,
    });
    expect(request).toHaveBeenLastCalledWith(
      "/api/agent/v1/files/document_one/assets/document_asset_old/content",
    );
    expect(await readFile(path.join(cwd, "card.png"))).toEqual(png);
    await expect(get.execute!(normalized.input, context)).rejects.toThrow(
      "already exists",
    );
  });

  it("lets docs update place an existing Asset", async () => {
    const normalized = await normalize(
      "/work",
      ["docs", "update"],
      [
        "document_one",
        "--command",
        "image_replace",
        "--block-id",
        "block_card",
        "--asset-id",
        "document_asset_old",
      ],
    );
    expect(normalized.input).toEqual({
      document_id: "document_one",
      command: "image_replace",
      block_id: "block_card",
      asset_id: "document_asset_old",
    });
  });
});
