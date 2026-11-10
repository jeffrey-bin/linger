import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AgentRunnerEnsure,
  AgentRunnerFailed,
  AgentRunnerReady,
  AgentRunnerRemove,
  AgentRunnerRemoved,
  AgentRunnerSnapshot,
} from "@linger/wire-contracts/runner-gateway/types";

import { assertRunnerGatewayTopology } from "../contracts/codegen/runner-asyncapi-topology.mjs";

interface AsyncApiReference {
  $ref: string;
}

interface RunnerGatewayAsyncApi {
  readonly info: {
    readonly description: string;
  };
  readonly channels: Record<
    string,
    {
      readonly address: string;
      readonly messages: Record<string, AsyncApiReference>;
    }
  >;
  readonly operations: Record<
    string,
    {
      readonly action: string;
      readonly channel: AsyncApiReference;
      readonly messages: readonly AsyncApiReference[];
    }
  >;
  readonly components: {
    readonly messages: Record<
      string,
      {
        readonly name: string;
        readonly contentType: string;
        readonly payload: AsyncApiReference;
      }
    >;
  };
}

const asyncApiPath = new URL(
  "../contracts/runner-gateway/asyncapi.yaml",
  import.meta.url,
);

type StableAgentRunnerDefinitions =
  | AgentRunnerEnsure
  | AgentRunnerRemove
  | AgentRunnerReady
  | AgentRunnerRemoved
  | AgentRunnerFailed
  | AgentRunnerSnapshot;

describe("Runner Gateway AsyncAPI source contract", () => {
  it("exports stable generated Agent Runner definition names", () => {
    expectTypeOf<StableAgentRunnerDefinitions>().not.toBeNever();
  });

  it("binds Agent Service send and receive directions to the matching schemas", async () => {
    const contract = parse(
      await readFile(asyncApiPath, "utf8"),
    ) as RunnerGatewayAsyncApi;

    expect(Object.keys(contract.channels).sort()).toEqual(["runnerGateway"]);
    expect(contract.info.description).toContain("Agent Runner desired state");
    expect(contract.info.description).toContain("connection epoch");
    expect(contract.channels.runnerGateway).toEqual({
      address: "/v1/runner-gateway",
      messages: {
        agentToDaemon: {
          $ref: "#/components/messages/AgentToDaemonEnvelope",
        },
        daemonToAgent: {
          $ref: "#/components/messages/DaemonToAgentEnvelope",
        },
      },
    });
    expect(Object.keys(contract.operations).sort()).toEqual([
      "agentServiceReceives",
      "agentServiceSends",
    ]);
    expect(contract.operations.agentServiceSends).toEqual({
      action: "send",
      channel: { $ref: "#/channels/runnerGateway" },
      messages: [{ $ref: "#/channels/runnerGateway/messages/agentToDaemon" }],
    });
    expect(contract.operations.agentServiceReceives).toEqual({
      action: "receive",
      channel: { $ref: "#/channels/runnerGateway" },
      messages: [{ $ref: "#/channels/runnerGateway/messages/daemonToAgent" }],
    });
    expect(contract.components.messages).toMatchObject({
      AgentToDaemonEnvelope: {
        name: "AgentToDaemonEnvelope",
        contentType: "application/json",
        payload: {
          $ref: "./envelope.schema.json#/$defs/AgentToDaemonEnvelope",
        },
      },
      DaemonToAgentEnvelope: {
        name: "DaemonToAgentEnvelope",
        contentType: "application/json",
        payload: {
          $ref: "./envelope.schema.json#/$defs/DaemonToAgentEnvelope",
        },
      },
    });
    expect(() => assertRunnerGatewayTopology(contract)).not.toThrow();
  });

  it("rejects a payload reference assigned to the wrong direction", async () => {
    const contract = parse(
      await readFile(asyncApiPath, "utf8"),
    ) as RunnerGatewayAsyncApi;
    const reversed = structuredClone(contract);
    reversed.components.messages.AgentToDaemonEnvelope.payload.$ref =
      "./envelope.schema.json#/$defs/DaemonToAgentEnvelope";

    expect(() => assertRunnerGatewayTopology(reversed)).toThrow(
      "must preserve the Agent Service send/receive directions",
    );
  });
});
