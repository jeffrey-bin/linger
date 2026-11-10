import {
  COMPUTER_OFFLINE_MESSAGE,
  ModelCallError,
  type RuntimeModelGateway,
} from "../../runtime-model-call.js";
import { LocalComputerOfflineError } from "./local-computer-management.js";
import { RunnerModelInvokeUnavailableError } from "./runner-model-invocation.js";

/** The Runner Gateway's model invocation with its failures as ModelCallError,
 * so the host-level model call never depends on agent role modules. */
export function runtimeModelGateway(
  gateway: RuntimeModelGateway,
): RuntimeModelGateway {
  return {
    supportsModelInvoke: (computerId, runtimeType) =>
      gateway.supportsModelInvoke(computerId, runtimeType),
    runtimeModels: (computerId, runtimeType) =>
      gateway.runtimeModels(computerId, runtimeType),
    acquireModelChain: async (endpoint, work, signal) => {
      try {
        return await gateway.acquireModelChain(endpoint, work, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw modelCallFailure(error);
      }
    },
    invokeModel: async (computerId, request) => {
      try {
        return await gateway.invokeModel(computerId, request);
      } catch (error) {
        if (request.signal.aborted) throw error;
        throw modelCallFailure(error);
      }
    },
  };
}

function modelCallFailure(error: unknown): unknown {
  if (error instanceof LocalComputerOfflineError)
    return new ModelCallError(
      "computer_offline",
      `${COMPUTER_OFFLINE_MESSAGE}: ${error.message}`,
      { cause: error },
    );
  if (error instanceof RunnerModelInvokeUnavailableError)
    return new ModelCallError("runtime_unavailable", error.message, {
      cause: error,
    });
  if (error instanceof RangeError)
    return new ModelCallError("invalid_request", error.message, {
      cause: error,
    });
  return error;
}
