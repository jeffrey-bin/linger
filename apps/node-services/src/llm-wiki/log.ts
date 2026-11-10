import { createJsonLogger, type JsonLogger } from "@linger/service-kit/node";

export type WikiLogLevel = "ERROR" | "INFO";

// LLM Wiki modules log through the host's role logger once the service starts;
// CLIs and tests keep the stderr default.
let logger: JsonLogger = createJsonLogger({ service: "node-services" }).child({
  role: "llm-wiki",
});

export function setWikiLogger(next: JsonLogger): void {
  logger = next;
}

export const wikiLogger = (): JsonLogger => logger;

export function writeWikiLog(
  event: string,
  fields: Record<string, unknown> = {},
  level: WikiLogLevel = "INFO",
): void {
  logger.log(level === "ERROR" ? "error" : "info", event, fields);
}
