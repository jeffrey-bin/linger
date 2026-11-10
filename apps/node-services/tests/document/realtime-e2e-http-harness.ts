import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface RealtimeE2EControl {
  cleanup(): Promise<void>;
  connectOwnerComputer(): Promise<void>;
  failNextAppendPermanently(): void;
  fireRoutineOccurrence(routineId: string): Promise<void>;
  fixture(): Record<string, unknown>;
  holdAppends(): void;
  isReady(): boolean;
  releaseAppends(): void;
  reset(): Promise<Record<string, unknown>>;
  startRuntime(): Promise<void>;
  state(): Record<string, unknown>;
  stop(): Promise<void>;
  stopRuntime(): Promise<void>;
}

export async function startRealtimeE2EHttpHarness(
  harness: RealtimeE2EControl,
  port: number,
): Promise<void> {
  const server = createServer((request, response) => {
    void handleRequest(harness, request, response);
  });
  await listen(server, port);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void harness
        .stop()
        .then(() => closeServer(server))
        .finally(() => process.exit(0));
    });
  }
}

async function handleRequest(
  harness: RealtimeE2EControl,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      if (harness.isReady()) {
        respondJson(response, { status: "ok" });
      } else {
        respondJson(response, { status: "starting" }, 503);
      }
      return;
    }
    if (request.method === "GET" && request.url === "/__e2e/fixture") {
      respondJson(response, harness.fixture());
      return;
    }
    if (request.method === "GET" && request.url === "/__e2e/state") {
      respondJson(response, harness.state());
      return;
    }
    if (request.method === "POST") {
      const handled = await handleControlRequest(harness, request.url);
      if (handled !== undefined) {
        respondJson(response, handled);
        return;
      }
    }
    respondJson(
      response,
      { code: "not_found", message: "Unexpected E2E operation" },
      404,
    );
  } catch (error) {
    respondJson(
      response,
      {
        code: "internal_error",
        message: describeError(error),
        retryable: false,
      },
      500,
    );
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  if (!(cause instanceof Error)) {
    return error.message;
  }
  const nested = cause.cause;
  const code =
    nested !== null && typeof nested === "object" && "code" in nested
      ? String(nested.code)
      : undefined;
  return [error.message, cause.message, code].filter(Boolean).join(": ");
}

async function handleControlRequest(
  harness: RealtimeE2EControl,
  path: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (path === "/__e2e/reset") {
    return harness.reset();
  }
  if (path === "/__e2e/cleanup") {
    await harness.cleanup();
    return { status: "clean" };
  }
  if (path === "/__e2e/computer/online") {
    await harness.connectOwnerComputer();
    return { status: "online" };
  }
  if (path === "/__e2e/runtime/stop") {
    await harness.stopRuntime();
    return harness.state();
  }
  if (path === "/__e2e/runtime/start") {
    await harness.startRuntime();
    return harness.state();
  }
  const routine = /^\/__e2e\/routines\/([A-Za-z0-9_-]+)\/fire$/.exec(
    path ?? "",
  );
  if (routine !== null) {
    await harness.fireRoutineOccurrence(routine[1]!);
    return { status: "due" };
  }
  if (path === "/__e2e/append/fail-next-permanently") {
    harness.failNextAppendPermanently();
    return { status: "armed" };
  }
  if (path === "/__e2e/append/hold") {
    harness.holdAppends();
    return { status: "holding" };
  }
  if (path === "/__e2e/append/release") {
    harness.releaseAppends();
    return { status: "released" };
  }
  return undefined;
}

export function respondJson(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: ReturnType<typeof createServer>, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
