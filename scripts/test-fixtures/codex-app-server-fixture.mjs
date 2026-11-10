import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-fixture 1.0.0\n");
  process.exit(0);
}

// Runtime discovery reads the model catalog before it admits Codex.
// codex-default names the Runtime's own default model.
if (process.argv[2] === "debug" && process.argv[3] === "models") {
  process.stdout.write(
    `${JSON.stringify({
      models: [
        {
          slug: "codex-default",
          display_name: "Codex default",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
      ],
    })}\n`,
  );
  process.exit(0);
}

const pidFileArgument = process.argv.indexOf("--pid-file");
const pidFile =
  pidFileArgument === -1 ? undefined : process.argv[pidFileArgument + 1];
const holdTurn = process.argv.includes("--hold-turn");
const alwaysDelay = process.argv.includes("--always-delay");
const persistThreads = process.argv.includes("--persist-threads");
const emptyThreadHistory = process.argv.includes("--empty-thread-history");
const pidDirectory = argumentValue("--pid-dir");
const pidRecordFile = pidDirectory
  ? path.join(pidDirectory, `${String(process.pid)}.pid`)
  : undefined;
const completionDelayMs = Number(argumentValue("--completion-delay-ms") ?? 0);
const postDeltaDelayMs = Number(argumentValue("--post-delta-delay-ms") ?? 0);
const workspaceMarker = argumentValue("--workspace-marker");
const observationFile = argumentValue("--observation-file");
const heldTurns = new Map();
const threadWorkspaces = new Map();
const threadStateFile = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "fixture-thread.json")
  : undefined;

if (!Number.isSafeInteger(completionDelayMs) || completionDelayMs < 0) {
  throw new Error("--completion-delay-ms must be a non-negative integer");
}
if (!Number.isSafeInteger(postDeltaDelayMs) || postDeltaDelayMs < 0) {
  throw new Error("--post-delta-delay-ms must be a non-negative integer");
}

if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
if (pidDirectory) {
  mkdirSync(pidDirectory, { recursive: true });
  writePidRecord();
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const turn = (id, status) => ({
  id,
  items: [],
  itemsView: "full",
  status,
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1_000,
});

const threadResponse = (id) => {
  const cwd =
    threadWorkspaces.get(id) ?? persistedThreadWorkspace(id) ?? process.cwd();
  return {
    thread: {
      id,
      extra: null,
      sessionId: "fixture-session",
      forkedFromId: null,
      parentThreadId: null,
      preview: "fixture",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: "0.150.1",
      source: "appServer",
      canAcceptDirectInput: null,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: emptyThreadHistory ? [] : [turn("turn-prior", "completed")],
    },
    model: "fixture-model",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) {
    continue;
  }
  if (request.method === "initialize") {
    send({
      id: request.id,
      result: {
        codexHome:
          process.env.CODEX_HOME ?? path.join(process.env.HOME, ".codex"),
        platformFamily: "unix",
        platformOs: process.platform,
        userAgent: "linger-fixture",
      },
    });
  } else if (request.method === "model/list") {
    send({
      id: request.id,
      result: {
        data: [
          {
            id: "codex-default",
            model: "codex-default",
            displayName: "Codex default",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
        ],
        nextCursor: null,
      },
    });
  } else if (request.method === "config/read") {
    send({
      id: request.id,
      result: {
        config: { features: { memories: false, memory_tool: false } },
        origins: {},
        layers: null,
      },
    });
  } else if (request.method === "account/read") {
    send({
      id: request.id,
      result: { account: null, requiresOpenaiAuth: false },
    });
  } else if (request.method === "thread/start") {
    writeObservation(request);
    const workspace = request.params.cwd ?? process.cwd();
    threadWorkspaces.set("thread-created", workspace);
    writePidRecord(workspace);
    if (persistThreads) {
      if (!threadStateFile) {
        throw new Error("Fixture requires CODEX_HOME");
      }
      persistThread("thread-created");
    }
    send({ id: request.id, result: threadResponse("thread-created") });
  } else if (request.method === "thread/read") {
    if (
      persistThreads &&
      !persistedThreadIds().includes(request.params.threadId)
    ) {
      send({
        id: request.id,
        error: { code: -32001, message: "Fixture thread is unavailable" },
      });
      continue;
    }
    const { thread } = threadResponse(request.params.threadId);
    send({
      id: request.id,
      result: {
        thread: {
          ...thread,
          turns: request.params.includeTurns ? thread.turns : [],
        },
      },
    });
  } else if (request.method === "thread/resume") {
    writeObservation(request);
    if (
      persistThreads &&
      (!threadStateFile ||
        !existsSync(threadStateFile) ||
        !persistedThreadIds().includes(request.params.threadId))
    ) {
      send({
        id: request.id,
        error: { code: -32001, message: "Fixture thread is unavailable" },
      });
      continue;
    }
    const workspace =
      request.params.cwd ??
      threadWorkspaces.get(request.params.threadId) ??
      persistedThreadWorkspace(request.params.threadId) ??
      process.cwd();
    threadWorkspaces.set(request.params.threadId, workspace);
    if (persistThreads) persistThread(request.params.threadId);
    writePidRecord(workspace);
    send({
      id: request.id,
      result: threadResponse(request.params.threadId),
    });
  } else if (
    request.method === "thread/name/set" ||
    request.method === "config/mcpServer/reload"
  ) {
    send({ id: request.id, result: {} });
  } else if (request.method === "thread/fork") {
    const forkedThreadId = `${request.params.threadId}-fork`;
    threadWorkspaces.set(
      forkedThreadId,
      threadWorkspaces.get(request.params.threadId) ?? process.cwd(),
    );
    if (persistThreads) {
      persistThread(forkedThreadId);
    }
    send({
      id: request.id,
      result: threadResponse(forkedThreadId),
    });
  } else if (request.method === "thread/unsubscribe") {
    send({ id: request.id, result: {} });
  } else if (request.method === "turn/start") {
    const threadId = request.params.threadId;
    const activeTurn = turn("turn-fixture", "inProgress");
    const delta = structuredOutput(request.params.outputSchema, threadId);
    send({ id: request.id, result: { turn: activeTurn } });
    send({ method: "turn/started", params: { threadId, turn: activeTurn } });
    if (holdTurn) {
      heldTurns.set(threadId, activeTurn.id);
      continue;
    }
    if (
      !request.params.outputSchema &&
      request.params.input?.some(
        (item) => item.type === "text" && item.text.includes("[hold]"),
      )
    ) {
      heldTurns.set(threadId, activeTurn.id);
      continue;
    }
    if (
      (alwaysDelay || !request.params.outputSchema) &&
      completionDelayMs > 0
    ) {
      await delay(completionDelayMs);
    }
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId,
        turnId: activeTurn.id,
        itemId: "message-fixture",
        delta,
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId: activeTurn.id,
        completedAtMs: 2,
        item: {
          type: "agentMessage",
          id: "message-fixture",
          text: delta,
          phase: "final_answer",
        },
      },
    });
    if ((alwaysDelay || !request.params.outputSchema) && postDeltaDelayMs > 0) {
      await delay(postDeltaDelayMs);
    }
    send({
      method: "turn/completed",
      params: { threadId, turn: turn(activeTurn.id, "completed") },
    });
  } else if (request.method === "turn/interrupt") {
    send({ id: request.id, result: {} });
    const turnId = heldTurns.get(request.params.threadId);
    if (turnId) {
      heldTurns.delete(request.params.threadId);
      send({
        method: "turn/completed",
        params: {
          threadId: request.params.threadId,
          turn: turn(turnId, "interrupted"),
        },
      });
    }
  } else {
    send({
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported fixture method: ${request.method}`,
      },
    });
  }
}

function writeObservation(request) {
  if (!observationFile) return;
  writeFileSync(
    observationFile,
    JSON.stringify({
      cwd: process.cwd(),
      home: process.env.HOME ?? null,
      xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
      path: process.env.PATH ?? null,
      sshAuthSock: process.env.SSH_AUTH_SOCK ?? null,
      ambient: process.env.USER_AMBIENT_SENTINEL ?? null,
      lingerInternalVisible: process.env.LINGER_INTERNAL_SENTINEL !== undefined,
      codexHome: process.env.CODEX_HOME ?? null,
      sandbox: request.params.sandbox ?? null,
      approvalPolicy: request.params.approvalPolicy ?? null,
    }),
  );
}

function structuredOutput(outputSchema, threadId) {
  if (!outputSchema) {
    const marker = workspaceMarker
      ? readFileSync(
          path.join(
            threadWorkspaces.get(threadId) ?? process.cwd(),
            workspaceMarker,
          ),
          "utf8",
        ).trim()
      : null;
    return marker ? `fixture complete:${marker}` : "fixture complete";
  }
  return JSON.stringify({ relevant: true });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function writePidRecord(workspace) {
  if (pidRecordFile) {
    writeFileSync(
      pidRecordFile,
      JSON.stringify({ pid: process.pid, workspace: workspace ?? null }),
    );
  }
}

function persistThread(threadId) {
  if (!threadStateFile) {
    throw new Error("Fixture requires CODEX_HOME");
  }
  mkdirSync(path.dirname(threadStateFile), { recursive: true });
  const ids = new Set(persistedThreadIds());
  ids.add(threadId);
  const workspaces = Object.fromEntries(
    [...ids].map((id) => [
      id,
      threadWorkspaces.get(id) ?? persistedThreadWorkspace(id) ?? process.cwd(),
    ]),
  );
  writeFileSync(threadStateFile, JSON.stringify({ ids: [...ids], workspaces }));
}

function persistedThreadIds() {
  if (!threadStateFile || !existsSync(threadStateFile)) {
    return [];
  }
  const state = JSON.parse(readFileSync(threadStateFile, "utf8"));
  if (Array.isArray(state.ids)) {
    return state.ids.filter((value) => typeof value === "string");
  }
  return typeof state.id === "string" ? [state.id] : [];
}

function persistedThreadWorkspace(threadId) {
  if (!threadStateFile || !existsSync(threadStateFile)) {
    return undefined;
  }
  const state = JSON.parse(readFileSync(threadStateFile, "utf8"));
  const cwd = state.workspaces?.[threadId];
  return typeof cwd === "string" ? cwd : undefined;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
