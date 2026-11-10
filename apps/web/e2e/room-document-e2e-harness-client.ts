import type { APIRequestContext, APIResponse } from "@playwright/test";

const harnessUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT ?? "8088"}`;
const teamHubUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT ?? "8089"}`;

export interface RoomDocumentE2EFixture {
  document_id: string;
  room_id: string;
  tenant_id: string;
}

export interface RoomDocumentCommentThread {
  anchor_status: "attached" | "orphaned" | "pending";
  comments: Array<{
    id: string;
    segments: Array<
      | { content: string; type: "text" }
      | {
          actor_id: string;
          content: string;
          type: "reference";
        }
    >;
  }>;
  id: string;
}

interface HarnessState {
  persisted_seq: number;
  session_open_success_count: number;
}

export class RoomDocumentE2EHarnessClient {
  constructor(private readonly request: APIRequestContext) {}

  async cleanup(): Promise<void> {
    await this.#post("/__e2e/cleanup");
  }

  async reset(): Promise<RoomDocumentE2EFixture> {
    return this.#post<RoomDocumentE2EFixture>("/__e2e/reset");
  }

  async holdAppends(): Promise<void> {
    await this.#post("/__e2e/append/hold");
  }

  async releaseAppends(): Promise<void> {
    await this.#post("/__e2e/append/release");
  }

  async connectOwnerComputer(): Promise<void> {
    await this.#post("/__e2e/computer/online");
  }

  async fireRoutineOccurrence(routineId: string): Promise<void> {
    await this.#post(`/__e2e/routines/${encodeURIComponent(routineId)}/fire`);
  }

  async failNextAppendPermanently(): Promise<void> {
    await this.#post("/__e2e/append/fail-next-permanently");
  }

  async listDocumentCommentThreads(
    documentId: string,
  ): Promise<RoomDocumentCommentThread[]> {
    const page = await this.#teamHubJson<{
      items: RoomDocumentCommentThread[];
    }>(
      `/v0/documents/${encodeURIComponent(documentId)}/comment-threads?limit=100`,
      { method: "GET", status: 200 },
    );
    return page.items;
  }

  async stopRuntime(): Promise<void> {
    await this.#post("/__e2e/runtime/stop");
  }

  async startRuntime(): Promise<void> {
    await this.#post("/__e2e/runtime/start");
  }

  async state(): Promise<HarnessState> {
    const response = await this.request.get(`${harnessUrl}/__e2e/state`);
    await expectHarnessResponse(response, "/__e2e/state");
    return response.json() as Promise<HarnessState>;
  }

  async #post<T = void>(path: string): Promise<T> {
    const response = await this.request.post(`${harnessUrl}${path}`);
    await expectHarnessResponse(response, path);
    return response.json() as Promise<T>;
  }

  async #teamHubJson<T = Record<string, unknown>>(
    path: string,
    options: {
      data?: unknown;
      headers?: Record<string, string>;
      method: "DELETE" | "GET" | "POST" | "PUT";
      status: number;
    },
  ): Promise<T> {
    const response = await this.request.fetch(`${teamHubUrl}${path}`, {
      ...(options.data === undefined ? {} : { data: options.data }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      method: options.method,
    });
    if (response.status() !== options.status) {
      throw new Error(
        `${options.method} ${path} returned ${response.status()}, expected ${options.status}: ${(await response.text()).slice(0, 2_048)}`,
      );
    }
    const body = await response.text();
    return (body === "" ? {} : JSON.parse(body)) as T;
  }
}

async function expectHarnessResponse(
  response: APIResponse,
  path: string,
): Promise<void> {
  if (response.ok()) {
    return;
  }
  throw new Error(
    `${path} returned ${response.status()}: ${(await response.text()).slice(0, 2_048)}`,
  );
}
