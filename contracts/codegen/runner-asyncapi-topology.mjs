const AGENT_PAYLOAD_REF = "./envelope.schema.json#/$defs/AgentToDaemonEnvelope";
const DAEMON_PAYLOAD_REF =
  "./envelope.schema.json#/$defs/DaemonToAgentEnvelope";

export function assertRunnerGatewayTopology(asyncApi) {
  const channel = asyncApi?.channels?.runnerGateway;
  const sends = asyncApi?.operations?.agentServiceSends;
  const receives = asyncApi?.operations?.agentServiceReceives;
  const agentMessage = asyncApi?.components?.messages?.AgentToDaemonEnvelope;
  const daemonMessage = asyncApi?.components?.messages?.DaemonToAgentEnvelope;

  if (
    !hasExactKeys(asyncApi?.channels, ["runnerGateway"]) ||
    channel?.address !== "/v1/runner-gateway" ||
    !hasExactKeys(channel?.messages, ["agentToDaemon", "daemonToAgent"]) ||
    channel.messages.agentToDaemon?.$ref !==
      "#/components/messages/AgentToDaemonEnvelope" ||
    channel.messages.daemonToAgent?.$ref !==
      "#/components/messages/DaemonToAgentEnvelope" ||
    !hasExactKeys(asyncApi?.operations, [
      "agentServiceSends",
      "agentServiceReceives",
    ]) ||
    sends?.action !== "send" ||
    sends?.channel?.$ref !== "#/channels/runnerGateway" ||
    !hasSingleRef(
      sends?.messages,
      "#/channels/runnerGateway/messages/agentToDaemon",
    ) ||
    receives?.action !== "receive" ||
    receives?.channel?.$ref !== "#/channels/runnerGateway" ||
    !hasSingleRef(
      receives?.messages,
      "#/channels/runnerGateway/messages/daemonToAgent",
    ) ||
    agentMessage?.name !== "AgentToDaemonEnvelope" ||
    agentMessage?.contentType !== "application/json" ||
    agentMessage?.payload?.$ref !== AGENT_PAYLOAD_REF ||
    daemonMessage?.name !== "DaemonToAgentEnvelope" ||
    daemonMessage?.contentType !== "application/json" ||
    daemonMessage?.payload?.$ref !== DAEMON_PAYLOAD_REF
  ) {
    throw new Error(
      "Runner Gateway AsyncAPI must preserve the Agent Service send/receive directions and JSON Schema payload references",
    );
  }
}

function hasExactKeys(value, expectedKeys) {
  return (
    typeof value === "object" &&
    value !== null &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function hasSingleRef(value, expectedRef) {
  return (
    Array.isArray(value) && value.length === 1 && value[0]?.$ref === expectedRef
  );
}
