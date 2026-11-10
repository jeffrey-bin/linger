import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { components } from "@linger/wire-contracts/node-services-internal/types";
import type { DocumentDurabilityFailureCode } from "./realtime-durability.js";
import { documentLogger } from "./log.js";

interface FailureEvidence {
  document_id: string;
  failure_code: DocumentDurabilityFailureCode;
  failure_at: string;
  released_at: string;
  head: components["schemas"]["DocumentDurableHead"];
  pending: Array<{
    kind: "mutation";
    actor_id: string;
    update_base64: string;
    update_bytes: number;
  }>;
  pending_bytes: number;
}

const maxDirectoryBytes = 256 << 20;
const EVIDENCE_EVENT = "document_durability_failure_evidence";

// Synchronous writes serialize eviction and capture with queue release. Evidence
// is bounded by the existing per-Document unsaved backlog limit, not a new limit.
export class DocumentFailureEvidenceStore {
  readonly #directory: string;
  readonly #runtimeInstanceId: string;
  readonly #initializationError?: string;

  constructor(input: { directory?: string; runtimeInstanceId: string }) {
    this.#directory =
      input.directory ?? join(tmpdir(), "document-runtime-failure-evidence");
    this.#runtimeInstanceId = input.runtimeInstanceId;
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      chmodSync(this.#directory, 0o700);
    } catch (error) {
      this.#initializationError = errorMessage(error);
      documentLogger().log(
        "error",
        "document_failure_evidence_directory_error",
        {
          write_error: errorMessage(error),
        },
      );
    }
  }

  record(evidence: FailureEvidence): void {
    const metadata = {
      document_id: evidence.document_id,
      failure_code: evidence.failure_code,
      failure_at: evidence.failure_at,
      released_at: evidence.released_at,
      pending_count: evidence.pending.length,
      pending_bytes: evidence.pending_bytes,
      persisted_seq: evidence.head.persisted_seq,
      runtime_instance_id: this.#runtimeInstanceId,
    };
    let descriptor: number | undefined;
    try {
      if (this.#initializationError !== undefined)
        throw new Error(this.#initializationError);
      if ((statSync(this.#directory).mode & 0o077) !== 0)
        throw new Error("Evidence directory is not private");
      const path = join(
        this.#directory,
        `${evidence.document_id}-${evidence.failure_at}.json`,
      );
      const bytes = Buffer.from(
        JSON.stringify({
          ...evidence,
          runtime_instance_id: this.#runtimeInstanceId,
        }),
      );
      const files = readdirSync(this.#directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const filePath = join(this.#directory, entry.name);
          const stat = statSync(filePath);
          return { path: filePath, bytes: stat.size, modified: stat.mtimeMs };
        })
        .sort(
          (left, right) =>
            left.modified - right.modified ||
            left.path.localeCompare(right.path),
        );
      let total =
        bytes.byteLength +
        files.reduce(
          (size, file) => size + (file.path === path ? 0 : file.bytes),
          0,
        );
      for (const file of files) {
        if (total <= maxDirectoryBytes) break;
        if (file.path === path) continue;
        unlinkSync(file.path);
        total -= file.bytes;
      }
      // Never follow a link or expose bytes through a previously permissive file.
      if (total > maxDirectoryBytes)
        throw new Error("Evidence exceeds the directory budget");
      descriptor = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      if (!fstatSync(descriptor).isFile())
        throw new Error("Evidence target is not a file");
      writeFileSync(descriptor, bytes);
      documentLogger().log("info", EVIDENCE_EVENT, {
        ...metadata,
        evidence_path: path,
      });
    } catch (error) {
      // Capturing diagnostic evidence must never retain a failed resident queue.
      documentLogger().log("error", EVIDENCE_EVENT, {
        ...metadata,
        write_error: errorMessage(error),
      });
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (error) {
          documentLogger().log("error", EVIDENCE_EVENT, {
            ...metadata,
            write_error: errorMessage(error),
          });
        }
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
