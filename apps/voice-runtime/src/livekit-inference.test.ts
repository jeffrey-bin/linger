import { fileURLToPath } from "node:url";

import {
  AgentServer,
  InferenceRunner,
  initializeLogger,
  ServerOptions,
} from "@livekit/agents";
import { expect, it } from "vitest";

it("constructs a worker without a local inference runner", () => {
  initializeLogger({ pretty: false, level: "warn" });

  new AgentServer(
    new ServerOptions({
      agent: fileURLToPath(new URL("./agent.ts", import.meta.url)),
      wsURL: "ws://127.0.0.1:7880",
      apiKey: "key",
      apiSecret: "secret",
    }),
  );

  // Any registered runner makes the server start a separate inference process.
  expect(InferenceRunner.registeredRunners).toEqual({});
});
