import { parentPort, threadId } from "node:worker_threads";

// Speaks the computation worker protocol. Input "crash" exits the thread,
// input "hang" never answers, input "thread" answers with this worker's thread
// ID, any other input is echoed back.
parentPort!.on(
  "message",
  (request: { id: number; name: string; input: unknown }) => {
    if (request.input === "crash") {
      process.exit(1);
    }
    if (request.input === "hang") {
      return;
    }
    parentPort!.postMessage({
      id: request.id,
      ok: true,
      result: request.input === "thread" ? threadId : request.input,
    });
  },
);
