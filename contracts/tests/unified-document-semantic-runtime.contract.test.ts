import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  additionalProperties?: boolean;
  const?: string;
  discriminator?: {
    propertyName?: string;
    mapping?: Record<string, string>;
  };
  enum?: string[];
  items?: { oneOf?: Array<{ $ref?: string }> };
  maxItems?: number;
  minItems?: number;
  oneOf?: Array<{ $ref?: string }>;
  properties?: Record<
    string,
    Schema & { $ref?: string; uniqueItems?: boolean }
  >;
  required?: string[];
  type?: string;
  "x-max-encoded-bytes"?: number;
}

interface OpenAPI {
  paths?: Record<
    string,
    {
      post?: {
        operationId?: string;
        "x-deadline-ms"?: number;
        "x-idempotency"?: string;
        "x-idempotency-key"?: string;
      };
    }
  >;
}

const root = resolve(import.meta.dirname, "../openapi");

describe("Unified Document semantic mutation Runtime contract", () => {
  it("applies a semantic change to the live body under an optional expected sequence", async () => {
    const runtime = parse(
      await readFile(
        resolve(root, "node-services-internal/openapi.yaml"),
        "utf8",
      ),
    ) as OpenAPI;
    const operation =
      runtime.paths?.["/internal/v1/documents/{documentId}/apply"]?.post;

    expect(operation).toMatchObject({
      operationId: "applyDocumentChange",
      "x-deadline-ms": 30_000,
    });
  });

  it("fixes the strict semantic union, payload limits, and typed applied/conflicted result", async () => {
    const components = parse(
      await readFile(resolve(root, "components/document-runtime.yaml"), "utf8"),
    ) as { components?: { schemas?: Record<string, Schema> } };
    const schemas = components.components?.schemas ?? {};
    const request = schemas.SemanticDocumentChange;
    const operations = schemas.DocumentSemanticOperations;
    const result = schemas.ApplyDocumentChangeResult;

    expect(request).toMatchObject({
      additionalProperties: false,
      required: [
        "kind",
        "schema_version",
        "current_title",
        "allowed_document_asset_ids",
        "operations",
      ],
    });
    expect(
      schemas.ApplyDocumentChangeRequest?.properties?.expected_seq?.$ref,
    ).toBe("document-internal.yaml#/components/schemas/PersistedSequence");
    expect(request?.properties?.schema_version?.const).toBe(
      "blocknote-semantic-v1",
    );
    expect(request?.properties?.allowed_document_asset_ids).toMatchObject({
      maxItems: 4096,
      uniqueItems: true,
    });
    expect(operations).toMatchObject({
      minItems: 1,
      maxItems: 64,
      "x-max-encoded-bytes": 8 * 1024 * 1024,
    });
    expect(operations?.items?.oneOf).toHaveLength(10);
    expect(operations?.items?.discriminator).toEqual({
      propertyName: "kind",
      mapping: {
        edit_document:
          "#/components/schemas/EditNativeDocumentSemanticOperation",
        replace_body_blocks:
          "#/components/schemas/ReplaceDocumentBodyBlocksSemanticOperation",
        replace_body_html:
          "#/components/schemas/ReplaceDocumentBodyHTMLSemanticOperation",
        set_title: "#/components/schemas/SetDocumentTitleSemanticOperation",
        insert_blocks:
          "#/components/schemas/InsertDocumentBlocksSemanticOperation",
        append_blocks:
          "#/components/schemas/AppendDocumentBlocksSemanticOperation",
        replace_blocks:
          "#/components/schemas/ReplaceDocumentBlocksSemanticOperation",
        update_block:
          "#/components/schemas/UpdateDocumentBlockSemanticOperation",
        delete_blocks:
          "#/components/schemas/DeleteDocumentBlocksSemanticOperation",
        replace_comment_text:
          "#/components/schemas/ReplaceDocumentCommentTextSemanticOperation",
      },
    });
    expect(schemas.EditNativeDocumentSemanticOperation).toMatchObject({
      additionalProperties: false,
      required: ["kind", "parser_version", "command"],
      properties: {
        kind: { const: "edit_document" },
        parser_version: { const: "markdown-v1" },
        command: {
          enum: [
            "append",
            "str_replace",
            "block_insert_before",
            "block_insert_after",
            "block_replace",
            "block_delete",
            "set_title",
            "image_insert_after",
            "image_replace",
            "file_insert_after",
          ],
        },
        content: { maxLength: 262144 },
        pattern: { minLength: 1, maxLength: 262144 },
      },
    });
    expect(schemas.ReplaceDocumentBodyBlocksSemanticOperation).toMatchObject({
      additionalProperties: false,
      required: ["kind", "blocks"],
      properties: {
        kind: { const: "replace_body_blocks" },
        blocks: { $ref: "#/components/schemas/DocumentSemanticBlocks" },
      },
    });
    expect(schemas.ReplaceDocumentBodyHTMLSemanticOperation).toMatchObject({
      additionalProperties: false,
      required: ["kind", "html"],
      properties: {
        kind: { const: "replace_body_html" },
        html: { minLength: 1, "x-max-encoded-bytes": 1048576 },
      },
    });
    expect(schemas.AppendDocumentBlocksSemanticOperation).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["kind", "blocks"],
      properties: {
        kind: { type: "string", const: "append_blocks" },
        blocks: { $ref: "#/components/schemas/DocumentSemanticBlocks" },
      },
    });
    expect(schemas.ReplaceDocumentCommentTextSemanticOperation).toMatchObject({
      additionalProperties: false,
      required: ["kind", "thread_id", "replacement"],
      properties: {
        kind: { const: "replace_comment_text" },
        replacement: { minLength: 1, maxLength: 50_000 },
      },
    });
    expect(result).toMatchObject({
      discriminator: { propertyName: "status" },
    });
    expect(result?.oneOf).toEqual([
      { $ref: "#/components/schemas/AppliedDocumentChangeResult" },
      { $ref: "#/components/schemas/ConflictedDocumentChangeResult" },
    ]);
    expect(
      schemas.ConflictedDocumentChangeResult?.properties?.reason?.enum,
    ).toEqual([
      "stale_head",
      "text_not_found",
      "ambiguous_text",
      "missing_block",
      "duplicate_target",
      "noncontiguous_blocks",
      "invalid_structure",
      "missing_comment_selection",
      "ambiguous_comment_selection",
    ]);
  });
});
