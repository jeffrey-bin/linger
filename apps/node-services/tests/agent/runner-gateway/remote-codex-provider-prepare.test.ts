import { describe, expect, it, vi } from "vitest";

import type { ProviderSessionOptions } from "../../../src/agent/executor/provider.js";
import type { RunEvent as WireRunEvent } from "@linger/wire-contracts/runner-gateway/types";

import {
  RemoteCodexProvider,
  type RemoteCodexProviderOptions as RemoteRuntimeProviderOptions,
} from "../../../src/agent/runner-gateway/remote-codex-provider.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import type {
  RunnerOperation,
  RunnerOperationDispatcher,
  RunnerOperationTarget,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import type {
  RunnerProviderPrepareOptions,
  RunnerProviderPrepareTarget,
} from "../../../src/agent/runner-gateway/runner-operation.js";

const contextViewRef = { view_digest: "a".repeat(64) };

const resumedSession = { threadId: "thread-existing" };

const sessionOptions = (): ProviderSessionOptions => ({
  workingDirectory: "/must/not/cross/the/gateway",
  threadName: "Reviewer",
  model: "ignored-in-favor-of-runtime-placement",
  sandboxMode: "workspace-write",
  baseInstructions: "Review Room messages.",
  developerInstructions: "Be concise.",
  resources: { mcpServers: [] },
});

const target = {
  tenantId: "tenant-acme",
  runnerId: "runner-local",
  agentId: "agent-reviewer",
  workspaceGrantId: "grant-repo",
  executionContextKey: "context-1",
  runtimeInstanceId: "runtime-1",
};

class RecordingDispatcher implements RunnerOperationDispatcher {
  readonly starts: RunnerOperationTarget[] = [];
  readonly prepares: Array<{
    target: RunnerProviderPrepareTarget;
    options: RunnerProviderPrepareOptions;
  }> = [];
  prepareResult: { prepareId: string } | undefined = { prepareId: "prepare-1" };
  prepareImpl?: () => { prepareId: string } | undefined;
  onRunStart?: (target: RunnerOperationTarget) => void;

  async startOperation(
    operationTarget: RunnerOperationTarget,
  ): Promise<RunnerOperation> {
    this.starts.push(operationTarget);
    this.onRunStart?.(operationTarget);
    const events: WireRunEvent[] =
      operationTarget.request.kind === "run.start"
        ? [
            {
              type: "run.started",
              turn_id: "turn-1",
              session: resumedSession,
            },
          ]
        : [];
    return {
      operationId: `operation-${this.starts.length}`,
      events: (async function* () {
        yield* events;
      })(),
      result: new Promise(() => undefined),
      input: async (input) => ({ turnId: input.expectedTurnId }),
      cancel: async () => undefined,
    };
  }

  prepareProvider(
    prepareTarget: RunnerProviderPrepareTarget,
    options: RunnerProviderPrepareOptions,
  ): { prepareId: string } | undefined {
    this.prepares.push({ target: prepareTarget, options });
    return this.prepareImpl ? this.prepareImpl() : this.prepareResult;
  }
}

const createProvider = (
  dispatcher: RunnerOperationDispatcher,
  runtime: { type: "codex" | "claude" } = { type: "codex" },
  resolveGate?: Promise<void>,
  logger?: AgentLogger,
  reviews: Pick<
    RemoteRuntimeProviderOptions,
    "onHumanInteraction" | "onPermissionReview" | "beforePresencePrepare"
  > = {},
) =>
  new RemoteCodexProvider({
    dispatcher,
    logger,
    ...reviews,
    runtime: runtime,
    target: {
      ...target,
      roomId: undefined,
    } as never,
    contextRunResources: {
      async resolve() {
        await resolveGate;
        return { mcp_servers: [] };
      },
      currentContextViewRef: () => contextViewRef,
    },
  });

const runSpec = () => ({
  runContext: {
    executionRunRef: "run-1",
    sourceInboxIds: ["inbox-1"],
  },
});

const runStartTargets = (dispatcher: RecordingDispatcher) =>
  dispatcher.starts.filter(({ request }) => request.kind === "run.start");

const reviewedRun = {
  onHumanInteraction: async () => ({}),
  onPermissionReview: async () => ({}),
};

describe("RemoteCodexProvider provider prepare", () => {
  it("sends exactly one prepare whose identity matches the following run.start", async () => {
    const dispatcher = new RecordingDispatcher();
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    provider.prepareForAcceptedInput(session, { acceptedInputSinceMs: 0 });
    expect(dispatcher.prepares).toHaveLength(1);

    await provider.startRun(session, { type: "text", text: "work" }, runSpec());
    const [prepare] = dispatcher.prepares;
    const [start] = runStartTargets(dispatcher);
    expect(start).toBeDefined();
    if (start?.request.kind !== "run.start") throw new Error("no run.start");
    expect(prepare!.options.runtime).toEqual(start.request.runtime);
    expect(prepare!.options.sessionOptions).toEqual(
      start.request.session_options,
    );
    expect(prepare!.options.session).toEqual(start.request.session);
    expect(prepare!.options.contextViewRef).toEqual(
      (start as { readonly contextViewRef?: unknown }).contextViewRef,
    );
    expect(prepare!.target.executionContextKey).toBe("context-1");
    expect(prepare!.target.runnerId).toBe("runner-local");
  });

  it("sends the reviewed run's authorization flags with the prepare, as the run.start carries them", async () => {
    const dispatcher = new RecordingDispatcher();
    const provider = createProvider(
      dispatcher,
      { type: "codex" },
      undefined,
      undefined,
      reviewedRun,
    );
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    provider.prepareForAcceptedInput(session, { acceptedInputSinceMs: 0 });
    await provider.startRun(session, { type: "text", text: "work" }, runSpec());

    const [prepare] = dispatcher.prepares;
    const [start] = runStartTargets(dispatcher);
    if (start?.request.kind !== "run.start") throw new Error("no run.start");
    expect(prepare!.options.runContext).toEqual({
      human_interactions: true,
      permission_review: true,
    });
    expect(start.request).toMatchObject({
      run_context: prepare!.options.runContext,
    });
  });

  it("prepares a Codex first run, sends nothing for a Claude Runtime, and sends again on a repeated call", async () => {
    const codex = new RecordingDispatcher();
    const codexProvider = createProvider(codex);
    const firstRun = await codexProvider.createSession(sessionOptions());
    codexProvider.prepareForAcceptedInput(firstRun, {
      acceptedInputSinceMs: 0,
    });
    expect(codex.prepares).toHaveLength(1);

    const claude = new RecordingDispatcher();
    const claudeProvider = createProvider(claude, { type: "claude" });
    const claudeSession = await claudeProvider.resumeSession(
      {
        provider: "claude",
        sessionId: "uuid-1",
        lingerMaterialized: true,
      },
      sessionOptions(),
    );
    claudeProvider.prepareForAcceptedInput(claudeSession, {
      acceptedInputSinceMs: 0,
    });
    expect(claude.prepares).toHaveLength(0);

    const repeated = new RecordingDispatcher();
    const repeatedProvider = createProvider(repeated);
    const session = await repeatedProvider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );
    repeatedProvider.prepareForAcceptedInput(session, {
      acceptedInputSinceMs: 0,
    });
    repeatedProvider.prepareForAcceptedInput(session, {
      acceptedInputSinceMs: 0,
    });
    expect(repeated.prepares).toHaveLength(2);
  });

  it("sends nothing when the Computer does not negotiate prepare (old Daemon)", async () => {
    const dispatcher = new RecordingDispatcher();
    dispatcher.prepareResult = undefined;
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    provider.prepareForAcceptedInput(session, { acceptedInputSinceMs: 0 });
    expect(dispatcher.prepares).toHaveLength(1);

    await provider.startRun(session, { type: "text", text: "work" }, runSpec());
    expect(runStartTargets(dispatcher)).toHaveLength(1);
  });

  it("never throws or waits on a gateway that throws", async () => {
    const dispatcher = new RecordingDispatcher();
    dispatcher.prepareImpl = () => {
      throw new Error("gateway unavailable");
    };
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    expect(() =>
      provider.prepareForAcceptedInput(session, { acceptedInputSinceMs: 0 }),
    ).not.toThrow();
    expect(() => provider.prepareForPresence(session)).not.toThrow();
    await provider.startRun(session, { type: "text", text: "work" }, runSpec());
    expect(runStartTargets(dispatcher)).toHaveLength(1);
  });

  it("returns synchronously even when the gateway never settles", async () => {
    const dispatcher = new RecordingDispatcher();
    const spy = vi.spyOn(dispatcher, "prepareProvider");
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    const result = provider.prepareForAcceptedInput(session, {
      acceptedInputSinceMs: 0,
    });

    expect(result).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("RemoteCodexProvider presence prepare", () => {
  it("sends the reviewed run's authorization flags with a presence prepare", async () => {
    const dispatcher = new RecordingDispatcher();
    const provider = createProvider(
      dispatcher,
      { type: "codex" },
      undefined,
      undefined,
      reviewedRun,
    );
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    provider.prepareForPresence(session);
    expect(dispatcher.prepares[0]!.options.runContext).toEqual({
      human_interactions: true,
      permission_review: true,
    });
  });

  it("sends one prepare for the thread per presence hint", async () => {
    const dispatcher = new RecordingDispatcher();
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    provider.prepareForPresence(session);
    provider.prepareForPresence(session);

    expect(dispatcher.prepares).toHaveLength(2);
    expect(dispatcher.prepares[0]!.options.session).toMatchObject({
      threadId: "thread-existing",
    });
    expect(dispatcher.prepares[1]!.options.session).toMatchObject({
      threadId: "thread-existing",
    });
  });

  it("sends a Claude presence prepare with the conversation id the following run.start sends", async () => {
    const dispatcher = new RecordingDispatcher();
    const provider = createProvider(dispatcher, { type: "claude" });
    const session = await provider.resumeSession(
      {
        provider: "claude",
        sessionId: "12345678-1234-4234-8234-123456789012",
        lingerMaterialized: false,
      },
      sessionOptions(),
    );

    provider.prepareForPresence(session);
    expect(dispatcher.prepares).toHaveLength(1);

    await provider.startRun(session, { type: "text", text: "work" }, runSpec());
    const [start] = runStartTargets(dispatcher);
    if (start?.request.kind !== "run.start") throw new Error("no run.start");
    expect(dispatcher.prepares[0]!.options.session).toEqual(
      start.request.session,
    );
    expect(dispatcher.prepares[0]!.options.session).toMatchObject({
      sessionId: "12345678-1234-4234-8234-123456789012",
    });
  });

  it("prepares a Codex Context that has no thread yet with the session its first Run sends", async () => {
    const dispatcher = new RecordingDispatcher();
    const logger = { log: vi.fn(), child: () => logger };
    const provider = createProvider(dispatcher, undefined, undefined, logger);
    const firstRun = await provider.createSession(sessionOptions());
    let startSession: unknown;
    dispatcher.onRunStart = (operation) => {
      if (operation.request.kind === "run.start") {
        startSession = structuredClone(operation.request.session);
      }
    };

    provider.prepareForPresence(firstRun);

    expect(dispatcher.prepares).toHaveLength(1);
    expect(logger.log).not.toHaveBeenCalledWith(
      "info",
      "runner.provider.prepare_skipped",
      expect.anything(),
    );
    await provider.startRun(
      firstRun,
      { type: "text", text: "work" },
      runSpec(),
    );
    // The Daemon matches the first Run to the thread the prepare started by
    // the same session and inputs, so both carry no thread.
    expect(dispatcher.prepares[0]!.options.session).toEqual(startSession);
    expect(startSession).toMatchObject({ threadId: "" });
  });

  it("sends again after the gateway declines a prepare", async () => {
    const dispatcher = new RecordingDispatcher();
    dispatcher.prepareResult = undefined;
    const provider = createProvider(dispatcher);
    const session = await provider.resumeSession(
      { ...resumedSession },
      sessionOptions(),
    );

    provider.prepareForPresence(session);
    dispatcher.prepareResult = { prepareId: "prepare-2" };
    provider.prepareForPresence(session);
    provider.prepareForAcceptedInput(session, { acceptedInputSinceMs: 0 });

    expect(dispatcher.prepares).toHaveLength(3);
  });
});

describe("RemoteCodexProvider presence prepare after the CLI credential", () => {
  const claudeSession = (provider: RemoteCodexProvider) =>
    provider.resumeSession(
      {
        provider: "claude",
        sessionId: "12345678-1234-4234-8234-123456789012",
        lingerMaterialized: false,
      },
      sessionOptions(),
    );
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("presence prepare waits for the CLI credential", async () => {
    const dispatcher = new RecordingDispatcher();
    const credential = deferred();
    const hook = vi.fn(() => credential.promise);
    const provider = createProvider(
      dispatcher,
      { type: "claude" },
      undefined,
      undefined,
      { beforePresencePrepare: hook },
    );
    const session = await claudeSession(provider);

    provider.prepareForPresence(session);
    expect(hook).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(dispatcher.prepares).toHaveLength(0);

    credential.resolve();
    await flush();
    expect(dispatcher.prepares).toHaveLength(1);
  });

  it("sends nothing and logs why when the CLI credential is unavailable", async () => {
    const dispatcher = new RecordingDispatcher();
    const logger = { log: vi.fn(), child: () => logger };
    const provider = createProvider(
      dispatcher,
      { type: "claude" },
      undefined,
      logger,
      {
        beforePresencePrepare: () => Promise.reject(new Error("token=secret")),
      },
    );
    const session = await claudeSession(provider);

    expect(() => provider.prepareForPresence(session)).not.toThrow();
    await flush();

    expect(dispatcher.prepares).toHaveLength(0);
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "runner.provider.prepare_skipped",
      { source: "room_presence", reason: "cli_credential_unavailable" },
    );
  });

  it("sends nothing when the provider closed while waiting", async () => {
    const dispatcher = new RecordingDispatcher();
    const credential = deferred();
    const provider = createProvider(
      dispatcher,
      { type: "claude" },
      undefined,
      undefined,
      { beforePresencePrepare: () => credential.promise },
    );
    const session = await claudeSession(provider);

    provider.prepareForPresence(session);
    await provider.close();
    credential.resolve();
    await flush();

    expect(dispatcher.prepares).toHaveLength(0);
  });

  it("sends nothing when a Run started while waiting", async () => {
    const dispatcher = new RecordingDispatcher();
    const logger = { log: vi.fn(), child: () => logger };
    const credential = deferred();
    const provider = createProvider(
      dispatcher,
      { type: "claude" },
      undefined,
      logger,
      { beforePresencePrepare: () => credential.promise },
    );
    const session = await claudeSession(provider);

    provider.prepareForPresence(session);
    await provider.startRun(session, { type: "text", text: "work" }, runSpec());
    credential.resolve();
    await flush();

    expect(dispatcher.prepares).toHaveLength(0);
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "runner.provider.prepare_skipped",
      { source: "room_presence", reason: "run_active" },
    );
  });
});
