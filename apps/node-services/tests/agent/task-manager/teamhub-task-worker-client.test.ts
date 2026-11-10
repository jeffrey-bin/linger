import { describe, expect, it } from "vitest";

import {
  createTeamHubTaskWorkerClient,
  type TaskExecution,
  type TaskWorkerExecution,
  type TaskWorkerLease,
  type TeamHubTaskWorkerFetch,
} from "../../../src/agent/task-manager/index.js";
import { requestUrlText } from "@linger/service-kit";

describe("TeamHub Task Worker client", () => {
  it("claims with the service credential and treats 204 as no work", async () => {
    const requests: CapturedRequest[] = [];
    const client = createTeamHubTaskWorkerClient({
      baseUrl: "https://teamhub.test/root?ignored=true#fragment",
      serviceToken: "service-secret",
      fetch: captureFetch(requests, [new Response(null, { status: 204 })]),
    });

    await expect(
      client.claim({ workerId: "worker-1", leaseSeconds: 15 }),
    ).resolves.toEqual({ claimed: null });
    expect(requests).toEqual([
      expect.objectContaining({
        url: "https://teamhub.test/root/v0/task-execution-claims",
        method: "POST",
        authorization: "Bearer service-secret",
        leaseToken: null,
        body: { worker_id: "worker-1", lease_seconds: 15 },
      }),
    ]);
  });

  it("reads TeamHub's next claim delay from an empty claim", async () => {
    const empty = (delay?: string) =>
      new Response(null, {
        status: 204,
        headers:
          delay === undefined ? {} : { "Task-Next-Claim-Delay-Ms": delay },
      });
    const client = createTeamHubTaskWorkerClient({
      baseUrl: "https://teamhub.test",
      serviceToken: "service-secret",
      fetch: captureFetch(
        [],
        [empty("1500"), empty("0"), empty("-1"), empty("soon")],
      ),
    });
    const claim = () =>
      client.claim({ workerId: "worker-1", leaseSeconds: 15 });

    await expect(claim()).resolves.toEqual({
      claimed: null,
      nextClaimDelayMs: 1500,
    });
    await expect(claim()).resolves.toEqual({
      claimed: null,
      nextClaimDelayMs: 0,
    });
    // A malformed delay is treated as absent.
    await expect(claim()).resolves.toEqual({ claimed: null });
    await expect(claim()).resolves.toEqual({ claimed: null });
  });

  it("lease-fences get, heartbeat, and generated transition fields", async () => {
    const requests: CapturedRequest[] = [];
    const lease = taskLease({ task_id: "task/1" });
    const execution = taskExecution({ task_id: "task/1" });
    const client = createTeamHubTaskWorkerClient({
      baseUrl: "https://teamhub.test/root",
      serviceToken: "service-secret",
      fetch: captureFetch(requests, [
        jsonResponse({ lease, execution }),
        jsonResponse(lease),
        jsonResponse({ lease, execution }),
      ]),
    });

    await client.get({ lease });
    await client.heartbeat({ lease, leaseSeconds: 30 });
    await client.transition({
      lease,
      execution,
      expectedControlRevision: 4,
      transition: "record_agent_turn",
      operationId: "operation-1",
      payload: { effect_id: "effect-1", participant_runs: [] },
    });

    expect(requests).toEqual([
      expect.objectContaining({
        url: "https://teamhub.test/root/v0/task-executions/task%2F1?worker_id=worker-1&lease_generation=2",
        method: "GET",
        leaseToken: lease.lease_token,
        body: undefined,
      }),
      expect.objectContaining({
        url: "https://teamhub.test/root/v0/task-executions/task%2F1/heartbeat",
        method: "POST",
        leaseToken: lease.lease_token,
        body: {
          worker_id: "worker-1",
          lease_generation: 2,
          lease_seconds: 30,
        },
      }),
      expect.objectContaining({
        url: "https://teamhub.test/root/v0/task-executions/task%2F1/transitions",
        method: "POST",
        leaseToken: lease.lease_token,
        body: {
          worker_id: "worker-1",
          lease_generation: 2,
          execution_generation: 3,
          expected_execution_revision: 7,
          expected_control_revision: 4,
          transition: "record_agent_turn",
          operation_id: "operation-1",
          payload: { effect_id: "effect-1", participant_runs: [] },
        },
      }),
    ]);
  });
});

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly leaseToken: string | null;
  readonly body: unknown;
}

const captureFetch = (
  requests: CapturedRequest[],
  responses: readonly Response[],
): TeamHubTaskWorkerFetch => {
  let index = 0;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: requestUrlText(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      leaseToken: headers.get("Task-Lease-Token"),
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("Unexpected HTTP request");
    return response;
  };
};

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const taskLease = (
  overrides: Partial<TaskWorkerLease> = {},
): TaskWorkerLease => ({
  task_id: "task-1",
  worker_id: "worker-1",
  lease_token: "a".repeat(43),
  lease_generation: 2,
  lease_expires_at: "2030-01-01T00:00:15Z",
  ...overrides,
});

const taskExecution = (
  overrides: Partial<TaskExecution> = {},
): TaskExecution => ({
  task_id: "task-1",
  generation: 3,
  status: "running",
  execution_revision: 7,
  desired_control: "run",
  control_revision: 4,
  control_settled_revision: 4,
  run_spec: {
    schema_version: 1,
    result_agent_actor_id: "actor-result",
    attempt_policy: {
      policy_version: 1,
      timeout_seconds: 1_800,
      max_retries: 3,
      retry_on_agent_failure: true,
      retry_on_timeout: true,
    },
  },
  participants: [],
  pending_effects: [],
  execution_facts: [],
  execution_updated_at: "2030-01-01T00:00:00Z",
  ...overrides,
});

const _contractFixture: TaskWorkerExecution = {
  lease: taskLease(),
  execution: taskExecution(),
};
void _contractFixture;
