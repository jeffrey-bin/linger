import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(entryPath);
      }
      return entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return files.flat();
};

describe("architecture boundaries", () => {
  it("isolates real Agent Service process tests from the parallel worker pool", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const vitestConfig = await readFile("vitest.config.ts", "utf8");

    expect(packageJson.scripts?.test).toBe("vitest run");
    expect(vitestConfig).toMatch(
      /const AGENT_PROCESS_TEST =\s+"tests\/agent\/executor\/agent-manager-process\.test\.ts";/,
    );
    // The process test is excluded from the agent project and runs alone in
    // the last sequence group, one file at a time.
    expect(vitestConfig).toContain(
      "exclude: [...configDefaults.exclude, AGENT_PROCESS_TEST]",
    );
    expect(vitestConfig).toMatch(
      /name: "agent-process",\s+include: \[AGENT_PROCESS_TEST\],\s+fileParallelism: false,\s+sequence: \{ groupOrder: 3 \}/,
    );
    expect(packageJson.scripts?.test).not.toContain("retry");
  });

  it("exposes AgentManagerApi without a Room message push seam", async () => {
    const contract = await readFile(
      "src/agent/executor/agent-manager-api.ts",
      "utf8",
    );
    const managerTypes = await readFile("src/agent/executor/types.ts", "utf8");

    expect(contract).toMatch(/\bAgentManagerApi\b/);
    expect(contract).not.toMatch(/\bRoomAgentApi\b/);
    expect(contract).not.toMatch(/\bHandleMessageAccepted\b/);
    expect(contract).not.toContain("/internal/");
    expect(contract).not.toMatch(
      /\b(?:ContextExecutor|AgentProvider|AgentRun)\b/,
    );
    expect(managerTypes).not.toMatch(/\bCreateAgentManagerOptions\b/);
  });

  it("keeps the executor leaf modules below the Context executor and the registry", async () => {
    // Imports each leaf module may make inside the executor; every other
    // relative import would point back into a caller.
    const allowed: Record<string, readonly string[]> = {
      "types.ts": [],
      "context-ref.ts": ["./types.js"],
      "ghost.ts": ["./context-ref.js", "./types.js"],
      "history.ts": [],
      "provider.ts": ["../../model-tasks.js", "./history.js"],
    };
    for (const [file, imports] of Object.entries(allowed)) {
      const source = await readFile(`src/agent/executor/${file}`, "utf8");
      const relativeImports = [...source.matchAll(/from "(\.[^"]+)"/g)]
        .map((match) => match[1])
        .sort();
      expect(relativeImports, file).toEqual(imports);
    }
  });

  it("keeps Runtime settings a leaf over Local placement parsing", async () => {
    const settings = await readFile("src/agent/runtime-settings.ts", "utf8");
    const placement = await readFile(
      "src/agent/runner-gateway/local-computer-management.ts",
      "utf8",
    );
    // Runtime settings parse placements through the Runner Gateway module;
    // that module must never depend back on Agent Runtime settings.
    const relativeImports = [...settings.matchAll(/from "(\.[^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(relativeImports).toEqual([
      "./runner-gateway/local-computer-management.js",
    ]);
    expect(placement).not.toContain("runtime-settings");
  });

  it("keeps standalone Agent bootstrap on the current composition root", async () => {
    const source = await readFile(
      "src/agent/bootstrap/bootstrap-agent-manager.ts",
      "utf8",
    );
    expect(source).not.toMatch(/\bCodexProvider\b/);
    expect(source).not.toMatch(/\bcreateShell\b/);
    expect(source).not.toMatch(/\bRuntimeRegistry\b/);
    expect(source).not.toMatch(/\bproviderFactory\b/);
    expect(source).not.toMatch(/\bcreateSqliteGhostStore\b/);
    expect(source).not.toMatch(/\bcreateSqliteAgentBindingStore\b/);
  });

  it("keeps the executor's own imports acyclic", async () => {
    const root = "src/agent/executor";
    const files = (await sourceFiles(root)).map((file) => path.normalize(file));
    const imports = new Map<string, string[]>();
    for (const file of files) {
      const source = await readFile(file, "utf8");
      imports.set(
        file,
        [...source.matchAll(/from "(\.[^"]+)\.js"/g)]
          .map((match) =>
            path.normalize(path.join(path.dirname(file), `${match[1]}.ts`)),
          )
          .filter((target) => files.includes(target)),
      );
    }
    const visiting: string[] = [];
    const visited = new Set<string>();
    const visit = (file: string) => {
      expect(visiting, `import cycle through ${file}`).not.toContain(file);
      if (visited.has(file)) return;
      visiting.push(file);
      for (const target of imports.get(file) ?? []) visit(target);
      visiting.pop();
      visited.add(file);
    };
    for (const file of files) visit(file);
  });

  it("lets the Runner Gateway read executor state but never the reverse", async () => {
    // The Runner Gateway's registry, connections, Context View content and
    // shared Task scope read the TeamHub Runtime state client.
    for (const file of await sourceFiles("src/agent/executor")) {
      const source = await readFile(file, "utf8");
      if (file.endsWith("application.ts") || file.endsWith("local-backend.ts"))
        continue;
      expect(source, file).not.toMatch(
        /from "\.\.\/runner-gateway\/(?:local-computer-registry|runner-connections)\.js"/,
      );
    }
  });

  it("keeps test-only dependency seams out of production APIs", async () => {
    for (const file of await sourceFiles("src/agent")) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("codexTransport");
      expect(source, file).not.toContain("idFactory");
      expect(source, file).not.toContain("CodexAppServerTransport");
      expect(source, file).not.toContain("StdioCodexAppServerTransport");
    }

    const manager = await readFile("src/agent/executor/registry.ts", "utf8");
    expect(manager).not.toContain("createAgentManagerWithDependencies");
    expect(manager).not.toContain("InProcessAgentManager");

    const httpServer = await readFile(
      "src/agent/executor/http/agent-manager-http-server.ts",
      "utf8",
    );
    expect(httpServer).not.toContain("runApi");
    expect(httpServer).not.toContain("run-command");
    expect(httpServer).not.toContain("startAgentRun");
  }, 15_000);

  it("keeps production Runtime persistence on the TeamHub backend", async () => {
    const productionBootstrap = await readFile(
      "src/agent/bootstrap/bootstrap-agent-manager.ts",
      "utf8",
    );
    expect(productionBootstrap).toMatch(
      /stateBackend:\s*\{\s*kind:\s*"teamhub",\s*client:\s*runtimeStateClient\s*\}/s,
    );
    expect(productionBootstrap).not.toContain("managerDatabasePath");
    expect(productionBootstrap).not.toMatch(/\bcreateSqlite/);

    for (const file of [
      "src/agent/executor/application.ts",
      "src/agent/executor/context-executor.ts",
    ]) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain('from "node:sqlite"');
      expect(source, file).not.toMatch(/\bcreateSqlite/);
      expect(source, file).not.toContain("runtime.sqlite");
    }

    const executor = await readFile(
      "src/agent/executor/context-executor.ts",
      "utf8",
    );
    expect(executor).toMatch(
      /readonly stateFactory:\s*ContextRuntimeStateFactory<TRuntimeSettings>;/,
    );

    const runtimeStatusPublisher = await readFile(
      "src/agent/executor/runtime-status.ts",
      "utf8",
    );
    const contextRef = await readFile(
      "src/agent/executor/context-ref.ts",
      "utf8",
    );
    expect(runtimeStatusPublisher).not.toContain("sqlite-runtime-status");
    expect(contextRef).not.toContain("sqlite-store");
  });
});
