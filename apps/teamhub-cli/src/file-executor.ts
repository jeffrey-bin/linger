import { realpath } from "node:fs/promises";
import path from "node:path";
import { isExcludedPublicationEntry } from "./files/publication-filter.js";
import { createFileBackend } from "./file-backend.js";
import type { TeamHubHttpClient } from "./http-client.js";
import { CliError } from "./errors.js";
import type { CliTiming } from "./timing.js";

export async function executeFileCommand(
  command: { route: string; body: Record<string, unknown> },
  client: TeamHubHttpClient,
  emit: (result: Record<string, unknown>) => Promise<void>,
  timing?: CliTiming,
): Promise<void> {
  if (
    !["docs/ls", "docs/get", "docs/replace", "skill/publish"].includes(
      command.route,
    )
  )
    throw new CliError(
      "invalid_input",
      `Unsupported file command: ${command.route}`,
    );
  const backend = createFileBackend(client);
  if (command.route === "docs/ls") {
    await emit({
      documents: await backend.list({
        sharedWithMe: command.body.shared_with_me === true,
      }),
    });
    return;
  }
  const commandDependency = <T>(load: () => Promise<T>): Promise<T> =>
    timing ? timing.measure("command_dependencies", load) : load();
  const [
    { TeamHubWorkingCopies },
    { createHostTeamHubWorkingCopyStateFiles, createHostTeamHubWorkspaceFiles },
  ] = await commandDependency(() =>
    Promise.all([
      import("./files/teamhub-working-copies.js"),
      import("./files/teamhub-workspace-files.js"),
    ]),
  );
  const requestedPath = String(
    command.body.file_path ??
      command.body.target_path ??
      command.body.folder_path,
  );
  assertPublicPath(path.resolve(requestedPath));
  const directory = await realpath(path.dirname(requestedPath));
  assertPublicPath(directory);
  const canonicalTarget = await realpath(requestedPath).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  if (canonicalTarget) assertPublicPath(canonicalTarget);
  const targetPath = path.join(directory, path.basename(requestedPath));
  const signal = new AbortController().signal;
  const stateFiles = createHostTeamHubWorkingCopyStateFiles({
    workspacePath: directory,
    signal,
    namespace: client.config.identityKey,
  });
  await stateFiles.withPinnedDirectory(async (pinnedStateFiles) => {
    const files = createHostTeamHubWorkspaceFiles({
      workspacePath: directory,
      runtimeWorkspacePath: directory,
      readOnlyPaths: [],
      signal,
    });
    // Metadata records the downloaded base only. It never authorizes a TeamHub write.
    const options = {
      files,
      stateFiles: pinnedStateFiles,
      stateBinding: client.config.identityKey,
      integrityKey: client.config.identityKey,
      backend,
    };
    const copies = new TeamHubWorkingCopies(options);
    if (command.route === "docs/get") {
      const base = await copies.get(
        String(command.body.name),
        targetPath,
        command.body.format as "markdown" | "blocks" | "html" | undefined,
        command.body.raw === true,
      );
      const saveArguments = ["docs", "replace", base.documentId, targetPath];
      await emit({
        status: "downloaded",
        document_id: base.documentId,
        version_id: base.versionId,
        name: base.name,
        file_path: targetPath,
        ...(base.readOnly &&
        ["blocks", "html"].includes(String(command.body.format))
          ? {
              save_command: saveCommand(
                saveArguments,
                process.platform === "win32" ? "powershell" : "sh",
              ),
              ...(process.platform === "win32"
                ? {
                    save_command_shell: "powershell",
                    save_command_bash: saveCommand(saveArguments, "sh"),
                  }
                : {}),
            }
          : {}),
      });
      return;
    }
    if (command.route === "skill/publish") {
      const { packContextSkillFolder } = await commandDependency(
        () => import("./files/context-skill-folder-packer.js"),
      );
      const packed = await packContextSkillFolder({
        playgroundRootPath: directory,
        folderPath: path.basename(targetPath),
        signal,
      });
      const response = await client.request("/api/agent/v1/skills/packages", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-package-sha256": packed.archiveSha256,
          "idempotency-key": packed.packageSha256,
          "x-teamhub-operation-id": packed.packageSha256,
        },
        body: Uint8Array.from(packed.archive),
      });
      const result = (await response.json()) as Record<string, unknown>;
      await emit({
        status: result.replayed ? "unchanged" : "published",
        ...result,
      });
      return;
    }
    const result = await copies.replace(
      String(command.body.document_id),
      targetPath,
    );
    await emit({
      status: result.unchanged ? "unchanged" : "replaced",
      document_id: result.documentId,
      revision_id: result.versionId,
      history_entry_id: result.historyEntryId,
      name: result.name,
      unchanged: result.unchanged,
    });
  });
}
function saveCommand(
  args: readonly string[],
  shell: "powershell" | "sh",
): string {
  return `teamhub ${args
    .map((value) => {
      // PowerShell treats smart single quotes as delimiters as well.
      const escaped =
        shell === "powershell"
          ? value.replace(/['\u2018-\u201b]/gu, (quote) => quote + quote)
          : value.replaceAll("'", "'\\''");
      return `'${escaped}'`;
    })
    .join(" ")}`;
}

function assertPublicPath(filename: string): void {
  if (filename.split(path.sep).some(isExcludedPublicationEntry))
    throw new CliError(
      "forbidden",
      "Private configuration, repository metadata and installed dependencies cannot be published or overwritten.",
    );
}
