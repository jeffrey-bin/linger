import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isNodeError } from "@linger/service-kit";

interface WikiOperationStateOptions {
  dataDirectory: string;
}

export interface WikiOperation {
  readonly directory: string;
  release(): Promise<void>;
}

/**
 * One disposable directory per candidate operation under `operations/`. One
 * process uses a data directory, so starting clears whatever a stopped
 * process left there.
 */
export class WikiOperationState {
  readonly #dataDirectory: string;
  readonly #operationsDirectory: string;
  #startPromise: Promise<void> | undefined;

  constructor(options: WikiOperationStateOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#operationsDirectory = join(this.#dataDirectory, "operations");
  }

  async start(): Promise<void> {
    const startPromise = (this.#startPromise ??= this.#start());
    try {
      await startPromise;
    } catch (error) {
      if (this.#startPromise === startPromise) this.#startPromise = undefined;
      throw error;
    }
  }

  async createOperation(): Promise<WikiOperation> {
    await this.start();
    const directory = await mkdtemp(
      join(this.#operationsDirectory, "candidate-"),
    );
    let released = false;
    return {
      directory,
      release: async () => {
        if (released) return;
        released = true;
        await removeTree(directory);
      },
    };
  }

  async #start(): Promise<void> {
    await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
    await removeTree(this.#operationsDirectory);
    await mkdir(this.#operationsDirectory, { mode: 0o700 });
  }
}

async function removeTree(root: string): Promise<void> {
  await makeTreeWritable(root);
  await rm(root, { recursive: true, force: true });
}

// The staging code can leave read-only files and directories, whose
// entries a plain recursive removal cannot unlink.
async function makeTreeWritable(root: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (!metadata.isDirectory()) return;
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(target);
    else if (entry.isFile()) await chmod(target, 0o600);
  }
}
