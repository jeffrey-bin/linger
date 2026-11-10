// Generates and verifies every top-level contract listed in contractEntries.
// Generated files live only in typescript/src/generated/ and the Go package
// directories the entries name. Generation clears those directories first, so
// a removed contract or output leaves nothing behind; verification compares
// them whole and rejects any directory that no entry owns.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";

export interface ContractEntry {
  entrypoint: string;
  go?: { mode: "client" | "types"; package: string };
  // Kebab-case; names the TypeScript output and the handwritten client directory.
  id: string;
}

// Adding a top-level contract means adding one entry here.
export const contractEntries: ContractEntry[] = [
  {
    id: "teamhub-public",
    entrypoint: "contracts/openapi/teamhub-public/teamhub-api.openapi.yaml",
    go: { package: "teamhubpublic", mode: "types" },
  },
  {
    id: "teamhub-agent-api",
    entrypoint: "contracts/openapi/teamhub-agent-api/openapi.yaml",
    go: { package: "teamhubagentapi", mode: "types" },
  },
  {
    id: "teamhub-internal",
    entrypoint: "contracts/openapi/teamhub-internal/openapi.yaml",
    go: { package: "teamhubinternal", mode: "types" },
  },
  {
    id: "node-services-internal",
    entrypoint: "contracts/openapi/node-services-internal/openapi.yaml",
    go: { package: "nodeservicesinternal", mode: "client" },
  },
  {
    id: "linger-installer",
    entrypoint: "contracts/openapi/linger-installer/openapi.yaml",
  },
];

// Output layout, relative to the generated root (contracts/generated).
const typescriptGeneratedDirectory = "typescript/src/generated";

function typescriptGeneratedOutput(id: string) {
  return `${typescriptGeneratedDirectory}/${id}`;
}

function goGeneratedOutput(go: NonNullable<ContractEntry["go"]>) {
  return `go/${go.package}`;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const committedRoot = path.join(repositoryRoot, "contracts/generated");
const runnerGatewayOutput = `${typescriptGeneratedDirectory}/runner-gateway`;
// A dependency-free Go module so the Computer does not build against the
// OpenAPI server dependencies of the main generated Go module.
export const runnerGatewayGoOutput = "go/runnergateway";

function run(command: string, args: string[]) {
  execFileSync(command, args, { cwd: repositoryRoot, stdio: "inherit" });
}

export function generateContracts(
  outputRoot = committedRoot,
  buildRoot = path.join(repositoryRoot, ".contracts-build"),
  entries: ContractEntry[] = contractEntries,
) {
  // The Makefile pins the oapi-codegen version in this command.
  const oapiCodegen = process.env.OAPI_CODEGEN_COMMAND;
  if (!oapiCodegen) {
    throw new Error(
      "OAPI_CODEGEN_COMMAND is required; run make contracts-generate",
    );
  }
  rmSync(path.join(outputRoot, typescriptGeneratedDirectory), {
    force: true,
    recursive: true,
  });
  for (const entry of entries) {
    if (!entry.go) continue;
    rmSync(path.join(outputRoot, goGeneratedOutput(entry.go)), {
      force: true,
      recursive: true,
    });
  }
  rmSync(path.join(outputRoot, runnerGatewayGoOutput), {
    force: true,
    recursive: true,
  });
  mkdirSync(buildRoot, { recursive: true });

  for (const entry of entries) {
    const bundle = path.join(buildRoot, `${entry.id}.yaml`);
    run("pnpm", [
      "exec",
      "redocly",
      "bundle",
      entry.entrypoint,
      "--output",
      bundle,
    ]);
    const typescriptOutput = path.join(
      outputRoot,
      typescriptGeneratedOutput(entry.id),
    );
    mkdirSync(typescriptOutput, { recursive: true });
    run("pnpm", [
      "exec",
      "openapi-typescript",
      bundle,
      "-o",
      path.join(typescriptOutput, "types.ts"),
    ]);
    if (!entry.go) continue;
    const goOutput = path.join(outputRoot, goGeneratedOutput(entry.go));
    mkdirSync(goOutput, { recursive: true });
    run("sh", [
      "-c",
      `${oapiCodegen} "$@"`,
      "oapi-codegen",
      "-generate",
      // TeamHub mounts its own routes over the types; Go callers get a client.
      entry.go.mode === "client" ? "types,client" : "types",
      "-package",
      entry.go.package,
      "-o",
      path.join(goOutput, "openapi.gen.go"),
      bundle,
    ]);
  }

  run("pnpm", [
    "exec",
    "node",
    "contracts/codegen/generate-runner-contract.mjs",
    "--output",
    path.join(outputRoot, runnerGatewayOutput),
    "--go-output",
    path.join(outputRoot, runnerGatewayGoOutput),
  ]);
  run("pnpm", [
    "exec",
    "prettier",
    path.join(outputRoot, typescriptGeneratedDirectory),
    "--write",
  ]);
  run("gofmt", ["-w", path.join(outputRoot, "go")]);
}

function listDirectories(directory: string) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// Directories under the generated root that no contract entry owns: a
// retired contract's handwritten client or Go package, for example. Stale
// files inside typescript/src/generated show up in the whole-directory diff.
export function unownedGeneratedDirectories(
  root: string,
  entries: ContractEntry[] = contractEntries,
) {
  const contractIds = new Set(entries.map((entry) => entry.id));
  const goPackages = new Set(
    entries.flatMap((entry) => entry.go?.package ?? []),
  );
  return [
    ...listDirectories(path.join(root, "typescript/src"))
      .filter((name) => name !== "generated" && !contractIds.has(name))
      .map((name) => `typescript/src/${name}`),
    ...listDirectories(path.join(root, "go"))
      .filter(
        (name) =>
          !goPackages.has(name) && `go/${name}` !== runnerGatewayGoOutput,
      )
      .map((name) => `go/${name}`),
  ];
}

function collectReferences(value: unknown, references: string[] = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectReferences(child, references);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") references.push(child);
      else collectReferences(child, references);
    }
  }
  return references;
}

// OpenAPI files that generation would silently skip: a top-level document with
// no contract entry, a file no entrypoint reaches through $ref, and $refs that
// leave the OpenAPI tree or point at a remote URL. `root` is the repository
// root; entrypoints and the returned paths are relative to it.
export function openApiTreeFailures(
  root: string = repositoryRoot,
  entries: ContractEntry[] = contractEntries,
) {
  const openapiRoot = "contracts/openapi";
  const files = readdirSync(path.join(root, openapiRoot), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) =>
      path.posix.join(
        path.relative(root, entry.parentPath).replaceAll(path.sep, "/"),
        entry.name,
      ),
    );
  const documents = new Map(
    files.map((file) => [
      file,
      parse(readFileSync(path.join(root, file), "utf8")) as unknown,
    ]),
  );
  const failures: string[] = [];
  const reached = new Set<string>();
  const visit = (file: string) => {
    if (reached.has(file)) return;
    reached.add(file);
    if (!documents.has(file)) {
      failures.push(`${file} is referenced but does not exist`);
      return;
    }
    for (const reference of collectReferences(documents.get(file))) {
      const filePart = reference.split("#", 1)[0];
      if (!filePart) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), decodeURIComponent(filePart)),
      );
      if (
        /^[a-z][a-z0-9+.-]*:/iu.test(filePart) ||
        filePart.startsWith("/") ||
        !target.startsWith(`${openapiRoot}/`)
      ) {
        failures.push(`${file} reference ${reference} leaves ${openapiRoot}`);
        continue;
      }
      visit(target);
    }
  };
  for (const entry of entries) visit(entry.entrypoint);

  const entrypoints = new Set(entries.map((entry) => entry.entrypoint));
  for (const [file, document] of documents) {
    if (
      document &&
      typeof document === "object" &&
      "openapi" in document &&
      !entrypoints.has(file) &&
      !reached.has(file)
    ) {
      failures.push(`${file} is a top-level OpenAPI document with no entry`);
    } else if (!reached.has(file)) {
      failures.push(`${file} is not reachable from any contract entrypoint`);
    }
  }
  return failures;
}

export function verifyContracts(entries: ContractEntry[] = contractEntries) {
  const treeFailures = openApiTreeFailures(repositoryRoot, entries);
  if (treeFailures.length > 0) {
    throw new Error(
      [
        "OpenAPI files are not covered by contractEntries in contracts/codegen/contracts.ts:",
        ...treeFailures.map((failure) => `  ${failure}`),
      ].join("\n"),
    );
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "linger-contracts."));
  try {
    const outputRoot = path.join(scratch, "generated");
    generateContracts(outputRoot, path.join(scratch, "build"), entries);

    const failures = unownedGeneratedDirectories(committedRoot, entries).map(
      (directory) => `${directory} belongs to no contract`,
    );
    for (const directory of [
      typescriptGeneratedDirectory,
      runnerGatewayGoOutput,
      ...entries.flatMap((entry) =>
        entry.go ? [goGeneratedOutput(entry.go)] : [],
      ),
    ]) {
      try {
        run("diff", [
          "-ru",
          path.join(committedRoot, directory),
          path.join(outputRoot, directory),
        ]);
      } catch {
        failures.push(`${directory} differs from a fresh generation`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        [
          "Generated contracts are stale. Run make contracts-generate and delete leftover directories:",
          ...failures.map((failure) => `  contracts/generated/${failure}`),
        ].join("\n"),
      );
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const action = process.argv[2];
  try {
    if (action === "generate") {
      generateContracts();
    } else if (action === "verify") {
      verifyContracts();
    } else {
      throw new Error("Usage: contracts.ts <generate|verify>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
