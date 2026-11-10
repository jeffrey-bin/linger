import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { inferFileMetadata } from "@linger/document-files";
import { readExactHostFile } from "./files/host-file-reader.js";
import {
  createHostFileExclusive,
  syncHostDirectory,
} from "./files/host-file-system.js";
import type { CommandExecutionContext } from "./command-definition.js";
import { ConnectorError as CliError } from "./errors.js";
import { readBounded } from "./http-client.js";

export interface ConnectorFile {
  localPath: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  sha256: string;
  md5: string;
}
const maximumFileBytes = 512 * 1024 * 1024;
export async function validateLocalFiles(
  files: readonly string[],
  cwd: string,
  maximum = maximumFileBytes,
): Promise<string[]> {
  if (files.length > 20)
    throw new CliError("usage", "At most 20 files are allowed.");
  const paths: string[] = [];
  for (const source of files) {
    if (!source.trim() || source === "-" || /[\r\n\p{Cc}]/u.test(source))
      throw new CliError("usage", "Provide an ordinary local file path.");
    const filename = path.resolve(cwd, source);
    let stat;
    try {
      stat = await lstat(filename);
    } catch {
      throw new CliError("invalid_path", "An input file is unavailable.");
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new CliError(
        "invalid_path",
        "Input must be an ordinary file, not a directory or symlink.",
      );
    if (stat.size > maximum)
      throw new CliError(
        "too_large",
        "An input file exceeds this command's byte limit.",
      );
    // Task playgrounds are projected through directory symlinks. Resolve only
    // the parent, as message resources do: the leaf stays an ordinary file and
    // the later reads pin the canonical directory.
    let parent;
    try {
      parent = await realpath(path.dirname(filename));
    } catch {
      throw new CliError("invalid_path", "An input file is unavailable.");
    }
    paths.push(path.join(parent, path.basename(filename)));
  }
  if (new Set(paths).size !== paths.length)
    throw new CliError("usage", "The same file cannot be included twice.");
  return paths;
}
/** Hash each local file once; the upload later rereads and verifies it. */
export async function snapshotConnectorFiles(
  files: readonly string[],
): Promise<ConnectorFile[]> {
  const snapshots: ConnectorFile[] = [];
  for (const filename of files) {
    const snapshot = await readExactHostFile(
      path.dirname(filename),
      path.basename(filename),
      maximumFileBytes,
      new AbortController().signal,
    );
    snapshots.push({
      localPath: filename,
      name: path.basename(filename),
      mimetype: inferFileMetadata(filename).media_type,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
      md5: createHash("md5").update(snapshot.content).digest("hex"),
    });
  }
  return snapshots;
}
export async function readConnectorFile(
  file: ConnectorFile,
): Promise<Uint8Array> {
  const snapshot = await readExactHostFile(
    path.dirname(file.localPath),
    path.basename(file.localPath),
    maximumFileBytes,
    new AbortController().signal,
  );
  if (snapshot.sha256 !== file.sha256 || snapshot.sizeBytes !== file.sizeBytes)
    throw new CliError(
      "invalid_path",
      "An input file changed while the command was running.",
    );
  return snapshot.content;
}
// Only storage/provider domains used by the fixed bindings are eligible. Never
// follow redirects or forward TeamHub/provider authentication to a file URL.
export function connectorTransferURL(value: unknown): string {
  if (typeof value !== "string")
    throw new CliError(
      "incomplete_response",
      "The file transfer URL is missing.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(
      "incomplete_response",
      "The file transfer URL is invalid.",
    );
  }
  const host = url.hostname.toLowerCase();
  const trusted =
    host === "s3.amazonaws.com" ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/u.test(host) ||
    /\.(?:r2\.cloudflarestorage\.com|blob\.core\.windows\.net|composio\.dev|sharepoint\.com|files\.1drv\.com|cloudfront\.net)$/u.test(
      host,
    ) ||
    // fal serves model outputs and uploads from its own CDN, and Higgsfield
    // takes uploads on its own domain.
    /(?:^|\.)fal\.media$/u.test(host) ||
    /(?:^|\.)higgsfield\.ai$/u.test(host) ||
    [
      "outlook.office.com",
      "outlook.office365.com",
      "outlook.live.com",
    ].includes(host);
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    !trusted
  )
    throw new CliError(
      "unsupported_combination",
      "The selected binding returned an unsupported file transfer host.",
    );
  return url.href;
}
export async function assertNewOutput(
  filename: string,
  cwd: string,
): Promise<string> {
  if (!filename || filename === "-" || /[\r\n\p{Cc}]/u.test(filename))
    throw new CliError(
      "usage",
      "Provide a local output path, not stdin/stdout.",
    );
  const output = path.resolve(cwd, filename);
  const existing = await lstat(output).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing)
    throw new CliError(
      "invalid_path",
      "The output path already exists; choose another path.",
    );
  return output;
}
export async function saveConnectorBytes(
  bytes: Uint8Array,
  filename: string,
  context: CommandExecutionContext,
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  if (bytes.length > maximumFileBytes)
    throw new CliError(
      "too_large",
      "The downloaded file exceeds the byte limit.",
    );
  const output = await assertNewOutput(filename, context.cwd);
  // Saving into a folder that does not exist yet, such as a conversation's
  // playground folder before its first file, creates it.
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(output),
    `.teamhub-download-${randomUUID()}`,
  );
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Exclusive admission cannot replace an existing target.
    await createHostFileExclusive(temporary, output);
    await syncHostDirectory(path.dirname(output));
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    path: output,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function saveConnectorDownload(
  url: unknown,
  filename: string,
  context: CommandExecutionContext,
  verify?: (bytes: Uint8Array) => void | Promise<void>,
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  const output = await assertNewOutput(filename, context.cwd);
  const { bytes } = await fetchConnectorFile(url, context);
  await verify?.(bytes);
  return saveConnectorBytes(bytes, output, context);
}
/** Downloads one remote file under the transfer rules, with its served type. */
export async function fetchConnectorFile(
  url: unknown,
  context: CommandExecutionContext,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let response: Response;
  try {
    response = await (context.fetch ?? globalThis.fetch)(
      connectorTransferURL(url),
      { redirect: "error", signal: AbortSignal.timeout(180000) },
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "file_transfer_failed",
      "The remote file could not be downloaded.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CliError(
      "file_transfer_failed",
      "The remote file download was rejected.",
    );
  }
  const bytes = await readBounded(response, maximumFileBytes);
  return {
    bytes,
    contentType: (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase(),
  };
}
