import { getRequestListener } from "@hono/node-server";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import {
  createDocumentBodyStore,
  type DocumentBodyStore,
} from "../../src/document/bodies.js";
import {
  createDocumentComputationPool,
  type DocumentComputation,
} from "../../src/document/computation-pool.js";
import { createDocumentRealtimeServer } from "../../src/document/realtime.js";
import {
  RealTeamHubFixtureManager,
  type RoomDocumentE2EFixture,
} from "./realtime-e2e-fixture.js";
import type { RealtimeE2EControl } from "./realtime-e2e-http-harness.js";
import { sleep } from "@linger/service-kit";
import { serviceCredential } from "@linger/service-kit/node";

type RealtimeServer = ReturnType<typeof createDocumentRealtimeServer>;

interface RuntimeProcess {
  server: RealtimeServer;
  sockets: Set<Socket>;
}

export interface RealRealtimeE2EConfig {
  runtimePort: number;
  teamHubPort: number;
  teamHubStartupTimeoutMs: number;
  // Extra command-line arguments for the TeamHub server.
  teamHubArgs?: string[];
}

const runtimeInstanceId = "document_runtime_e2e";
const secretSeed = "e2e-document-runtime-secret-seed-0123456789";
const teamHubToRuntimeToken = serviceCredential("node-services-internal", {
  LINGER_SECRET_SEED: secretSeed,
})!;
const connectionTokenKey = serviceCredential("document-connection-token", {
  LINGER_SECRET_SEED: secretSeed,
})!;

export class RealRealtimeE2EEnvironment implements RealtimeE2EControl {
  readonly #config: RealRealtimeE2EConfig;
  readonly #teamHubDirectory = resolve(
    fileURLToPath(new URL("../../../teamhub", import.meta.url)),
  );
  readonly #teamHubBaseUrl: string;
  #artifactRoot: string | undefined;
  #bodies: DocumentBodyStore | undefined;
  #sessionOpenSuccesses = 0;
  #failNextAppend = false;
  #fixtureManager: RealTeamHubFixtureManager | undefined;
  #holdAppends = false;
  #heldAppends: Array<() => void> = [];
  #persistedSequence = 0;
  #computation: DocumentComputation | undefined;
  #ready = false;
  #runtime: RuntimeProcess | undefined;
  #teamHub: ChildProcess | undefined;
  #fixture: RoomDocumentE2EFixture | undefined;

  constructor(config: RealRealtimeE2EConfig) {
    this.#config = config;
    this.#teamHubBaseUrl = `http://127.0.0.1:${config.teamHubPort}`;
  }

  async startTeamHub(): Promise<void> {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      throw new TypeError(
        "TEST_DATABASE_URL is required from the managed TeamHub test database runner",
      );
    }
    this.#artifactRoot = await mkdtemp(
      join(tmpdir(), "linger-room-document-e2e-"),
    );
    this.#bodies = createDocumentBodyStore(databaseUrl);
    this.#fixtureManager = new RealTeamHubFixtureManager({
      artifactRoot: this.#artifactRoot,
      baseUrl: this.#teamHubBaseUrl,
      databaseUrl,
    });
    const environment = {
      ...process.env,
      TEAMHUB_ARTIFACT_STORAGE_ROOT: this.#artifactRoot,
      TEAMHUB_DATABASE_URL: databaseUrl,
      TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN: this.#teamHubBaseUrl,
      LINGER_SECRET_SEED: secretSeed,
      TEAMHUB_DOCUMENT_RUNTIME_URL: `http://127.0.0.1:${this.#config.runtimePort}`,
      TEAMHUB_HTTP_ADDRESS: `127.0.0.1:${this.#config.teamHubPort}`,
    };
    await runTeamHubCommand(
      this.#teamHubDirectory,
      "./cmd/migrate",
      environment,
    );
    await runTeamHubCommand(this.#teamHubDirectory, "./cmd/demo-seed", {
      ...environment,
      TEAMHUB_DEMO_IDENTITIES_ONLY: "true",
      TEAMHUB_SEED_DEVELOPMENT_DATA: "true",
    });
    const teamHubCommand = resolveTeamHubCommand("./cmd/teamhub", environment);
    this.#teamHub = spawn(
      teamHubCommand.command,
      [...teamHubCommand.args, ...(this.#config.teamHubArgs ?? [])],
      {
        cwd: this.#teamHubDirectory,
        env: teamHubServeEnvironment(environment),
        stdio: "inherit",
      },
    );
    this.#teamHub.once("exit", (code, signal) => {
      if (!this.#ready || this.#teamHub === undefined) {
        return;
      }
      console.error(
        `Real TeamHub E2E process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      );
      process.exitCode = 1;
    });
    await waitForHttp(
      `${this.#teamHubBaseUrl}/healthz`,
      this.#config.teamHubStartupTimeoutMs,
    );
    if (process.env.VERIFY_ROOM_STARTUP_PRODUCTION === "1") {
      await this.#fixtureManager.seedStartupDirectory();
    }
    await this.#fixtureManager.probePartialCleanup();
  }

  markReady(): void {
    this.#ready = true;
  }

  isReady(): boolean {
    return this.#ready;
  }

  fixture(): Record<string, unknown> {
    if (this.#fixture === undefined) {
      throw new Error("Room Document E2E fixture has not been created");
    }
    return this.#fixture;
  }

  async reset(): Promise<Record<string, unknown>> {
    await this.cleanup();
    await this.startRuntime();
    this.#sessionOpenSuccesses = 0;
    this.#failNextAppend = false;
    this.#persistedSequence = 0;
    this.releaseAppends();
    this.#fixture = await this.#requireFixtureManager().create();
    return this.#fixture;
  }

  async cleanup(): Promise<void> {
    this.releaseAppends();
    const fixture = this.#fixture;
    if (fixture === undefined) {
      return;
    }
    await this.stopRuntime();
    await this.#requireFixtureManager().cleanup(fixture);
    this.#fixture = undefined;
  }

  async startRuntime(): Promise<void> {
    if (this.#runtime !== undefined) {
      return;
    }
    const server = createDocumentRealtimeServer({
      connectionTokenKey,
      hostname: "127.0.0.1",
      port: this.#config.runtimePort,
      runtimeInstanceId,
      bodies: this.#faultInjectingBodies(),
    });
    this.#computation ??= createDocumentComputationPool({ size: 1 });
    const app = createDocumentRuntimeApp({
      changes: server.changes,
      computation: this.#computation,
      disconnect: (documentId, actorId) =>
        server.disconnect(documentId, actorId),
      teamHubToken: teamHubToRuntimeToken,
    });
    server.httpServer.removeAllListeners("request");
    const listener = getRequestListener(app.fetch);
    server.httpServer.on("request", (request, response) => {
      void listener(request, response);
    });
    const sockets = new Set<Socket>();
    server.httpServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    this.#runtime = { server, sockets };
    try {
      await server.listen();
      await waitForHttp(
        `http://127.0.0.1:${this.#config.runtimePort}/readyz`,
        15_000,
      );
    } catch (error) {
      await this.stopRuntime();
      throw error;
    }
  }

  async stopRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime === undefined) {
      return;
    }
    for (const socket of runtime.sockets) {
      socket.destroy();
    }
    runtime.sockets.clear();
    await runtime.server.destroy();
  }

  async stop(): Promise<void> {
    this.#ready = false;
    this.releaseAppends();
    await this.stopRuntime();
    await this.cleanup();
    const computation = this.#computation;
    this.#computation = undefined;
    await computation?.close();
    const teamHub = this.#teamHub;
    this.#teamHub = undefined;
    if (teamHub !== undefined) {
      await stopChild(teamHub);
    }
    const fixtureManager = this.#fixtureManager;
    this.#fixtureManager = undefined;
    if (fixtureManager !== undefined) {
      await fixtureManager.close();
    }
    const artifactRoot = this.#artifactRoot;
    this.#artifactRoot = undefined;
    if (artifactRoot !== undefined) {
      await rm(artifactRoot, { force: true, recursive: true });
    }
    const bodies = this.#bodies;
    this.#bodies = undefined;
    await bodies?.close();
  }

  #requireFixtureManager(): RealTeamHubFixtureManager {
    if (this.#fixtureManager === undefined) {
      throw new Error("Room Document E2E fixture manager is not initialized");
    }
    return this.#fixtureManager;
  }

  state(): Record<string, unknown> {
    return {
      persisted_seq: this.#persistedSequence,
      session_open_success_count: this.#sessionOpenSuccesses,
    };
  }

  connectOwnerComputer(): Promise<void> {
    return this.#requireFixtureManager().connectOwnerComputer();
  }

  fireRoutineOccurrence(routineId: string): Promise<void> {
    return this.#requireFixtureManager().fireRoutineOccurrence(routineId);
  }

  failNextAppendPermanently(): void {
    this.#failNextAppend = true;
  }

  holdAppends(): void {
    this.#holdAppends = true;
  }

  releaseAppends(): void {
    this.#holdAppends = false;
    for (const release of this.#heldAppends.splice(0)) {
      release();
    }
  }

  // The Runtime's body store on the E2E database, with the control API's
  // save holds and injected rejections in front of it.
  #faultInjectingBodies(): DocumentBodyStore {
    const bodies = this.#bodies;
    if (bodies === undefined) {
      throw new Error("Room Document E2E body store is not initialized");
    }
    return {
      load: async (documentId) => {
        const loaded = await bodies.load(documentId);
        if (loaded !== undefined) this.#sessionOpenSuccesses += 1;
        return loaded;
      },
      save: async (input) => {
        await this.#waitForAppendRelease();
        if (this.#failNextAppend) {
          this.#failNextAppend = false;
          return { kind: "rejected" };
        }
        const result = await bodies.save(input);
        if (result.kind === "saved") this.#persistedSequence = result.seq;
        return result;
      },
      findOperation: (documentId, operationId) =>
        bodies.findOperation(documentId, operationId),
      checkReferences: (input) => bodies.checkReferences(input),
      close: async () => undefined,
    };
  }

  async #waitForAppendRelease(): Promise<void> {
    if (!this.#holdAppends) {
      return;
    }
    await new Promise<void>((resolve) => this.#heldAppends.push(resolve));
  }
}

const teamHubBinaryVariables = {
  "./cmd/migrate": "ROOM_DOCUMENT_E2E_MIGRATE_BINARY",
  "./cmd/demo-seed": "ROOM_DOCUMENT_E2E_DEMO_SEED_BINARY",
  "./cmd/teamhub": "ROOM_DOCUMENT_E2E_TEAMHUB_BINARY",
} as const;

// Browser journeys never read built-in Skills or Agent templates, so skip
// their install and fsync-heavy object writes (most of TeamHub's boot under
// CI IO load) through TeamHub's existing startup switch. The production
// startup proof seeds a Skill directory and keeps the full install.
export function teamHubServeEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return environment.VERIFY_ROOM_STARTUP_PRODUCTION === "1"
    ? environment
    : { ...environment, TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION: "1" };
}

export function resolveTeamHubCommand(
  mainPackage: string,
  environment: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  const variable =
    teamHubBinaryVariables[mainPackage as keyof typeof teamHubBinaryVariables];
  const binary = variable ? environment[variable]?.trim() : undefined;
  return binary
    ? { command: binary, args: [] }
    : { command: "go", args: ["run", mainPackage] };
}

async function runTeamHubCommand(
  directory: string,
  mainPackage: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const resolved = resolveTeamHubCommand(mainPackage, environment);
  const child = spawn(resolved.command, resolved.args, {
    cwd: directory,
    env: environment,
    stdio: "inherit",
  });
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  if (code !== 0) {
    throw new Error(
      `${resolved.command} ${resolved.args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
    );
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    once(child, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });
}
