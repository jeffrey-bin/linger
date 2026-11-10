import type { CommandTarget } from "./command-definition.js";
import { CliError } from "./errors.js";
import { displayText } from "./display-text.js";

export interface CommandError {
  code: string;
  message: string;
  command?: string;
  target?: CommandTarget;
  details?: Record<string, unknown>;
}
const singleLine = (value: string) => value.replace(/\p{Cc}/gu, " ");
const templates: Record<string, string> = {
  authorization_required:
    "Complete the account authorization card in the chat, then run this command again.",
  provider_key_required:
    "The user has not set up Composio, which every connected app needs. A card asking them to add a Composio API key was posted in this chat; run this command again after they add it.",
  account_ambiguous:
    "Multiple accounts match. Select a connection ID with --account.",
  capability_unavailable:
    "This command's exact application capability is unavailable.",
  cursor_mismatch: "Use the returned cursor with the same account and filters.",
  incomplete_response:
    "The connected application returned incomplete data; no complete result is available.",
  unsupported_combination:
    "The selected application tool version cannot represent these parameters.",
  forbidden: "The current Agent is not permitted to perform this operation.",
  permission_denied:
    "The current Agent is not permitted to perform this operation.",
  unauthorized: "The Agent identity is not authorized.",
  unauthenticated: "The Agent identity credential is invalid or expired.",
  not_found: "The requested resource is unavailable.",
  ambiguous_name:
    "Multiple readable Documents match that name. Retry with a Document ID.",
  conflict: "The operation conflicts with the current resource state.",
  version_conflict:
    "The Document changed. Preserve local changes, download a fresh copy to a different path, and merge before retrying.",
  idempotency_conflict: "This operation ID already belongs to different input.",
  profile_revision_conflict:
    "The Personal Profile changed since it was read. Run teamhub personal-profile show, merge into its current profile, and write again with its revision_id.",
  profile_document_invalid:
    "The Personal Profile document has an invalid field; see issues for its path. Text is plain: no heading lines, images or scripts.",
  profile_module_empty:
    "A Personal Profile module is empty; see issues for its path. Give it an overview or at least one point.",
  agent_limit_reached:
    "The sponsor already has 50 Agents; the sponsor must delete one before another can be created.",
  task_limit_reached:
    "This Agent already has 10 running Tasks. Check them with teamhub task check, send to an idle one, or stop one before creating another.",
  invalid_input:
    "The operation input is invalid. Check this command's help and schema.",
  outcome_unknown:
    "The operation outcome is unknown. Run the same command again with --operation-id set to this Operation ID: TeamHub returns the original result instead of submitting it twice.",
};
export function formatCommandError(
  error: CliError,
  context: { command?: string; target?: CommandTarget; remote?: boolean },
): CommandError {
  const key = error.code.toLowerCase();
  // Never infer authority or existence from backend prose. Raw routing addresses,
  // provider messages and credentials are not part of the public error contract.
  const safeLocal =
    !context.remote &&
    !/\p{Script=Han}|(?:room|thread|task|taskmeta|meta):/u.test(error.message);
  const message =
    safeLocal || error.trustedMessage
      ? singleLine(error.message)
      : key === "version_conflict" && !context.command?.startsWith("docs ")
        ? templates.conflict!
        : (templates[key] ?? "The TeamHub operation could not be completed.");
  const details = Object.fromEntries(
    [
      "http_status",
      "request_id",
      "operation_id",
      "retryable",
      "parameter",
      "index",
      "base_version_id",
      "current_version_id",
      "document_id",
      "thread_id",
      "task_id",
      "issues",
      "room_id",
      "message_id",
      "interaction_id",
      "candidates",
      "draft_id",
      "partial_receipts",
    ]
      .filter((name) => Object.hasOwn(error.details, name))
      .map((name) => [name, error.details[name]]),
  );
  if (key === "ambiguous_name" && Array.isArray(error.details.candidates)) {
    const candidates = error.details.candidates.filter(
      (id): id is string =>
        typeof id === "string" && /^document_[A-Za-z0-9_-]+$/u.test(id),
    );
    if (candidates.length) details.candidates = candidates;
    else delete details.candidates;
  }
  return {
    code: error.code,
    message,
    ...(context.command ? { command: context.command } : {}),
    ...(context.target ? { target: context.target } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
}
export function renderCommandError(error: CommandError): string {
  return [
    `teamhub: ${singleLine(error.code)}: ${error.message}`,
    error.command ? `Command: teamhub ${error.command}` : "",
    error.target
      ? ["thread", "inbox"].includes(error.target.type)
        ? `Target: --${error.target.type} ${singleLine(error.target.id)}`
        : `Context: ${error.target.type}:${singleLine(error.target.id)}`
      : "",
    typeof error.details?.base_version_id === "string"
      ? `Base version: ${singleLine(error.details.base_version_id)}`
      : "",
    typeof error.details?.current_version_id === "string"
      ? `Current version: ${singleLine(error.details.current_version_id)}`
      : "",
    typeof error.details?.operation_id === "string"
      ? `Operation ID: ${singleLine(error.details.operation_id)}`
      : "",
    typeof error.details?.message_id === "string"
      ? `Authorization card: ${singleLine(error.details.message_id)}`
      : "",
    typeof error.details?.draft_id === "string"
      ? `Draft: ${singleLine(error.details.draft_id)}`
      : undefined,
    ...(Array.isArray(error.details?.partial_receipts)
      ? error.details.partial_receipts
      : []
    ).map(
      (item: Record<string, unknown>) =>
        `Completed step: ${singleLine(JSON.stringify(item))}`,
    ),
    Array.isArray(error.details?.candidates) &&
    error.details.candidates.some((item) => typeof item === "string")
      ? `Candidates: ${error.details.candidates
          .filter((item) => typeof item === "string")
          .map(singleLine)
          .join(", ")}`
      : "",
    ...(Array.isArray(error.details?.candidates)
      ? error.details.candidates.filter((item) => typeof item === "object")
      : []
    ).map(
      (item: Record<string, unknown>) =>
        `Account: ${singleLine(displayText(item.connection_id ?? ""))}  ${singleLine(displayText(item.identity_label ?? ""))}`,
    ),
    ...(Array.isArray(error.details?.issues) ? error.details.issues : []).map(
      (issue: Record<string, unknown>) =>
        `Issue: ${["path", "code", "message"]
          .map((name) => singleLine(displayText(issue?.[name] ?? "")))
          .filter(Boolean)
          .join(": ")}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
export function errorExitCode(failure: CliError): number {
  return (
    (
      {
        usage: 2,
        usage_error: 2,
        invalid_path: 2,
        invalid_input: 2,
        too_large: 2,
        account_ambiguous: 2,
        cursor_mismatch: 2,
        unsupported_combination: 2,
        authorization_required: 4,
        provider_key_required: 4,
        unauthenticated: 4,
        conflict: 3,
        ambiguous_name: 2,
        version_conflict: 3,
        forbidden: 4,
        permission_denied: 4,
        unauthorized: 4,
        configuration_error: 2,
        not_found: 5,
      } as Record<string, number>
    )[failure.code.toLowerCase()] ??
    (failure.details.http_status === 409
      ? 3
      : failure.details.http_status === 401 ||
          failure.details.http_status === 403
        ? 4
        : failure.details.http_status === 400 ||
            failure.details.http_status === 413
          ? 2
          : 1)
  );
}
