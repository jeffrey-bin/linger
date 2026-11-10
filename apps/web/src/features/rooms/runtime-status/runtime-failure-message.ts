import type { RuntimeExecutionFailure } from "./runtime-presentation-events";

const messages: Record<RuntimeExecutionFailure["code"], string> = {
  session_not_found:
    "Session history could not be restored. Check the local session and Local Computer compatibility before retrying.",
  protocol_incompatible:
    "This Runtime protocol is incompatible with Local Computer. Update Local Computer or use a verified Runtime version.",
  authentication_required:
    "Runtime authentication failed. Sign in again or check your API credentials.",
  network_error:
    "The Runtime could not connect to the model service. Check your connection and service address.",
  rate_limited:
    "The model service rate limit or quota was reached. Check your quota before retrying.",
  model_unavailable:
    "The model service does not offer the selected model to this Runtime's account. Choose another model for the Agent, or sign the Runtime in with an account that can use it.",
  model_not_offered:
    "The Agent's Computer does not offer its selected model, or the model does not support its reasoning effort. Open the Agent's settings and choose a model and reasoning effort that the Computer offers.",
  context_too_long:
    "The conversation no longer fits the model's context window. Start a new chat with the Agent, or choose a model with a larger context window.",
  model_service_error:
    "The model service reported an internal error. Try again in a moment; if it keeps failing, check the model provider's status.",
  timeout:
    "The Runtime ran past its time limit without finishing. Try again, or split the request into smaller steps.",
  execution_failed:
    "The Runtime exited with an error it did not classify. Check Local Computer diagnostics before retrying.",
  execution_outcome_unknown:
    "A command was dispatched, but its result could not be confirmed. It was not automatically replayed. Check its effects before retrying.",
  reply_undelivered:
    "The Agent finished, but its reply did not reach the Room because every TeamHub message it tried to send failed. Check the Agent's connection to TeamHub, then ask again.",
  interrupted:
    "The Run was interrupted before it finished, for example by a restart or by stopping the Agent on its Computer. Part of its work may have taken effect; check the result before asking again.",
  computer_unavailable:
    "The Agent's Computer could not run it. Make sure the Computer is online, the Agent is not stopped there, and its Runtime is enabled.",
  cleanup_unconfirmed:
    "The Runtime process could not be confirmed stopped. Check Local Computer before starting another Run.",
  response_too_large:
    "The Agent's reply was larger than a Room message can hold. Ask for a shorter answer, or for the result as a file.",
  unclassified:
    "The Run stopped because of an error the system could not identify. Try again; if it repeats, tell your administrator when it happened.",
};

export function runtimeFailureMessage(
  failure?: RuntimeExecutionFailure,
): string {
  if (!failure || !Object.hasOwn(messages, failure.code)) return "Run failed";
  // Failures the Agent Service or TeamHub observed name no Runtime.
  if (!failure.runtime_type) return messages[failure.code];
  const runtime = {
    codex: "Codex",
    claude: "Claude",
    pi: "Pi",
  }[failure.runtime_type];
  if (!runtime) return "Run failed";
  const version =
    failure.runtime_version &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      failure.runtime_version,
    )
      ? ` ${failure.runtime_version}`
      : "";
  return `${runtime}${version}: ${messages[failure.code]}`;
}
