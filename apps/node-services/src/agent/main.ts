import { join } from "node:path";

import type { Flashback } from "../flashback.js";
import type { HttpHost } from "../http-host.js";
import {
  createRuntimeModelCall,
  createTeamHubAnotherMePlacementSource,
  type ModelCall,
} from "../runtime-model-call.js";
import { createModelCallLog } from "../model-call-log.js";
import type { ProcessControl } from "../process-lifecycle.js";

import { bootstrapAgentManager } from "./bootstrap/bootstrap-agent-manager.js";
import { removeRetiredAgentState } from "./bootstrap/retired-agent-state.js";
import { createAgentManagerOperationalReadiness } from "./bootstrap/agent-manager-operational-readiness.js";
import { readAgentServiceConfig } from "./config.js";
import { TeamHubRunnerCredentialAuthority } from "./runner-gateway/runner-credential-authority.js";
import { RunnerGateway } from "./runner-gateway/runner-gateway.js";
import { runtimeModelGateway } from "./runner-gateway/runtime-model-gateway.js";
import { createTeamHubAgentCliCredentialIssuer } from "./runner-gateway/agent-cli-credential-issuer.js";
import { createComputerDaemonIdentityVerifier } from "./runner-gateway/daemon-identity-verifier.js";
import { createTeamHubLocalComputerRegistry } from "./runner-gateway/local-computer-registry.js";
import { createTeamHubRuntimeStateClient } from "./executor/teamhub-runtime-state-client.js";

import {
  closeAgentLogs,
  createAgentLogger,
  setAgentLogDirectory,
} from "./observability/agent-log.js";
import { loadComputerRelease } from "./runner-gateway/computer-release.js";
import {
  createComputerInstallRoute,
  renderShellInstallers,
  renderWindowsInstallers,
  resolveInstallOrigin,
} from "./runner-gateway/install-route.js";

/** How long active Runs may finish before shutdown requeues them. */
const RUN_DRAIN_TIMEOUT_MS = 5_000;
/** One Room callback request to TeamHub. */
const ROOM_REQUEST_TIMEOUT_MS = 10_000;
/** One `/readyz` dependency probe. */
const READINESS_TIMEOUT_MS = 3_000;

export interface AgentRoleHost extends ProcessControl {
  readonly http: HttpHost;
  /** Memory's flashback when the memory role shares this process. */
  readonly flashback?: Flashback;
  /** Replaces ROOM_REQUEST_TIMEOUT_MS; process tests shorten it. */
  readonly roomRequestTimeoutMs?: number;
}

/** Starts the Agent Service on the shared listener. Its model call
 * runs background prompts on Local Computers; it is absent without them. */
export async function startAgentService(
  host: AgentRoleHost,
): Promise<{ modelCall?: ModelCall; stop(): Promise<void> }> {
  const { signal, progress: shutdownProgress } = host;
  host.onExit((budgetMs) => closeAgentLogs(budgetMs));
  const config = readAgentServiceConfig(process.env);
  setAgentLogDirectory(config.logDirectory);
  const roomRequestTimeoutMs =
    host.roomRequestTimeoutMs ?? ROOM_REQUEST_TIMEOUT_MS;
  const runnerGatewayConfiguration = config.runnerGateway?.configuration;
  const releaseRoot = config.computerReleaseRoot;
  const computerRelease = await loadComputerRelease(releaseRoot);
  const releaseLogger = createAgentLogger({ component: "computer-release" });
  if (!computerRelease) {
    releaseLogger.log("warn", "computer_release.missing", {
      root: releaseRoot,
    });
  }
  const installOrigin = resolveInstallOrigin(config.webPublicOrigin);
  if (computerRelease && !installOrigin) {
    releaseLogger.log("warn", "computer_release.installer_unavailable", {
      reason: "WEB_PUBLIC_ORIGIN is not set",
    });
  }
  const computerInstallation = computerRelease && {
    release: computerRelease,
    ...(installOrigin
      ? {
          shell: renderShellInstallers(computerRelease, installOrigin),
          windows: renderWindowsInstallers(computerRelease, installOrigin),
        }
      : {}),
  };
  const roomBaseUrl = config.teamHubBaseUrl;
  const { serviceToken, inboundServiceToken } = config;
  const runtimeStateClient = createTeamHubRuntimeStateClient({
    baseUrl: roomBaseUrl,
    serviceToken,
    requestTimeoutMs: roomRequestTimeoutMs,
  });
  const unmountInstall = host.http.mount(
    createComputerInstallRoute(computerInstallation),
  );
  try {
    const localComputerRegistry = config.runnerGateway
      ? createTeamHubLocalComputerRegistry(runtimeStateClient)
      : undefined;
    const runnerCredentialAuthority =
      config.runnerGateway && localComputerRegistry
        ? new TeamHubRunnerCredentialAuthority({
            signingKey: config.runnerGateway.runnerSigningKey,
            registry: localComputerRegistry,
          })
        : undefined;
    const localContextRuntime = config.runnerGateway?.localContextRuntime;
    const runnerGateway =
      runnerGatewayConfiguration && localComputerRegistry
        ? new RunnerGateway({
            openConnectionsLater: true,
            ...(localContextRuntime
              ? {
                  contextContent: {
                    publicOrigin: localContextRuntime.publicOrigin,
                    signingKey: localContextRuntime.contentSigningKey,
                  },
                }
              : {}),
            computerRegistry: localComputerRegistry,
            recordRunOperation: async (record) => {
              await runtimeStateClient.recordRunOperation({
                context_key: record.contextKey,
                epoch: record.epoch,
                run_id: record.runId,
                operation_id: record.operationId,
                runtime_type: record.runtimeType,
                ...(record.usage ? { usage: [...record.usage] } : {}),
              });
            },
            ...(computerRelease ? { computerRelease } : {}),
            computerDaemonIdentityVerifier:
              createComputerDaemonIdentityVerifier(),
            agentCliCredentialIssuer: createTeamHubAgentCliCredentialIssuer({
              baseUrl: roomBaseUrl,
              cliBaseUrl: config.teamHubCliBaseUrl,
              serviceToken,
            }),
          })
        : undefined;

    // Stateless prompts on the owner's Agent Runtime: Agent Memory, Memory,
    // and TeamHub's /v1/model-calls.
    const modelCallLogger = createAgentLogger({ component: "model-call" });
    const modelCall =
      runnerGateway &&
      createRuntimeModelCall({
        gateway: runtimeModelGateway(runnerGateway),
        placements: createTeamHubAnotherMePlacementSource({
          baseUrl: roomBaseUrl,
          serviceToken,
        }),
        logger: modelCallLogger,
        callLog: createModelCallLog({
          directory: join(config.home, "model-calls"),
          logger: modelCallLogger,
        }),
      });

    await removeRetiredAgentState(config.home, config.contextHostRoot);
    signal.throwIfAborted();
    const application = await bootstrapAgentManager({
      signal,
      shutdownProgress,
      runGracePeriodMs: RUN_DRAIN_TIMEOUT_MS,
      runnerCredentialAuthority,
      runnerGateway,
      localContextRuntime,
      contextHostRoot: config.contextHostRoot,
      roomBaseUrl,
      operationalReadiness: createAgentManagerOperationalReadiness({
        teamHubBaseUrl: roomBaseUrl,
        requestTimeoutMs: READINESS_TIMEOUT_MS,
      }),
      ...(host.flashback ? { flashback: host.flashback } : {}),
      ...(modelCall ? { modelCall } : {}),
      serviceToken,
      inboundServiceToken,
      runtimeStateClient,
      roomRequestTimeoutMs,
      httpHost: host.http,
    });

    console.log(`AgentManager API: ${application.address.url}`);

    return {
      ...(modelCall ? { modelCall } : {}),
      stop: async () => {
        try {
          await application.close();
        } finally {
          unmountInstall();
        }
      },
    };
  } catch (error) {
    unmountInstall();
    throw error;
  }
}
