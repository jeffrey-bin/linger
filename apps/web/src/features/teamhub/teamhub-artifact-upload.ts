import { inferDocumentMediaType } from "@linger/document-files/media-type";
import { type TeamHubAuthenticationReason } from "./teamhub-authentication";
import { readTeamHubError } from "./teamhub-error";

interface TeamHubUploadResponse {
  body: string;
  status: number;
}

const defaultUploadTimeoutMs = 10 * 60 * 1_000;

export async function uploadTeamHubFile<T>({
  additionalFields,
  file,
  idempotencyKey,
  onAuthenticationRequired,
  onProgress,
  parentId,
  signal,
  timeoutMs,
  url,
  xhrFactory,
}: {
  additionalFields?: Readonly<Record<string, string | undefined>>;
  file: File;
  idempotencyKey: string;
  onAuthenticationRequired: (reason: TeamHubAuthenticationReason) => void;
  onProgress?: (progress: number) => void;
  parentId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: string;
  xhrFactory?: () => XMLHttpRequest;
}): Promise<T> {
  const body = new FormData();

  for (const [name, value] of Object.entries(additionalFields ?? {})) {
    if (["content", "filename", "media_type", "parent_id"].includes(name)) {
      throw new Error(`TeamHub upload field ${name} is reserved.`);
    }
    if (value !== undefined) {
      body.set(name, value);
    }
  }

  body.set("filename", file.name);
  body.set("media_type", inferDocumentMediaType(file.name, file.type));
  body.set("content", file);
  if (parentId) {
    body.set("parent_id", parentId);
  }
  const response = await sendTeamHubMultipartUpload({
    body,
    idempotencyKey,
    onProgress,
    signal,
    timeoutMs,
    url,
    xhrFactory,
  });

  // A proxy gave up while the body was still on its way, usually because the
  // network uplink is too slow for the file. The proxy body is not TeamHub JSON.
  if (uploadTimeoutStatuses.has(response.status)) {
    throw new Error(
      `The upload timed out before it reached TeamHub (HTTP ${response.status}). The network upload speed is too slow for this file. Retry, or use a smaller file.`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const error = await readTeamHubError(
      new Response(response.body, {
        headers: { "content-type": "application/json" },
        status: response.status,
      }),
    );
    if (response.status === 401) {
      onAuthenticationRequired("session-expired");
    }
    throw error;
  }

  onProgress?.(1);
  return JSON.parse(response.body) as T;
}

const uploadTimeoutStatuses = new Set([408, 504, 522, 524]);

function sendTeamHubMultipartUpload({
  body,
  idempotencyKey,
  onProgress,
  signal,
  timeoutMs = defaultUploadTimeoutMs,
  url,
  xhrFactory = () => new XMLHttpRequest(),
}: {
  body: FormData;
  idempotencyKey: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: string;
  xhrFactory?: () => XMLHttpRequest;
}): Promise<TeamHubUploadResponse> {
  return new Promise((resolve, reject) => {
    const request = xhrFactory();
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", abortRequest);
    const resolveOnce = (response: TeamHubUploadResponse) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(response);
      }
    };
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const abortRequest = () => request.abort();

    request.open("POST", url);
    request.timeout = timeoutMs;
    request.withCredentials = true;
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Idempotency-Key", idempotencyKey);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        if (!settled) {
          onProgress?.(Math.min(event.loaded / event.total, 1));
        }
      }
    };
    request.onload = () => {
      resolveOnce({ body: request.responseText, status: request.status });
    };
    request.onerror = () => {
      rejectOnce(new Error("TeamHub upload could not reach the server."));
    };
    request.onabort = () => {
      rejectOnce(
        new DOMException("TeamHub upload was cancelled.", "AbortError"),
      );
    };
    request.ontimeout = () => {
      rejectOnce(new Error("TeamHub upload timed out."));
    };

    if (signal?.aborted) {
      rejectOnce(
        new DOMException("TeamHub upload was cancelled.", "AbortError"),
      );
      return;
    }
    signal?.addEventListener("abort", abortRequest, { once: true });
    try {
      onProgress?.(0);
      request.send(body);
    } catch (error) {
      rejectOnce(
        error instanceof Error
          ? error
          : new Error("TeamHub upload could not be started."),
      );
    }
  });
}
