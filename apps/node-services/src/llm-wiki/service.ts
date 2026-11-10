import { type DocumentNormalizer } from "../document-normalizer/document-normalizer.js";
import { type JsonLogger } from "@linger/service-kit/node";

import type { ModelCall } from "../runtime-model-call.js";
import { loadLlmWikiConfig } from "./config.js";
import { AgentWikiBackend } from "./agent-wiki-backend.js";
import { WikiRefreshCandidateService } from "./wiki-refresh-candidates.js";
import { WikiServer } from "./wiki-server.js";
import type { HttpHost, RoleReadiness } from "../http-host.js";
import { setWikiLogger } from "./log.js";

export async function startLlmWikiService({
  http,
  logger,
  normalizer,
  modelCall,
}: {
  http: HttpHost;
  logger: JsonLogger;
  normalizer: DocumentNormalizer;
  /** The agent role's model call once it has started in this process. */
  modelCall: () => ModelCall | undefined;
}): Promise<{
  stop(): Promise<void>;
}> {
  setWikiLogger(logger);
  const config = loadLlmWikiConfig();
  if (!config.teamHubServiceToken) {
    throw new Error("LINGER_SECRET_SEED is required for serve");
  }
  const candidateService = new WikiRefreshCandidateService({
    dataDirectory: config.dataDirectory,
    runtime: new AgentWikiBackend({ modelCall }),
  });
  await candidateService.start();
  const server = new WikiServer({
    candidateService,
    http,
    normalizer,
    readiness: () => modelCallReadiness(modelCall),
    serviceToken: config.teamHubServiceToken,
  });
  server.start();
  return {
    stop: async () => {
      server.close();
      await candidateService.stop();
    },
  };
}

/** Ready once the agent role has started the model call in this process. */
export function modelCallReadiness(
  modelCall: () => ModelCall | undefined,
): RoleReadiness {
  return modelCall()
    ? { ready: true }
    : { ready: false, reason: "model_call_unavailable" };
}
