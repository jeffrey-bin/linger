import { encodeExecutionContextRef } from "./context-ref.js";
import type { ExecutionContextRef } from "./context-ref.js";
import type { AgentLogger } from "../observability/agent-log.js";
import { randomUUID } from "node:crypto";
import type { TeamHubRuntimeStateClient } from "./teamhub-runtime-state-client.js";
import type { RunActivityContentBlock, RunEvent } from "./provider.js";
import type { RuntimeStateAwaitable } from "./context-runtime-state.js";

/** The Run events TeamHub persists as the status line and Activity log. */
export type RuntimeStatusUpdate = Readonly<
  Extract<
    RunEvent,
    {
      readonly type:
        | "status.changed"
        | "plan.updated"
        | "activity.started"
        | "activity.updated"
        | "activity.finished";
    }
  >
>;

/** Publishes a Run's status updates; each call sends one ordered batch. */
export interface RuntimeStatusSession {
  publish(updates: readonly RuntimeStatusUpdate[]): RuntimeStateAwaitable<void>;
}

export interface RuntimeStatusOpenInput {
  readonly executionId: string;
  readonly ref: ExecutionContextRef;
  /** The Agent Service epoch that claimed the Run. */
  readonly epoch: string;
  readonly sourceInboxIds: readonly string[];
}

export interface RuntimeStatusPublisher {
  open(input: RuntimeStatusOpenInput): Promise<RuntimeStatusSession>;
  close(): Promise<void>;
}

export interface RuntimeStatusPublisherOptions {
  readonly client: TeamHubRuntimeStateClient;
  readonly logger?: AgentLogger;
}

export const createRuntimeStatusPublisher = (
  options: RuntimeStatusPublisherOptions,
): RuntimeStatusPublisher => new TeamHubRuntimeStatusPublisher(options);

class TeamHubRuntimeStatusPublisher implements RuntimeStatusPublisher {
  readonly #options: RuntimeStatusPublisherOptions;
  #closed = false;

  constructor(options: RuntimeStatusPublisherOptions) {
    this.#options = options;
  }

  async open(input: RuntimeStatusOpenInput): Promise<RuntimeStatusSession> {
    if (this.#closed) return NOOP_SESSION;
    if (!input.executionId.trim() || input.sourceInboxIds.length === 0) {
      this.#log("warn", "runtime_status.invalid_open", {
        executionId: input.executionId,
      });
      return NOOP_SESSION;
    }

    // TeamHub checks the epoch against the current one and the Run's.
    const result = await this.#options.client.openStatus({
      context_key: encodeExecutionContextRef(input.ref),
      epoch: input.epoch,
      local_run_id: input.executionId,
      initial_source_ids: [...new Set(input.sourceInboxIds)],
    });
    if (!result.opened) return NOOP_SESSION;

    const session = new TeamHubRuntimeStatusSession({
      publish: (updates) => this.#publish(input.executionId, updates),
    });
    await session.publish([{ type: "status.changed", status: "working" }]);
    return session;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async #publish(
    executionId: string,
    updates: readonly RuntimeStatusUpdate[],
  ): Promise<void> {
    if (this.#closed) return;
    const events: OfferedEvent[] = [];
    for (const update of updates) {
      try {
        events.push({
          command_id: `offer-presentation-event-${randomUUID().replaceAll("-", "")}`,
          event: toContractEvent(update),
        });
      } catch (error) {
        // One malformed update must not drop the rest of its batch.
        this.#log("warn", "runtime_status.update_invalid", {
          executionId,
          eventType: update.type,
          error,
        });
      }
    }
    if (events.length === 0) return;
    await this.#options.client.offerPresentationEvents({
      local_run_id: executionId,
      events,
    });
  }

  #log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    try {
      this.#options.logger?.log(level, event, fields);
    } catch {
      // Status observation must not alter Runtime execution semantics.
    }
  }
}

type OfferedEvent = Parameters<
  RuntimeStatusPublisherOptions["client"]["offerPresentationEvents"]
>[0]["events"][number];

class TeamHubRuntimeStatusSession implements RuntimeStatusSession {
  readonly #publishUpdates: (
    updates: readonly RuntimeStatusUpdate[],
  ) => Promise<void>;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly publish: (
      updates: readonly RuntimeStatusUpdate[],
    ) => Promise<void>;
  }) {
    this.#publishUpdates = options.publish;
  }

  publish(updates: readonly RuntimeStatusUpdate[]): Promise<void> {
    const batch = [...updates];
    const operation = this.#tail.then(async () => {
      if (batch.length > 0) await this.#publishUpdates(batch);
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

const NOOP_SESSION: RuntimeStatusSession = Object.freeze({
  publish: () => undefined,
});

const toContractEvent = (
  update: RuntimeStatusUpdate,
): OfferedEvent["event"] => {
  if (update.type === "status.changed") {
    if (update.status !== "working" && update.status !== "thinking") {
      throw new TypeError("Runtime status must be working or thinking");
    }
    if (update.title !== undefined) {
      if (
        update.status !== "thinking" ||
        update.title.trim().length === 0 ||
        [...update.title].length > 50_000
      ) {
        throw new TypeError(
          "Runtime thinking title must be a non-empty string of at most 50000 characters",
        );
      }
    }
    return {
      type: "status.changed",
      status: update.status,
      ...(update.title === undefined ? {} : { title: update.title }),
    };
  }
  if (update.type === "activity.started") {
    assertActivityId(update.activityId);
    assertPublicActivityText(update.title, "title");
    assertPublicActivityContent(update.content);
    return {
      type: update.type,
      activity_id: update.activityId,
      kind: update.kind,
      title: update.title,
      ...(update.content === undefined
        ? {}
        : { content: update.content.map((block) => ({ ...block })) }),
    };
  }
  if (update.type === "activity.updated") {
    assertActivityId(update.activityId);
    assertPublicActivityText(update.detail, "detail");
    return {
      type: update.type,
      activity_id: update.activityId,
      detail: update.detail,
    };
  }
  if (update.type === "activity.finished") {
    assertActivityId(update.activityId);
    assertPublicActivityContent(update.content);
    return {
      type: update.type,
      activity_id: update.activityId,
      outcome: update.outcome,
      ...(update.content === undefined
        ? {}
        : { content: update.content.map((block) => ({ ...block })) }),
    };
  }
  if (!Array.isArray(update.steps)) {
    throw new TypeError("Runtime status update type is invalid");
  }
  if (
    update.explanation !== undefined &&
    typeof update.explanation !== "string"
  ) {
    throw new TypeError("Runtime plan explanation must be a string");
  }
  return {
    type: "plan.updated",
    ...(update.explanation === undefined
      ? {}
      : { explanation: update.explanation }),
    steps: update.steps.map((step) => ({ ...step })),
  };
};

const activityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const assertActivityId = (activityId: string): void => {
  if (!activityIdPattern.test(activityId)) {
    throw new TypeError("Runtime activity ID is invalid");
  }
};

const assertPublicActivityText = (value: string, field: string): void => {
  if (value.trim().length === 0 || [...value].length > 200) {
    throw new TypeError(
      `Runtime activity ${field} must be a non-empty string of at most 200 characters`,
    );
  }
};

const assertPublicActivityContent = (
  blocks: readonly RunActivityContentBlock[] | undefined,
): void => {
  if (blocks === undefined) return;
  if (blocks.length > 6) {
    throw new TypeError(
      "Runtime activity content must contain at most 6 blocks",
    );
  }
  for (const block of blocks) {
    if (
      !["text", "code", "json"].includes(block.format) ||
      block.content.trim().length === 0 ||
      [...block.content].length > 4000 ||
      (block.label !== undefined &&
        (block.label.trim().length === 0 || [...block.label].length > 80))
    ) {
      throw new TypeError("Runtime activity content block is invalid");
    }
  }
};
