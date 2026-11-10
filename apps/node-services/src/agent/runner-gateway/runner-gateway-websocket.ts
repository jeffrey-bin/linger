import { ComputerDaemonIdentityStaleError } from "./daemon-identity-verifier.js";
import {
  isComputerVersionAtLeast,
  MINIMUM_COMPUTER_VERSION,
  FIRST_PROTOCOL_2_COMPUTER_VERSION,
  MINIMUM_CURRENT_COMPUTER_VERSION,
} from "./local-computer-management.js";
import { logAgentEvent } from "../observability/agent-log.js";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import type {
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_FRAME_LIMITS,
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseDaemonToAgentEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";

import type { OperationEnvelope } from "./runner-operation.js";
import {
  RunnerGatewayProtocolError,
  RunnerUpgradeRequiredError,
  type InvalidOperationFrame,
  type RunnerGateway,
  type RunnerGatewayConnection,
  type RunnerGatewayPeer,
  type RunnerGatewayWriteGuard,
} from "./runner-gateway.js";
import type {
  RunnerCredentialAuthenticator,
  RunnerGatewayCredential,
} from "./runner-credential-authority.js";

export interface AttachRunnerGatewayWebSocketOptions {
  readonly server: Server;
  readonly gateway: RunnerGateway;
  readonly credentialAuthenticators: readonly RunnerCredentialAuthenticator[];
  readonly path?: string;
  readonly rejectUnmatchedUpgrades?: boolean;
  readonly helloTimeoutMs?: number;
  readonly onSessionError?: (
    error: unknown,
    context: RunnerSessionErrorContext,
  ) => void;
}

export interface RunnerSessionErrorContext {
  readonly computerId: string;
  readonly phase: string;
  readonly agentId?: string;
}

export interface RunnerGatewayWebSocketHandle {
  close(): Promise<void>;
}

const DEFAULT_PATH = "/v1/runner-gateway";
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_QUEUED_FRAMES = 1_024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
export const RUNNER_UPGRADE_REQUIRED_CLOSE_REASON =
  "upgrade_required: rerun the Linger Computer installer";
// Every Computer release that can update itself declares this in its hello.
const SELF_UPDATE_CAPABILITY = "self_update_v2";

export const attachRunnerGatewayWebSocket = (
  options: AttachRunnerGatewayWebSocketOptions,
): RunnerGatewayWebSocketHandle => {
  const path = options.path ?? DEFAULT_PATH;
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new TypeError("Runner Gateway WebSocket path must be absolute");
  }
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  if (!Number.isSafeInteger(helloTimeoutMs) || helloTimeoutMs < 1) {
    throw new TypeError("Runner Gateway hello timeout must be positive");
  }
  const credentials = new CredentialCatalog(options.credentialAuthenticators);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: RUNNER_GATEWAY_FRAME_LIMITS.maxBytes,
    perMessageDeflate: false,
  });
  const sessions = new Set<RunnerSocketSession>();
  let closePromise: Promise<void> | undefined;
  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void handleUpgrade(request, socket, head).catch(() => {
      rejectUpgrade(socket, 503, "Service Unavailable");
    });
  };
  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    let requestPath: string;
    try {
      requestPath = new URL(request.url ?? "", "http://agent.local").pathname;
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (requestPath !== path) {
      if (options.rejectUnmatchedUpgrades) {
        rejectUpgrade(socket, 404, "Not Found");
      }
      return;
    }
    const authorization = request.headers.authorization;
    const authentication = await credentials.authenticate(authorization);
    if (authentication.status === "unavailable") {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const credential = authentication.credential;
    if (!credential) {
      rejectUpgrade(socket, 401, "Unauthorized", {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      const session = new RunnerSocketSession({
        webSocket,
        gateway: options.gateway,
        credential,
        // TeamHub checked the credential at upgrade. A renewal or removal
        // replaces or closes this connection, so later frames check expiry.
        credentialStatus: async () =>
          credentialIsActive(credential) ? "active" : "revoked",
        helloTimeoutMs,
        onClose: () => sessions.delete(session),
        onError: options.onSessionError,
      });
      sessions.add(session);
      session.start();
    });
  };
  options.server.on("upgrade", onUpgrade);

  return {
    close: () => {
      closePromise ??= (async () => {
        options.server.off("upgrade", onUpgrade);
        await Promise.all([...sessions].map((session) => session.close()));
        await new Promise<void>((resolve) =>
          webSocketServer.close(() => resolve()),
        );
      })();
      return closePromise;
    },
  };
};

export class CredentialCatalog {
  readonly #authenticators: readonly RunnerCredentialAuthenticator[];

  constructor(authenticators: readonly RunnerCredentialAuthenticator[]) {
    this.#authenticators = [...authenticators];
  }

  async authenticate(
    header: string | undefined,
  ): Promise<CredentialAuthentication> {
    try {
      for (const authenticator of this.#authenticators) {
        const credential = await authenticator.authenticate(header);
        if (
          credential &&
          credentialIsComplete(credential) &&
          credentialIsActive(credential)
        ) {
          return { status: "active", credential };
        }
      }
      return { status: "revoked", credential: null };
    } catch {
      return { status: "unavailable", credential: null };
    }
  }
}

export type CredentialStatus = "active" | "revoked" | "unavailable";

export type CredentialAuthentication =
  | { readonly status: "active"; readonly credential: RunnerGatewayCredential }
  | {
      readonly status: "revoked" | "unavailable";
      readonly credential: null;
    };

const credentialIsComplete = (credential: RunnerGatewayCredential): boolean => {
  const tenantIds = new Set(
    credential.tenantOwners.map(({ tenantId }) => tenantId),
  );
  return (
    credential.runnerId.length > 0 &&
    credential.token.length > 0 &&
    Number.isSafeInteger(credential.credentialGeneration) &&
    credential.tenantOwners.length > 0 &&
    (credential.expiresAtMs === undefined ||
      (Number.isSafeInteger(credential.expiresAtMs) &&
        credential.expiresAtMs > 0)) &&
    tenantIds.size === credential.tenantOwners.length &&
    credential.tenantOwners.every(
      ({ tenantId, ownerActorId }) =>
        tenantId.length > 0 && ownerActorId.length > 0,
    )
  );
};

const credentialIsActive = (credential: RunnerGatewayCredential): boolean =>
  credential.expiresAtMs === undefined || credential.expiresAtMs > Date.now();

// The transport surface a Runner session needs; a WebSocket satisfies it.
export interface RunnerSocket {
  readonly readyState: number;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): unknown;
  once(event: "close", listener: (code: number) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export class RunnerSocketSession {
  #firstFrameSeen = false;
  // An older Computer that only receives the release to update itself to.
  #outdated = false;
  readonly #webSocket: RunnerSocket;
  readonly #gateway: RunnerGateway;
  readonly #credential: RunnerGatewayCredential;
  readonly #credentialStatus: () => Promise<CredentialStatus>;
  readonly #helloTimeoutMs: number;
  readonly #onClose: () => void;
  readonly #onError?: AttachRunnerGatewayWebSocketOptions["onSessionError"];
  readonly #frames: Array<
    {
      readonly bytes: number;
      readonly receivedAtMs: number;
    } & (
      | {
          readonly envelope: DaemonToAgentEnvelope;
          readonly invalid?: never;
          readonly invalidDebugCommandId?: never;
        }
      | {
          readonly invalid: InvalidOperationFrame;
          readonly envelope?: never;
          readonly invalidDebugCommandId?: never;
        }
      | {
          readonly invalidDebugCommandId: string;
          readonly envelope?: never;
          readonly invalid?: never;
        }
    )
  > = [];
  #queuedBytes = 0;
  #lastFrameReceivedAtMs?: number;
  #processingFrame?: { type: string; startedAtMs: number; agentId?: string };
  #draining = false;
  #closed = false;
  #droppedAfterCloseLogged = false;
  #gatewayConnection?: RunnerGatewayConnection;
  #helloTimer?: ReturnType<typeof setTimeout>;
  #credentialExpiryTimer?: ReturnType<typeof setTimeout>;
  #closeTimer?: ReturnType<typeof setTimeout>;

  constructor(options: {
    readonly webSocket: RunnerSocket;
    readonly gateway: RunnerGateway;
    readonly credential: RunnerGatewayCredential;
    readonly credentialStatus: () => Promise<CredentialStatus>;
    readonly helloTimeoutMs: number;
    readonly onClose: () => void;
    readonly onError?: AttachRunnerGatewayWebSocketOptions["onSessionError"];
  }) {
    this.#webSocket = options.webSocket;
    this.#gateway = options.gateway;
    this.#credential = options.credential;
    this.#credentialStatus = options.credentialStatus;
    this.#helloTimeoutMs = options.helloTimeoutMs;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
  }

  start(): void {
    this.#webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#webSocket.close(1003, "Binary frames are unsupported");
        return;
      }
      try {
        this.#enqueue(toUtf8(data));
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#webSocket.once("close", (code) => {
      logAgentEvent("info", "runner.connection.closed", {
        computerId: this.#credential.runnerId,
        closeCode: code,
        lastFrameReceivedAtMs: this.#lastFrameReceivedAtMs,
        queuedFrames: this.#frames.length,
        queuedBytes: this.#queuedBytes,
        processingFrameType: this.#processingFrame?.type,
        processingElapsedMs: this.#processingFrame
          ? Date.now() - this.#processingFrame.startedAtMs
          : undefined,
      });
      this.#finish();
    });
    this.#webSocket.once("error", () => this.#finish());
    this.#helloTimer = setTimeout(
      () => this.#closeProtocol(1002, "runner.hello timed out"),
      this.#helloTimeoutMs,
    );
    this.#helloTimer.unref();
    this.#armCredentialExpiry();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const closed = onceClosed(this.#webSocket);
    this.#webSocket.close(1001, "Agent Service shutting down");
    const timer = setTimeout(() => this.#webSocket.terminate(), 1_000);
    timer.unref();
    await closed;
    clearTimeout(timer);
  }

  #enqueue(value: string): void {
    if (this.#isClosingOrClosed()) {
      this.#logDroppedAfterClose();
      return;
    }
    // An outdated Computer keeps speaking its own protocol until it has
    // updated and reconnected; nothing it sends is read.
    if (this.#outdated) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (
      this.#frames.length >= MAX_QUEUED_FRAMES ||
      this.#queuedBytes + bytes > MAX_QUEUED_BYTES
    ) {
      this.#webSocket.close(1009, "Runner frame queue is exhausted");
      return;
    }
    const firstFrame = !this.#firstFrameSeen;
    this.#firstFrameSeen = true;
    let envelope: DaemonToAgentEnvelope;
    try {
      envelope = decodeFrame(value);
    } catch (error) {
      if (error instanceof OutdatedComputerHelloError && firstFrame) {
        this.#outdated = true;
        void this.#answerOutdatedComputer(error.hello).catch(
          (failure: unknown) => this.#fail(failure),
        );
        return;
      }
      if (error instanceof ComputerReinstallRequiredError && firstFrame) {
        // Later frames wait here and are dropped when the socket closes.
        this.#draining = true;
        void this.#requireReinstall().catch((failure: unknown) =>
          this.#fail(failure),
        );
        return;
      }
      if (!(error instanceof InvalidRunnerFrameError)) throw error;
      logAgentEvent("error", "runner.frame.invalid", {
        computerId: this.#credential.runnerId,
        frameType: error.frameType,
        operationId: error.operationId,
        sequence: error.sequence,
        bytes: error.bytes,
        schemaErrors: error.details,
      });
      // Before runner.hello there is no Operation or command to settle it in.
      if (!this.#gatewayConnection) throw error;
      const invalid = error.operationFrame
        ? {
            invalid: { frame: error.operationFrame, details: error.details },
          }
        : error.debugCommandId
          ? { invalidDebugCommandId: error.debugCommandId }
          : undefined;
      if (!invalid) throw error;
      this.#lastFrameReceivedAtMs = Date.now();
      this.#frames.push({
        ...invalid,
        bytes,
        receivedAtMs: this.#lastFrameReceivedAtMs,
      });
      this.#queuedBytes += bytes;
      if (!this.#draining) {
        this.#draining = true;
        void this.#drain().catch((drainError: unknown) =>
          this.#fail(drainError),
        );
      }
      return;
    }
    this.#lastFrameReceivedAtMs = Date.now();
    // Transport liveness must not wait behind durable writes or event consumer
    // backpressure. Credential checks and business effects stay serialized below.
    this.#gatewayConnection?.recordActivity(envelope);
    this.#frames.push({
      envelope,
      bytes,
      receivedAtMs: this.#lastFrameReceivedAtMs,
    });
    this.#queuedBytes += bytes;
    if (!this.#draining) {
      this.#draining = true;
      void this.#drain().catch((error: unknown) => this.#fail(error));
    }
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      const frame = this.#frames.shift();
      if (!frame) {
        this.#draining = false;
        return;
      }
      this.#queuedBytes -= frame.bytes;
      const frameType = frame.invalid
        ? "operation.invalid"
        : frame.invalidDebugCommandId !== undefined
          ? "debug.invalid"
          : frame.envelope.type;
      if (this.#dropFramesAfterClose(frameType)) {
        return;
      }
      this.#processingFrame = {
        type: frameType,
        startedAtMs: Date.now(),
        agentId:
          frame.envelope && "agent_id" in frame.envelope
            ? frame.envelope.agent_id
            : undefined,
      };
      if (!(await this.#checkCredential())) {
        return;
      }
      // The socket may have left OPEN while credential verification was pending.
      if (this.#dropFramesAfterClose(frameType)) {
        return;
      }
      if (frame.invalid) {
        if (!this.#gatewayConnection) {
          throw new RunnerGatewayProtocolError(
            "Invalid Runner Gateway envelope",
          );
        }
        await this.#gatewayConnection.receiveInvalidOperation(frame.invalid);
        this.#processingFrame = undefined;
        continue;
      }
      if (frame.invalidDebugCommandId !== undefined) {
        if (!this.#gatewayConnection) {
          throw new RunnerGatewayProtocolError(
            "Invalid Runner Gateway envelope",
          );
        }
        this.#gatewayConnection.receiveInvalidDebugInspection(
          frame.invalidDebugCommandId,
        );
        this.#processingFrame = undefined;
        continue;
      }
      const envelope = frame.envelope;
      if (!this.#gatewayConnection) {
        this.#clearHelloTimer();
        if (envelope.type !== "runner.hello") {
          throw new RunnerGatewayProtocolError(
            "First Runner frame must be runner.hello",
          );
        }
        assertCredentialClaims(this.#credential, envelope);
        try {
          this.#gatewayConnection = await this.#gateway.acceptConnection(
            {
              runnerId: this.#credential.runnerId,
              tenantOwners: this.#credential.tenantOwners,
              credentialGeneration: this.#credential.credentialGeneration,
            },
            envelope,
            new WebSocketPeer(
              this.#webSocket,
              this.#credentialStatus,
              (code, reason) => this.#closeProtocol(code, reason),
            ),
          );
        } catch (error) {
          if (error instanceof ComputerDaemonIdentityStaleError) {
            logAgentEvent("warn", "runner.identity_proof.stale", {
              computerId: this.#credential.runnerId,
              staleReason: error.reason,
              sentAt: error.sentAt,
              clientFieldsVerified: false,
              frameReceivedAtUnixMs: frame.receivedAtMs,
              verifiedAtUnixMs: error.serverTimeMs,
              differenceMs: error.differenceMs,
              proofMaxAgeMs: error.proofMaxAgeMs,
              queueElapsedMs: Math.max(
                0,
                this.#processingFrame.startedAtMs - frame.receivedAtMs,
              ),
              verificationElapsedMs: Math.max(
                0,
                error.serverTimeMs - this.#processingFrame.startedAtMs,
              ),
              daemonVersion: envelope.daemon_version,
              protocolVersion: envelope.protocol_version,
            });
          }
          throw error;
        }
        if (this.#isClosingOrClosed()) {
          this.#gatewayConnection.disconnect();
          return;
        }
        logAgentEvent("info", "runner.hello.accepted", {
          computerId: this.#credential.runnerId,
          daemonVersion: envelope.daemon_version,
          protocolVersion: envelope.protocol_version,
        });
        this.#processingFrame = undefined;
        continue;
      }
      const processingStartedAtMs = this.#processingFrame.startedAtMs;
      const receiveStartedAtMs = Date.now();
      await this.#gatewayConnection.receive(envelope);
      const receiveEndedAtMs = Date.now();
      if (
        envelope.type === "operation.event" &&
        envelope.event.type === "run.started"
      ) {
        logAgentEvent("info", "runner.operation.run_started_frame", {
          computerId: this.#credential.runnerId,
          operationId: envelope.operation_id,
          sequence: envelope.seq,
          receivedAtUnixMs: frame.receivedAtMs,
          processingStartedAtUnixMs: processingStartedAtMs,
          queueWaitMs: Math.max(0, processingStartedAtMs - frame.receivedAtMs),
          credentialCheckMs: Math.max(
            0,
            receiveStartedAtMs - processingStartedAtMs,
          ),
          receiveMs: receiveEndedAtMs - receiveStartedAtMs,
          queuedFramesAfter: this.#frames.length,
        });
      }
      this.#processingFrame = undefined;
    }
  }

  async #requireReinstall(): Promise<void> {
    this.#clearHelloTimer();
    this.#processingFrame = { type: "runner.hello", startedAtMs: Date.now() };
    if (!(await this.#checkCredential())) return;
    await this.#gateway.requireComputerReinstall({
      runnerId: this.#credential.runnerId,
      tenantOwners: this.#credential.tenantOwners,
      credentialGeneration: this.#credential.credentialGeneration,
    });
    throw new ComputerReinstallRequiredError();
  }

  async #answerOutdatedComputer(hello: OutdatedHello): Promise<void> {
    this.#clearHelloTimer();
    this.#processingFrame = { type: "runner.hello", startedAtMs: Date.now() };
    if (!(await this.#checkCredential())) return;
    if (hello.runnerId !== this.#credential.runnerId) {
      throw new RunnerCredentialScopeError();
    }
    const welcome = await this.#gateway.acceptOutdatedComputer(
      {
        runnerId: this.#credential.runnerId,
        tenantOwners: this.#credential.tenantOwners,
        credentialGeneration: this.#credential.credentialGeneration,
      },
      hello,
    );
    if (this.#isClosingOrClosed()) return;
    this.#webSocket.send(JSON.stringify(welcome), () => undefined);
    this.#processingFrame = undefined;
    logAgentEvent("info", "runner.hello.outdated", {
      computerId: this.#credential.runnerId,
      daemonVersion: hello.daemonVersion,
      protocolVersion: hello.protocolVersion,
    });
  }

  #isClosingOrClosed(): boolean {
    return this.#closed || this.#webSocket.readyState !== WebSocket.OPEN;
  }

  // Frames that arrive after the gateway starts closing the socket are stale
  // transport leftovers, not Runner protocol or service failures.
  #dropFramesAfterClose(frameType: string): boolean {
    if (!this.#isClosingOrClosed()) {
      return false;
    }
    this.#frames.length = 0;
    this.#queuedBytes = 0;
    this.#processingFrame = undefined;
    this.#draining = false;
    this.#logDroppedAfterClose(frameType);
    return true;
  }

  #logDroppedAfterClose(frameType?: string): void {
    if (this.#droppedAfterCloseLogged) {
      return;
    }
    this.#droppedAfterCloseLogged = true;
    logAgentEvent("info", "runner.frame.dropped_after_close", {
      computerId: this.#credential.runnerId,
      frameType,
      readyState: this.#webSocket.readyState,
    });
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#onError?.(error, {
      computerId: this.#credential.runnerId,
      phase: this.#processingFrame?.type ?? "session.transport",
      agentId: this.#processingFrame?.agentId,
    });
    if (error instanceof RunnerUpgradeRequiredError) {
      this.#closeProtocol(1008, RUNNER_UPGRADE_REQUIRED_CLOSE_REASON);
      return;
    }
    this.#closeProtocol(
      error instanceof RunnerCredentialScopeError
        ? 1008
        : error instanceof RunnerGatewayProtocolError
          ? 1002
          : 1011,
      error instanceof RunnerCredentialScopeError
        ? "Runner credential scope violation"
        : error instanceof RunnerGatewayProtocolError
          ? "Runner protocol violation"
          : "Runner service failure",
    );
  }

  async #checkCredential(): Promise<boolean> {
    const status = await this.#credentialStatus();
    if (status === "active") return true;
    this.#closeProtocol(
      status === "revoked" ? 1008 : 1011,
      status === "revoked"
        ? "Runner credential revoked"
        : "Runner credential verification unavailable",
    );
    return false;
  }

  #closeProtocol(code: number, reason: string): void {
    if (this.#closed || this.#webSocket.readyState === WebSocket.CLOSED) {
      return;
    }
    this.#webSocket.close(code, reason);
    this.#closeTimer ??= setTimeout(
      () => this.#webSocket.terminate(),
      CLOSE_TIMEOUT_MS,
    );
    this.#closeTimer.unref();
  }

  #clearHelloTimer(): void {
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = undefined;
    }
  }

  #armCredentialExpiry(): void {
    if (this.#credential.expiresAtMs === undefined || this.#closed) {
      return;
    }
    const remainingMs = this.#credential.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      this.#closeProtocol(1008, "Runner credential expired");
      return;
    }
    this.#credentialExpiryTimer = setTimeout(
      () => this.#armCredentialExpiry(),
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
    this.#credentialExpiryTimer.unref();
  }

  #finish(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#clearHelloTimer();
    if (this.#credentialExpiryTimer) {
      clearTimeout(this.#credentialExpiryTimer);
      this.#credentialExpiryTimer = undefined;
    }
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    this.#frames.length = 0;
    this.#queuedBytes = 0;
    this.#gatewayConnection?.disconnect();
    this.#onClose();
  }
}

export class WebSocketPeer implements RunnerGatewayPeer {
  constructor(
    private readonly webSocket: RunnerSocket,
    private readonly credentialStatus: () => Promise<CredentialStatus>,
    private readonly closeProtocol: (code: number, reason: string) => void,
  ) {}

  async send(
    envelope: AgentToDaemonEnvelope,
    guardWrite?: RunnerGatewayWriteGuard,
  ): Promise<void> {
    const credentialStatus = await this.credentialStatus();
    if (credentialStatus !== "active") {
      const unavailable = credentialStatus === "unavailable";
      const reason = unavailable
        ? "Runner credential verification unavailable"
        : "Runner credential revoked";
      this.closeProtocol(unavailable ? 1011 : 1008, reason);
      throw new Error(reason);
    }
    if (this.webSocket.readyState !== WebSocket.OPEN) {
      throw new Error("Runner WebSocket is closed");
    }
    let sent: Promise<void> | undefined;
    const write = () => {
      sent = new Promise<void>((resolve, reject) => {
        this.webSocket.send(JSON.stringify(envelope), (error) => {
          if (error) {
            reject(new Error("Runner WebSocket send failed"));
            return;
          }
          resolve();
        });
      });
      // The write callback can fail while the guard releases its lock.
      void sent.catch(() => undefined);
    };
    if (guardWrite) await guardWrite(write);
    else write();
    await sent;
  }

  close(code: number, reason: string): void {
    this.closeProtocol(code, reason);
  }
}

class RunnerCredentialScopeError extends Error {}

const assertCredentialClaims = (
  credential: RunnerGatewayCredential,
  hello: RunnerHello,
): void => {
  const tenants = new Set(
    credential.tenantOwners.map(({ tenantId }) => tenantId),
  );
  if (
    hello.runner_id !== credential.runnerId ||
    hello.workspace_grants.some((grant) => !tenants.has(grant.tenant_id)) ||
    hello.agent_runners.some(
      (agentRunner) => !tenants.has(agentRunner.tenant_id),
    ) ||
    hello.active_operations.some(
      (operation) => !tenants.has(operation.tenant_id),
    )
  ) {
    throw new RunnerCredentialScopeError();
  }
};

const decodeFrame = (value: string): DaemonToAgentEnvelope => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new RunnerGatewayProtocolError("Runner frame must be valid JSON");
  }
  if (
    typeof decoded === "object" &&
    decoded !== null &&
    "type" in decoded &&
    decoded.type === "runner.hello"
  ) {
    assertCurrentComputerHello(decoded);
  }
  try {
    return parseDaemonToAgentEnvelope(decoded);
  } catch (error) {
    throw new InvalidRunnerFrameError(decoded, value, error);
  }
};

// A Computer below MINIMUM_COMPUTER_VERSION cannot update itself.
class ComputerReinstallRequiredError extends RunnerUpgradeRequiredError {}

interface OutdatedHello {
  readonly runnerId: unknown;
  readonly protocolVersion: string;
  readonly daemonVersion: string;
}

// A Computer that can update itself but is not the current protocol and
// release; it is answered only with target_release.
class OutdatedComputerHelloError extends Error {
  constructor(readonly hello: OutdatedHello) {
    super("Local Computer runs an older Runner protocol");
  }
}

const OLDER_PROTOCOL_VERSION = /^1\.[0-9]{1,3}$/;

// Sorts a hello before schema validation: an older protocol cannot pass it.
// A Computer below the reinstall floor, or one that cannot update itself, is
// told to reinstall; one that can update itself is answered with the release.
// Every protocol 2 release updates itself from `target_release`, so a
// protocol change ships by raising MINIMUM_CURRENT_COMPUTER_VERSION.
const assertCurrentComputerHello = (hello: object): void => {
  const fields = hello as Record<string, unknown>;
  const daemonVersion = fields.daemon_version;
  if (
    typeof daemonVersion !== "string" ||
    !isComputerVersionAtLeast(daemonVersion, MINIMUM_COMPUTER_VERSION) ||
    typeof fields.protocol_version !== "string"
  ) {
    throw new ComputerReinstallRequiredError();
  }
  if (
    fields.protocol_version === RUNNER_GATEWAY_PROTOCOL_VERSION &&
    isComputerVersionAtLeast(daemonVersion, MINIMUM_CURRENT_COMPUTER_VERSION)
  ) {
    return;
  }
  const updatable =
    fields.protocol_version === RUNNER_GATEWAY_PROTOCOL_VERSION
      ? isComputerVersionAtLeast(
          daemonVersion,
          FIRST_PROTOCOL_2_COMPUTER_VERSION,
        )
      : OLDER_PROTOCOL_VERSION.test(fields.protocol_version) &&
        Array.isArray(fields.capabilities) &&
        fields.capabilities.includes(SELF_UPDATE_CAPABILITY);
  if (!updatable) throw new ComputerReinstallRequiredError();
  throw new OutdatedComputerHelloError({
    runnerId: fields.runner_id,
    protocolVersion: fields.protocol_version,
    daemonVersion,
  });
};

const MAX_INVALID_FRAME_DETAILS = 1_000;
const OPERATION_FRAME_TYPE = /^operation\.[a-z_]{1,48}$/;
const FRAME_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

// Keeps what a schema failure needs for diagnosis without frame content: the
// type, Operation identity, size and the validator's schema paths.
class InvalidRunnerFrameError extends RunnerGatewayProtocolError {
  readonly frameType?: string;
  readonly operationId?: string;
  readonly sequence?: number;
  readonly bytes: number;
  readonly details: string;
  readonly operationFrame?: OperationEnvelope;
  readonly debugCommandId?: string;

  constructor(decoded: unknown, value: string, cause: unknown) {
    super("Invalid Runner Gateway envelope");
    const record =
      typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : {};
    const type = record.type;
    this.frameType =
      typeof type === "string" && /^[a-z_.]{1,64}$/.test(type)
        ? type
        : undefined;
    this.bytes = Buffer.byteLength(value, "utf8");
    this.details = (cause instanceof Error ? cause.message : "unknown").slice(
      0,
      MAX_INVALID_FRAME_DETAILS,
    );
    if (
      typeof type === "string" &&
      OPERATION_FRAME_TYPE.test(type) &&
      typeof record.runner_id === "string" &&
      FRAME_ID.test(record.runner_id) &&
      typeof record.operation_id === "string" &&
      FRAME_ID.test(record.operation_id) &&
      Number.isSafeInteger(record.generation) &&
      Number.isSafeInteger(record.seq) &&
      (record.seq as number) > 0
    ) {
      this.operationId = record.operation_id;
      this.sequence = record.seq as number;
      this.operationFrame = record as unknown as OperationEnvelope;
    }
    if (
      type === "executed" &&
      record.kind === "debug_history" &&
      typeof record.command_id === "string" &&
      FRAME_ID.test(record.command_id)
    ) {
      this.debugCommandId = record.command_id;
    }
  }
}

const rejectUpgrade = (
  socket: Duplex,
  status: number,
  reason: string,
  headers: Readonly<Record<string, string>> = {},
): void => {
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Length: 0",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.end(lines.join("\r\n"));
};

const toUtf8 = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : data.toString("utf8");

const onceClosed = (webSocket: RunnerSocket): Promise<void> =>
  webSocket.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise((resolve) => webSocket.once("close", () => resolve()));
