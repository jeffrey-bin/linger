// Stands in for the Document thread: it reports that it listens and answers
// the host's drain with a success status.
import { parentPort } from "node:worker_threads";

parentPort.once("message", () => parentPort.postMessage(0));
parentPort.postMessage("listening");
