import { createHash } from "node:crypto";
import type { TeamHubFileBackend } from "./files/teamhub-working-copies.js";
import type { components as TeamHubPublic } from "@linger/wire-contracts/teamhub-public/types";
import { CliError } from "./errors.js";
import {
  readBounded,
  teamHubData,
  type TeamHubHttpClient,
} from "./http-client.js";
import { displayText } from "./display-text.js";

const root = "/api/agent/v1/files";
const invalid = () =>
  new CliError("invalid_response", "TeamHub returned invalid file metadata.");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, displayText(value));
  return params.size ? `?${params.toString()}` : "";
}
function linkToken(value: string): string | undefined {
  if (/^doc_link_[A-Za-z0-9_-]{43}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      /^#doc_link_[A-Za-z0-9_-]{43}$/.test(url.hash)
    )
      return url.hash.slice(1);
  } catch {
    /* Ordinary name. */
  }
  return undefined;
}

export function createFileBackend(
  client: TeamHubHttpClient,
): TeamHubFileBackend & {
  list(options?: {
    sharedWithMe?: boolean;
  }): Promise<Record<string, unknown>[]>;
} {
  const list = async (options: { sharedWithMe?: boolean } = {}) => {
    const files: Record<string, unknown>[] = [];
    let after = "";
    for (;;) {
      const result = await teamHubData(
        client.api.GET("/api/agent/v1/files", {
          params: {
            query: {
              after_id: after,
              limit: 100,
              ...(options.sharedWithMe ? { shared_with_me: true } : {}),
            },
          },
        }),
      );
      if (!Array.isArray(result.files)) throw invalid();
      for (const file of result.files) {
        if (
          !record(file) ||
          typeof file.document_id !== "string" ||
          file.document_id <= after ||
          typeof file.name !== "string"
        )
          throw invalid();
        files.push(file);
        after = file.document_id;
      }
      if (result.files.length < 100) return files;
    }
  };
  return {
    list,
    async download(name, selectedFormat) {
      const token = linkToken(name);
      let documentId = /^document_[A-Za-z0-9_-]+$/.test(name)
        ? name
        : undefined;
      if (!documentId && !token) {
        const matches = (await list()).filter((file) => file.name === name);
        if (matches.length === 0)
          throw new CliError(
            "not_found",
            "No readable file matches that name.",
          );
        if (matches.length > 1)
          throw new CliError(
            "ambiguous_name",
            "Multiple readable Documents match that name. Retry with a Document ID.",
            { candidates: matches.map((file) => file.document_id) },
          );
        documentId = matches[0]!.document_id as string;
      }
      if (
        token &&
        selectedFormat !== undefined &&
        selectedFormat !== "markdown"
      )
        throw new CliError(
          "invalid_input",
          "Native editing requires a Document ID and Agent read access.",
        );
      const response = token
        ? await client.request("/v0/shared-documents/content", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token,
            } satisfies TeamHubPublic["schemas"]["ResolveDocumentLinkShare"]),
          })
        : await client.request(
            `${root}/${encodeURIComponent(documentId!)}${"/content"}${query({ format: selectedFormat })}`,
            { method: "GET" },
          );
      if (response.status === 202)
        throw new CliError(
          "projection_pending",
          "Current Document content is being prepared; retry shortly.",
        );
      const content = await readBounded(response, 50 * 1024 * 1024);
      const sha256 = response.headers.get("x-content-sha256") ?? "";
      const versionId = response.headers.get("x-document-version-id") ?? "";
      const encodedName = response.headers.get("x-document-filename") ?? "";
      const filename = Buffer.from(encodedName, "base64url").toString("utf8");
      const readOnly = response.headers.get("x-document-read-only");
      documentId ??= response.headers.get("x-document-id") ?? undefined;
      if (
        !documentId ||
        !versionId ||
        !filename ||
        /[/\\\0]/u.test(filename) ||
        Buffer.from(filename).toString("base64url") !== encodedName ||
        !["true", "false"].includes(readOnly ?? "") ||
        createHash("sha256").update(content).digest("hex") !== sha256
      )
        throw invalid();
      return {
        documentId,
        versionId,
        name: filename,
        sha256,
        readOnly: readOnly === "true",
        content,
        ...(token ? { linkToken: token } : {}),
      };
    },
    async replace(input) {
      let response: Response;
      try {
        response = await client.request(
          `${root}/${encodeURIComponent(input.documentId)}/body${query({ base_revision_id: input.baseVersionId, operation_id: input.operationId, format: input.format })}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              "x-teamhub-operation-id": input.operationId,
            },
            body: new Blob([Uint8Array.from(input.content)]),
          },
        );
      } catch (error) {
        // The Operation ID comes from the file, not from --operation-id.
        if (error instanceof CliError && error.code === "outcome_unknown")
          throw new CliError(
            "outcome_unknown",
            "The replacement outcome is unknown. Run the same command again without editing the file: TeamHub returns the original result instead of replacing twice.",
            error.details,
          );
        throw error;
      }
      const result: unknown = await response.json();
      if (
        !record(result) ||
        result.document_id !== input.documentId ||
        typeof result.revision_id !== "string" ||
        typeof result.history_entry_id !== "string" ||
        result.sha256 !== input.sha256
      )
        throw invalid();
      return {
        documentId: input.documentId,
        versionId: result.revision_id,
        historyEntryId: result.history_entry_id,
        name: input.name,
        readOnly: true,
        format: input.format,
        sha256: input.sha256,
        unchanged: false,
      };
    },
  };
}
