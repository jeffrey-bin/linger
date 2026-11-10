import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

parentPort.on("message", (records) => {
  let failed = 0;
  for (const record of records) {
    try {
      writeLocalLine(record);
    } catch {
      failed++;
    }
  }
  parentPort.postMessage({ failed });
});

const writeLocalLine = ({
  root,
  agentId,
  line,
  maximumBytes,
  maximumFiles,
}) => {
  const directory = agentId
    ? path.join(root, "agents", agentId)
    : path.join(root, "system");
  mkdirSync(root, { recursive: true, mode: LOG_DIRECTORY_MODE });
  if (agentId) ensurePrivateDirectory(path.join(root, "agents"));
  ensurePrivateDirectory(directory);
  const filePath = path.join(directory, "events.ndjson");
  rotateIfRequired(
    filePath,
    Buffer.byteLength(line),
    maximumBytes,
    maximumFiles,
  );
  appendFileSync(filePath, line, { encoding: "utf8", mode: LOG_FILE_MODE });
  chmodSync(filePath, LOG_FILE_MODE);
};

const ensurePrivateDirectory = (directory) => {
  mkdirSync(directory, { recursive: true, mode: LOG_DIRECTORY_MODE });
  chmodSync(directory, LOG_DIRECTORY_MODE);
};

const rotateIfRequired = (
  filePath,
  incomingBytes,
  maximumBytes,
  maximumFiles,
) => {
  let currentBytes = 0;
  try {
    currentBytes = statSync(filePath).size;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= maximumBytes) {
    return;
  }

  for (let index = maximumFiles - 1; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const destination = `${filePath}.${index}`;
    if (index === maximumFiles - 1) {
      rmSync(destination, { force: true });
    }
    try {
      renameSync(source, destination);
      chmodSync(destination, LOG_FILE_MODE);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
  if (maximumFiles === 1) {
    rmSync(filePath, { force: true });
  }
};

const isMissingFileError = (error) =>
  error !== null && typeof error === "object" && error.code === "ENOENT";
