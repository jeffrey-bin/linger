import { join } from "node:path";

import { mirrorHome } from "../paths.js";
import { serviceCredential } from "@linger/service-kit/node";

export interface LlmWikiConfig {
  dataDirectory: string;
  teamHubServiceToken: string | undefined;
}

export function loadLlmWikiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LlmWikiConfig {
  return {
    dataDirectory: join(mirrorHome(environment), "llm-wiki"),
    teamHubServiceToken: serviceCredential(
      "node-services-internal",
      environment,
    ),
  };
}
