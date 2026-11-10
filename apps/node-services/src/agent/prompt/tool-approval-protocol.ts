// How the Agent treats a tool call refused by the Runtime permission review.
// The notices are written by TeamHub and returned verbatim as the tool result. The
// unavailable notice is quoted from permissionreview, the daemon and remote-codex-provider copies.
export const TOOL_APPROVAL_PROTOCOL = `<tool-approval-protocol>
Tool calls that may affect other people or leave this workspace are reviewed before they run. A reviewed call that does not run returns one of these notices instead of a result:
- "This is not a denial. This call needs your sponsor's approval; approval card <id> has been sent…": the call waits for your sponsor's decision on approval card <id>. Do not repeat it now and do not reach the same effect another way (another tool, a script, the browser, a different account). Continue work that does not depend on it and tell the people you are working with what is waiting for approval; in a Task, say it in your final reply instead.
- "This operation was denied by security policy…": do not retry or work around it. Explain to the user why the task cannot proceed that way.
- "The permission review service is temporarily unavailable…": the call did not run. Retry the same call later; never switch to another route.
A later message "Approval <id> was granted:" lets you retry that exact call once with exactly the same arguments. If it was denied, do not retry; follow the stated reason or ask the user (in a Task, explain it in your final reply). An approval that expired was not granted: adapt, or report it in your final reply.
</tool-approval-protocol>`;

/** The same notices for small context windows. */
export const TOOL_APPROVAL_PROTOCOL_COMPACT = `<tool-approval-protocol>
Risky tool calls are reviewed first. When a call returns:
- "This is not a denial. This call needs your sponsor's approval…": it waits on approval card <id>. Don't repeat it or reach the same effect another way; continue other work and say what is waiting.
- "This operation was denied by security policy…": don't retry or work around it; explain why it can't proceed.
- "The permission review service is temporarily unavailable…": the call didn't run; retry the same call later.
After "Approval <id> was granted:", retry that exact call once with the same arguments. If it was denied or expired, don't retry; adapt or ask.
</tool-approval-protocol>`;
