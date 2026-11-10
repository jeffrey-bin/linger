import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  contractEntries,
  openApiTreeFailures,
  unownedGeneratedDirectories,
} from "../codegen/contracts";

describe("generated contract layout", () => {
  it("reports directories that no contract entry owns", () => {
    const root = mkdtempSync(path.join(tmpdir(), "generated-layout-"));
    try {
      for (const directory of [
        "typescript/src/generated/teamhub-public",
        "typescript/src/teamhub-public",
        "typescript/src/retired-contract",
        "go/teamhubpublic",
        "go/retiredpackage",
      ]) {
        mkdirSync(path.join(root, directory), { recursive: true });
      }

      expect(
        unownedGeneratedDirectories(root, [
          {
            id: "teamhub-public",
            entrypoint:
              "contracts/openapi/teamhub-public/teamhub-api.openapi.yaml",
            go: { package: "teamhubpublic", mode: "types" },
          },
        ]),
      ).toEqual(["typescript/src/retired-contract", "go/retiredpackage"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("finds no unowned directory in the committed tree", () => {
    const root = fileURLToPath(new URL("../generated", import.meta.url));
    expect(unownedGeneratedDirectories(root)).toEqual([]);
  });

  it("uses kebab-case ids and plain Go package names", () => {
    for (const entry of contractEntries) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/u);
      if (entry.go) expect(entry.go.package).toMatch(/^[a-z][a-z0-9]*$/u);
    }
  });

  it("reports OpenAPI files that no contract entry covers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-tree-"));
    try {
      const files: Record<string, string> = {
        "main/openapi.yaml":
          "openapi: 3.1.0\npaths:\n  /a:\n    $ref: ./paths.yaml#/a\n",
        "main/paths.yaml":
          "a:\n  $ref: https://example.com/x.yaml\nb:\n  $ref: ../../../outside.yaml\n",
        "new/openapi.yaml": "openapi: 3.1.0\n",
        "orphan.yaml": "type: object\n",
      };
      for (const [file, source] of Object.entries(files)) {
        const target = path.join(root, "contracts/openapi", file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, source);
      }

      expect(
        openApiTreeFailures(root, [
          { id: "main", entrypoint: "contracts/openapi/main/openapi.yaml" },
        ]).sort(),
      ).toEqual(
        [
          "contracts/openapi/main/paths.yaml reference https://example.com/x.yaml leaves contracts/openapi",
          "contracts/openapi/main/paths.yaml reference ../../../outside.yaml leaves contracts/openapi",
          "contracts/openapi/new/openapi.yaml is a top-level OpenAPI document with no entry",
          "contracts/openapi/orphan.yaml is not reachable from any contract entrypoint",
        ].sort(),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("covers every committed OpenAPI file", () => {
    expect(openApiTreeFailures()).toEqual([]);
  });
});
