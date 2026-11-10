import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { Module, ModuleContext } from "./modules.js";
import {
  FEED_PATH,
  MANIFEST_FILE,
  ManifestError,
  SIGNATURE_FILE,
  UPDATE_PUBLIC_KEY,
  compareVersions,
  packageFor,
  verifyManifest,
} from "./update-manifest.js";

export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "downloading"; readonly version: string }
  // `services`: the new version is the one this app brings for the
  // services on this computer, applied without restarting the app.
  | {
      readonly kind: "ready";
      readonly version: string;
      readonly services?: boolean;
    }
  // Restart was chosen while tasks ran; it happens once they finish.
  | {
      readonly kind: "waiting";
      readonly version: string;
      readonly services?: boolean;
    }
  | {
      readonly kind: "installing";
      readonly version: string;
      readonly services?: boolean;
    }
  | { readonly kind: "failed"; readonly error: string };

export interface UpdaterOptions {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  // The installed Linger.app. Without one (development, other platforms)
  // the updater stays idle.
  readonly appBundle: string | undefined;
  // Downloads live here until they are installed.
  readonly downloadDirectory: string;
  // Stops modules, including the daemon, and relaunches the app from
  // appBundle, which by then holds the new version and its daemon.
  readonly restart: () => Promise<void>;
  // The services this app runs on this computer, when it serves the window.
  // Their updates come with the app, so the feed is not asked.
  readonly services?: LocalServices;
  // Tells the person once that an update for those services is ready.
  readonly announceServices?: () => void;
  readonly fetch?: typeof fetch;
  readonly extract?: (archive: string, directory: string) => Promise<void>;
  readonly publicKey?: string;
  readonly checkDelayMs?: number;
  readonly checkIntervalMs?: number;
  readonly retryDelayMs?: number;
}

export interface LocalServices {
  // Whether the window's server is the one on this computer.
  serving(serverUrl: string): boolean;
  // Whether this app brings a newer version than the services run.
  sourceUpdateAvailable(): boolean;
  updateSource(): Promise<void>;
}

const CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
// A dropped connection should not cost a whole check interval.
const RETRY_DELAY_MS = 5 * 60_000;
const STAGED_PREFIX = ".Linger-update-";
const OLD_PREFIX = ".Linger-old-";

const run = promisify(execFile);

// /usr/bin/tar keeps the symlinks and code signatures inside the bundle.
const untar = async (archive: string, directory: string): Promise<void> => {
  await run("/usr/bin/tar", ["-xzf", archive, "-C", directory]);
};

export class UpdateError extends Error {}

// Self-update without Squirrel: a signed manifest on the
// deployment's own server, a sha256-checked package, and a bundle swap that
// waits for running tasks. Sign-in and the computer identity live outside the
// bundle, so they carry over.
export class UpdaterModule implements Module {
  readonly name = "Updater";
  readonly dependsOn = ["Config", "ComputerDaemon"];
  readonly #options: UpdaterOptions;
  #ctx: ModuleContext | undefined;
  #state: UpdateState = { kind: "idle" };
  #staged: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<void> | undefined;
  #announced = false;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: UpdaterOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    if (this.#options.services) {
      this.#unsubscribe.push(
        ctx.bus.on("local-server.changed", () => this.#offerServices()),
      );
      this.#offerServices();
    }
    if (!this.#options.appBundle) return;
    void this.#cleanup();
    const schedule = (delay: number): void => {
      this.#timer = setTimeout(() => {
        void this.check().finally(() =>
          schedule(
            this.#state.kind === "failed"
              ? (this.#options.retryDelayMs ?? RETRY_DELAY_MS)
              : (this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS),
          ),
        );
      }, delay);
      this.#timer.unref?.();
    };
    schedule(this.#options.checkDelayMs ?? CHECK_DELAY_MS);
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  state(): UpdateState {
    return this.#state;
  }

  // Fetches and verifies the manifest, then downloads a newer package. Only
  // one check runs at a time; a ready update is not checked again.
  check(): Promise<void> {
    if (!this.#options.appBundle || this.#servedLocally())
      return Promise.resolve();
    if (this.#state.kind !== "idle" && this.#state.kind !== "failed")
      return this.#checking ?? Promise.resolve();
    this.#checking = this.#check().finally(() => (this.#checking = undefined));
    return this.#checking;
  }

  // "Restart to Update". With tasks running, the restart waits for them.
  async install(): Promise<void> {
    const state = this.#state;
    if (state.kind !== "ready" && state.kind !== "waiting") return;
    const runtime = this.#ctx!.get<ComputerDaemonModule>("ComputerDaemon");
    if (runtime.running() > 0) {
      if (state.kind === "waiting") return;
      this.#setState({
        kind: "waiting",
        version: state.version,
        ...(state.services ? { services: true } : {}),
      });
      const off = this.#ctx!.bus.on("runtime.activity", (running) => {
        if (running !== 0) return;
        off();
        void this.install();
      });
      this.#unsubscribe.push(off);
      return;
    }
    if (state.services) {
      this.#setState({
        kind: "installing",
        version: state.version,
        services: true,
      });
      await this.#options.services?.updateSource();
      this.#setState({ kind: "idle" });
      this.#offerServices();
      return;
    }
    this.#setState({ kind: "installing", version: state.version });
    try {
      await this.#swap();
    } catch (error) {
      this.#fail("update.install_failed", error);
      return;
    }
    this.#ctx!.log.info("update.installing", { version: state.version });
    await this.#options.restart();
  }

  #servedLocally(): boolean {
    const serverUrl = this.#ctx?.config.get().serverUrl;
    return !!serverUrl && !!this.#options.services?.serving(serverUrl);
  }

  // "Update Linger on This Computer", offered once the app
  // brings a newer version than they run.
  #offerServices(): void {
    const services = this.#options.services;
    if (!services) return;
    const kind = this.#state.kind;
    if (services.sourceUpdateAvailable()) {
      if (kind === "idle" || kind === "failed") {
        this.#setState({
          kind: "ready",
          version: this.#options.version,
          services: true,
        });
        if (!this.#announced) {
          this.#announced = true;
          this.#options.announceServices?.();
        }
      }
    } else if (kind === "ready" && this.#state.services) {
      this.#setState({ kind: "idle" });
    }
  }

  async #check(): Promise<void> {
    const ctx = this.#ctx!;
    const serverUrl = ctx.config.get().serverUrl;
    if (!serverUrl) return;
    this.#setState({ kind: "checking" });
    try {
      const feed = new URL(
        FEED_PATH,
        serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`,
      );
      const [bytes, signature] = await Promise.all([
        this.#get(new URL(MANIFEST_FILE, feed)),
        this.#get(new URL(SIGNATURE_FILE, feed)),
      ]);
      const manifest = verifyManifest(
        bytes,
        signature.toString("utf8"),
        this.#options.publicKey ?? UPDATE_PUBLIC_KEY,
      );
      const pkg = packageFor(
        manifest,
        this.#options.platform,
        this.#options.arch,
      );
      if (
        compareVersions(manifest.version, this.#options.version) <= 0 ||
        !pkg
      ) {
        this.#setState({ kind: "idle" });
        return;
      }
      this.#setState({ kind: "downloading", version: manifest.version });
      const archive = path.join(this.#options.downloadDirectory, pkg.file);
      await this.#download(
        new URL(pkg.file, feed),
        archive,
        pkg.sha256,
        pkg.size,
      );
      this.#staged = await this.#extract(archive, manifest.version);
      await rm(archive, { force: true });
      ctx.log.info("update.ready", { version: manifest.version });
      this.#setState({ kind: "ready", version: manifest.version });
    } catch (error) {
      this.#fail("update.check_failed", error);
    }
  }

  async #get(url: URL): Promise<Buffer> {
    const response = await (this.#options.fetch ?? fetch)(url, {
      redirect: "error",
    });
    if (!response.ok)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // Streams to disk while hashing; a mismatch deletes the file.
  async #download(
    url: URL,
    file: string,
    sha256: string,
    size: number,
  ): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const response = await (this.#options.fetch ?? fetch)(url, {
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > size) {
          done(new UpdateError("Update package is larger than announced"));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        meter,
        createWriteStream(file, { mode: 0o600 }),
      );
      if (received !== size || hash.digest("hex") !== sha256)
        throw new UpdateError("Update package does not match its checksum");
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
  }

  // Unpacks next to the installed bundle so the swap is two renames on one
  // volume.
  async #extract(archive: string, version: string): Promise<string> {
    const parent = path.dirname(this.#options.appBundle!);
    const staged = path.join(parent, `${STAGED_PREFIX}${version}`);
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    try {
      await (this.#options.extract ?? untar)(archive, staged);
      const app = path.join(staged, path.basename(this.#options.appBundle!));
      if (!(await stat(app)).isDirectory())
        throw new UpdateError("Update package has no app");
      return app;
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error instanceof UpdateError
        ? error
        : new UpdateError(`Couldn't unpack the update: ${String(error)}`);
    }
  }

  // The running process keeps its open files, so the bundle can be renamed
  // under it. A failed second rename puts the old bundle back.
  async #swap(): Promise<void> {
    const bundle = this.#options.appBundle!;
    const staged = this.#staged;
    if (!staged) throw new UpdateError("No update is ready");
    const old = path.join(path.dirname(bundle), `${OLD_PREFIX}${Date.now()}`);
    await rename(bundle, old);
    try {
      await rename(staged, bundle);
    } catch (error) {
      await rename(old, bundle);
      throw error;
    }
    this.#staged = undefined;
    await rm(path.dirname(staged), { recursive: true, force: true });
  }

  // Leftovers from an earlier update: the replaced bundle and unused stages.
  async #cleanup(): Promise<void> {
    const parent = path.dirname(this.#options.appBundle!);
    try {
      for (const name of await readdir(parent)) {
        if (name.startsWith(OLD_PREFIX) || name.startsWith(STAGED_PREFIX))
          await rm(path.join(parent, name), { recursive: true, force: true });
      }
    } catch (error) {
      this.#ctx?.log.warn("update.cleanup_failed", { error: String(error) });
    }
  }

  #fail(event: string, error: unknown): void {
    const message =
      error instanceof UpdateError || error instanceof ManifestError
        ? error.message
        : String(error);
    this.#ctx!.log.warn(event, { error: message });
    this.#setState({ kind: "failed", error: message });
  }

  #setState(state: UpdateState): void {
    this.#state = state;
    this.#ctx?.bus.emit("update.changed", state.kind);
  }
}

// The bundle that contains this executable on macOS, e.g.
// /Applications/Linger.app for /Applications/Linger.app/Contents/MacOS/Linger.
export const appBundleOf = (execPath: string): string | undefined => {
  const bundle = path.resolve(execPath, "../../..");
  return bundle.endsWith(".app") ? bundle : undefined;
};
