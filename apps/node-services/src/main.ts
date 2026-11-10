import { fileURLToPath } from "node:url";

import {
  WorkerDocumentNormalizer,
  type DocumentNormalizer,
} from "./document-normalizer/document-normalizer.js";
import { createJsonLogger, type JsonLogger } from "@linger/service-kit/node";

import type { Flashback } from "./flashback.js";
import type { ModelCall } from "./runtime-model-call.js";
import { startHttpHost, type HttpHost } from "./http-host.js";
import {
  NODE_SERVICES_DEFAULT_ADDRESS,
  readListenAddress,
  type ListenAddress,
} from "./listen-address.js";
import {
  SHUTDOWN_TIMEOUT_MS,
  runServiceProcess,
  type ProcessControl,
} from "./process-lifecycle.js";

interface RunningRole {
  stop(): Promise<void>;
}

/** What the host passes to every role's start function. */
interface RoleHost extends ProcessControl {
  readonly logger: JsonLogger;
  /** The shared listener; present whenever an HTTP role is selected. */
  readonly http: HttpHost | undefined;
  /** The process's one document normalizer, served by LLM Wiki. */
  readonly normalizer: DocumentNormalizer;
  /** What a role hands to the roles that start after it. The agent role fills
   * modelCall after Memory and LLM Wiki have started, so they read it when
   * they call. */
  readonly seams: { flashback?: Flashback; modelCall?: ModelCall };
  /** Replaces the Agent Service's Room request timeout in process tests. */
  readonly agentRoomRequestTimeoutMs?: number;
}

// Each role loads only when selected, so a single-role process skips the
// other roles' dependencies. Roles start in this order and stop in reverse:
// the Agent Service stops before the Memory it calls, and the Document
// Runtime, which starts last, drains first.
const roles = {
  memory: async (host: RoleHost) => {
    const memory = await (
      await import("./memory/main.js")
    ).startMemoryService({
      http: requireHttp(host),
      logger: host.logger,
      modelCall: () => host.seams.modelCall,
    });
    host.seams.flashback = memory.flashback;
    return memory;
  },
  "llm-wiki": async (host: RoleHost) =>
    (await import("./llm-wiki/service.js")).startLlmWikiService({
      http: requireHttp(host),
      logger: host.logger,
      normalizer: host.normalizer,
      modelCall: () => host.seams.modelCall,
    }),
  agent: async (host: RoleHost) => {
    const http = requireHttp(host);
    const agent = await (
      await import("./agent/main.js")
    ).startAgentService({
      ...host,
      http,
      ...(host.seams.flashback ? { flashback: host.seams.flashback } : {}),
      ...(host.agentRoomRequestTimeoutMs
        ? { roomRequestTimeoutMs: host.agentRoomRequestTimeoutMs }
        : {}),
    });
    host.seams.modelCall = agent.modelCall;
    return {
      stop: async () => {
        host.seams.modelCall = undefined;
        await agent.stop();
      },
    };
  },
  voice: async (host: RoleHost) =>
    (await import("./voice/service.js")).startVoiceService({
      logger: host.logger,
      http: requireHttp(host),
    }),
  // The Document Runtime keeps its own port on its own worker thread and logs
  // from that thread; the host logger only records the thread's restarts.
  document: async (host: RoleHost) =>
    (await import("./document/main.js")).startDocumentService({
      logger: host.logger,
    }),
} satisfies Record<string, (host: RoleHost) => Promise<RunningRole>>;

type RoleName = keyof typeof roles;

/** Roles that serve requests on the shared HTTP listener. */
const HTTP_ROLES: ReadonlySet<RoleName> = new Set([
  "memory",
  "llm-wiki",
  "agent",
  "voice",
]);

/** An unset or empty NODE_SERVICES_ROLES starts every role. */
export function selectRoles(value: string | undefined): RoleName[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const all = Object.keys(roles) as RoleName[];
  if (names.length === 0) return all;
  const unknown = names.filter((name) => !Object.hasOwn(roles, name));
  if (unknown.length > 0) {
    throw new Error(
      `NODE_SERVICES_ROLES contains unknown roles: ${unknown.join(", ")}; ` +
        `expected ${all.join(", ")}`,
    );
  }
  // Selected roles keep the host's start order.
  return all.filter((name) => names.includes(name));
}

/** The shared listener's address from NODE_SERVICES_HTTP_ADDRESS. */
export function readHttpAddress(environment: NodeJS.ProcessEnv): ListenAddress {
  // Tests bind an ephemeral port; a deployment always names its port.
  return readListenAddress(
    environment,
    "NODE_SERVICES_HTTP_ADDRESS",
    NODE_SERVICES_DEFAULT_ADDRESS,
    environment.NODE_ENV === "test",
  );
}

function requireHttp(host: RoleHost): HttpHost {
  if (!host.http) throw new Error("The shared HTTP listener is not running");
  return host.http;
}

/** Runs the selected roles; process tests start it with shorter timeouts. */
export async function main(
  overrides: { agentRoomRequestTimeoutMs?: number } = {},
): Promise<void> {
  const logger = createJsonLogger({ service: "node-services" });
  await runServiceProcess(async (control) => {
    const selected = selectRoles(process.env.NODE_SERVICES_ROLES);
    const http = selected.some((name) => HTTP_ROLES.has(name))
      ? await startHttpHost(readHttpAddress(process.env))
      : undefined;
    const normalizer = new WorkerDocumentNormalizer({
      onModelsUnavailable: (error) =>
        logger.log("warn", "document_normalizer.models_unavailable", {
          error,
        }),
    });
    const seams: RoleHost["seams"] = {};
    const running: { name: RoleName; role: RunningRole }[] = [];
    const stopRoles = async (): Promise<void> => {
      const failures: unknown[] = [];
      const stopping = running.splice(0).reverse();
      const voice = stopping.find(({ name }) => name === "voice");
      const voiceStopped = voice?.role.stop().catch((error) => {
        failures.push(error);
      });
      for (const { name, role } of stopping.filter(
        ({ name }) => name !== "voice",
      )) {
        control.progress(`role:${name}`, "started");
        try {
          await role.stop();
          control.progress(`role:${name}`, "completed");
        } catch (error) {
          control.progress(`role:${name}`, "failed");
          logger.log("error", "host.role_stop_failed", { error, role: name });
          failures.push(error);
        }
      }
      await voiceStopped;
      control.progress("http", "started");
      await http?.close();
      control.progress("http", "completed");
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Node Services roles failed to stop",
        );
      }
    };
    try {
      for (const name of selected) {
        control.signal.throwIfAborted();
        const role = await roles[name]({
          ...control,
          http,
          logger: logger.child({ role: name }),
          normalizer,
          seams,
          ...overrides,
        });
        running.push({ name, role });
      }
      http?.finishStartup();
      if (http) logger.log("info", "host.listening", { url: http.url });
    } catch (error) {
      await stopRoles().catch((stopError: unknown) => {
        logger.log("error", "host.start_cleanup_failed", { error: stopError });
      });
      throw error;
    }
    return { close: stopRoles };
  }, SHUTDOWN_TIMEOUT_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
