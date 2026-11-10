import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { serviceCredential } from "@linger/service-kit/node";

const secretSeed = "test-seed-0123456789abcdef0123456789";
const serviceToken = serviceCredential("node-services-internal", {
  LINGER_SECRET_SEED: secretSeed,
})!;

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const children: ChildProcess[] = [];
const servers: Server[] = [];
const temporaryDirectories: string[] = [];
const PROCESS_TEST_TIMEOUT_MS = 15_000;
const PROCESS_WAIT_TIMEOUT_MS = Number(
  process.env.AGENT_PROCESS_TEST_TIMEOUT_MS ?? "10000",
);
if (
  !Number.isSafeInteger(PROCESS_WAIT_TIMEOUT_MS) ||
  PROCESS_WAIT_TIMEOUT_MS < 1
) {
  throw new TypeError(
    "AGENT_PROCESS_TEST_TIMEOUT_MS must be a positive safe integer",
  );
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopProcess));
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("AgentManager process", () => {
  it.each(["503", "timeout", "body-timeout"])(
    "keeps the real Agent Service alive and unready through a temporary epoch start %s",
    async (failure) => {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "agent-startup-retry-"),
      );
      temporaryDirectories.push(runtimeRoot);
      const environment = agentServiceEnvironment(runtimeRoot);
      const portProbe = createServer();
      await new Promise<void>((resolve) =>
        portProbe.listen(0, "127.0.0.1", resolve),
      );
      const port = (portProbe.address() as AddressInfo).port;
      await closeServer(portProbe);
      environment.NODE_SERVICES_HTTP_ADDRESS = `127.0.0.1:${port}`;
      let requested!: () => void;
      const firstStart = new Promise<void>((resolve) => {
        requested = resolve;
      });
      let starts = 0;
      environment.TEAMHUB_BASE_URL = await startTeamHubRuntimeStateStub({
        epochResponse: (response) => {
          starts++;
          if (starts > 1) {
            response.end(
              JSON.stringify({
                interrupted_run_ids: [],
                waiting_context_keys: [],
              }),
            );
            return;
          }
          requested();
          if (failure === "503") {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: { code: "unavailable" } }));
          }
          if (failure === "body-timeout") {
            response.writeHead(200);
            response.write('{"interrupted_run_ids":');
          }
          // A missing response or a stalled body exceeds the transport timeout.
        },
      });
      const child = startAgentManager(
        environment,
        "tests/agent/fixtures/agent-service-process.ts",
      );
      const pid = child.pid;
      const ready = waitForStartup(child);
      void ready.catch(() => undefined);
      await Promise.race([firstStart, ready]);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
      const address = await ready;
      expect(child.pid).toBe(pid);
      expect(child.exitCode).toBeNull();
      expect(starts).toBe(2);
      expect((await fetch(`${address}/readyz`)).status).toBe(200);
      expect((await fetch(`${address}/startupz`)).status).toBe(200);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([false, true])(
    "exits with a bounded result when stopping the real entrypoint (startup=%s)",
    async (duringStartup) => {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "agent-shutdown-main-"),
      );
      temporaryDirectories.push(runtimeRoot);
      const environment = agentServiceEnvironment(runtimeRoot);
      let requested!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        requested = resolve;
      });
      environment.TEAMHUB_BASE_URL = await startTeamHubRuntimeStateStub({
        blockReconcile: duringStartup ? requested : undefined,
      });
      const child = startAgentManager(environment);
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      let stopping!: () => void;
      const stopRequested = new Promise<void>((resolve) => {
        stopping = resolve;
      });
      // Observe early exits immediately, but measure shutdown only after SIGTERM.
      // Startup has its own watchdog and may fail before this Promise is awaited.
      const exit = waitForExit(child, stopRequested);
      void exit.catch(() => undefined);
      if (duringStartup)
        await Promise.race([
          requestStarted,
          exit.then((result) => {
            throw new Error(result.stderr);
          }),
        ]);
      else await waitForStartup(child);
      const started = performance.now();
      stopping();
      child.kill("SIGTERM");
      const result = await exit;
      expect(result.code, `${result.stderr}\n${output}`).toBe(0);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(result.stderr).not.toContain("shutdown.timeout");
      expect(output).toContain('"event":"shutdown.complete","exitCode":0');
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "stays ready when Local lifecycle initialization fails",
    async () => {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "mirror-agent-manager-"),
      );
      temporaryDirectories.push(runtimeRoot);
      const environment = agentServiceEnvironment(runtimeRoot);
      environment.TEAMHUB_BASE_URL = await startTeamHubRuntimeStateStub();
      environment.AGENT_RUNNER_PUBLIC_GATEWAY_URL =
        "ws://127.0.0.1:4319/v1/runner-gateway";

      const address = await waitForStartup(startAgentManager(environment));
      const ready = await fetch(`${address}/readyz`);

      expect(ready.status).toBe(200);
      const cancel = await fetch(
        `${address}/v1/agent-runs/missing-run/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceToken}`,
          },
          body: JSON.stringify({
            request_id: "cancel-bootstrap-check",
            run_id: "missing-run",
            context_ref: {
              kind: "meta",
              agent_id: "missing-agent",
              room_id: "missing-room",
            },
          }),
        },
      );
      expect(cancel.status).toBe(404);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "requires TeamHub readiness without probing the retired internal MCP service",
    async () => {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "mirror-agent-manager-"),
      );
      temporaryDirectories.push(runtimeRoot);
      let teamHubReady = true;
      const environment = agentServiceEnvironment(runtimeRoot);
      environment.TEAMHUB_BASE_URL = await startTeamHubRuntimeStateStub({
        healthReady: () => teamHubReady,
      });
      const address = await waitForStartup(startAgentManager(environment));
      expect((await fetch(`${address}/readyz`)).status).toBe(200);

      teamHubReady = false;
      const unavailable = await fetch(`${address}/readyz`);
      expect(unavailable.status).toBe(503);
      await expect(unavailable.json()).resolves.toEqual({
        reason: "teamhub_unavailable",
        status: "not_ready",
      });

      teamHubReady = true;
      const ready = await fetch(`${address}/readyz`);
      expect(ready.status).toBe(200);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "rejects an ephemeral port outside the test environment",
    async () => {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "mirror-agent-manager-"),
      );
      temporaryDirectories.push(runtimeRoot);
      const environment = agentServiceEnvironment(runtimeRoot);
      environment.NODE_ENV = "production";

      const result = await waitForExit(startAgentManager(environment));

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "NODE_SERVICES_HTTP_ADDRESS must be host:port with a port between 1 and 65535",
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

const agentServiceEnvironment = (runtimeRoot: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_SERVICES_HTTP_ADDRESS: "127.0.0.1:0",
    NODE_SERVICES_ROLES: "agent",
    LINGER_SECRET_SEED: secretSeed,
    AGENT_HOME: runtimeRoot,
    NODE_ENV: "test",
    TEAMHUB_BASE_URL: "http://127.0.0.1:1",
  };
  delete environment.AGENT_RUNNER_PUBLIC_GATEWAY_URL;
  return environment;
};

const startTeamHubRuntimeStateStub = async (
  options: {
    healthReady?: () => boolean;
    blockReconcile?: () => void;
    epochResponse?: (response: ServerResponse) => void;
  } = {},
): Promise<string> => {
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://fixture.local");
      if (
        request.method === "POST" &&
        url.pathname === "/v0/agent-runtime/epochs"
      ) {
        let rawBody = "";
        for await (const chunk of request) rawBody += chunk.toString();
        const body = JSON.parse(rawBody) as { epoch: string };
        expect(body.epoch).toMatch(/^agent-epoch-v1:\d{13}:[a-f0-9]{32}$/u);
        if (options.epochResponse) {
          options.epochResponse(response);
          return;
        }
        response.end(
          JSON.stringify({ interrupted_run_ids: [], waiting_context_keys: [] }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v0/agent-runtime/contexts/recently-used"
      ) {
        response.end(JSON.stringify({ contexts: [] }));
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        response.statusCode = options.healthReady?.() === false ? 503 : 200;
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v0/agent-runtime/contexts/reconcile"
      ) {
        if (options.blockReconcile) {
          options.blockReconcile();
          return;
        }
        response.end(
          JSON.stringify({
            examined_count: 0,
            existing_count: 0,
            created_count: 0,
            created_context_keys: [],
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url?.startsWith("/v0/agent-runtime/contexts")
      ) {
        response.end(JSON.stringify({ contexts: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const startAgentManager = (
  environment: NodeJS.ProcessEnv,
  entrypoint = "src/main.ts",
): ChildProcess => {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: packageRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
};

const waitForStartup = async (child: ChildProcess): Promise<string> => {
  let stdout = "";
  let stderr = "";
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`AgentManager startup timed out: ${stderr}`)),
      PROCESS_WAIT_TIMEOUT_MS,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/AgentManager API: (http:\/\/[^\s]+)/);
      const address = match?.[1];
      if (address) {
        clearTimeout(timeout);
        resolve(address);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`AgentManager exited before startup (${code}): ${stderr}`),
      );
    });
  });
};

const waitForExit = async (
  child: ChildProcess,
  timeoutStartsAfter: Promise<void> = Promise.resolve(),
): Promise<{ code: number | null; stderr: string }> => {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    let exited = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    void timeoutStartsAfter.then(() => {
      if (exited) return;
      timeout = setTimeout(
        () =>
          reject(new Error(`AgentManager did not reject startup: ${stderr}`)),
        PROCESS_WAIT_TIMEOUT_MS,
      );
    }, reject);
    child.once("exit", (code) => {
      exited = true;
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
};

const stopProcess = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

describe("Agent shutdown process supervisor", () => {
  it.each(["success", "slow-log", "failure", "hang", "startup"])(
    "bounds %s shutdown and reports its exit code",
    async (mode) => {
      const logRoot = await mkdtemp(
        path.join(os.tmpdir(), "agent-shutdown-logs-"),
      );
      temporaryDirectories.push(logRoot);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          ...(mode === "slow-log"
            ? ["--import", "./tests/agent/fixtures/slow-agent-log.mjs"]
            : []),
          "tests/agent/fixtures/agent-shutdown-process.ts",
          mode,
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            ...process.env,
            FIXTURE_LOG_DIRECTORY: logRoot,
            AGENT_LOG_LEVEL: "info",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      let output = "";
      let errors = "";
      const ready = deferred();
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("fixture-ready")) ready.resolve();
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const exited = once(child, "exit");
      await Promise.race([
        ready.promise,
        exited.then(() => {
          throw new Error(errors);
        }),
      ]);
      const started = performance.now();
      child.kill("SIGTERM");
      if (mode === "success") {
        // A second, different signal must not exit before cleanup finishes.
        let sent = false;
        child.stdout.on("data", () => {
          if (!sent && output.includes("fixture-closing")) {
            sent = true;
            child.kill("SIGINT");
          }
        });
      }
      const [code, signal] = await exited;
      expect(signal).toBeNull();
      expect(code).toBe(mode === "failure" || mode === "hang" ? 1 : 0);
      expect(performance.now() - started).toBeLessThan(3_000);
      if (mode === "slow-log") {
        expect(output).toContain('"state":"completed"');
        expect(errors).toContain('"reason":"drain_timeout"');
        expect(errors).not.toContain("shutdown.timeout");
      }
      if (mode === "hang")
        expect(JSON.parse(errors.trim()).pending).toContain("fixture");
      if (mode === "success") {
        expect(output).toContain('"state":"completed"');
        expect(
          await readFile(path.join(logRoot, "system/events.ndjson"), "utf8"),
        ).toContain('"event":"fixture.closed"');
      }
    },
    10_000,
  );
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
