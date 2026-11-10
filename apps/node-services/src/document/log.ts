import { createJsonLogger, type JsonLogger } from "@linger/service-kit/node";

// The Document Runtime runs on its own worker thread, so its logger is created
// inside that thread rather than passed from the host.
const logger: JsonLogger = createJsonLogger({
  service: "node-services",
}).child({ role: "document" });

export const documentLogger = (): JsonLogger => logger;
