import { displayText } from "./display-text.js";

type Json = Record<string, unknown>;
const singleLine = (value: unknown): string =>
  Array.from(displayText(value ?? "—"), (character) => {
    const code = character.codePointAt(0)!;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return code < 32 || code === 127
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
const rows = (items: Json[], columns: readonly [string, string][]): string =>
  [
    columns.map(([label]) => label).join("  "),
    ...items.map((item) =>
      columns.map(([, key]) => singleLine(item[key])).join("  "),
    ),
  ].join("\n");
const optionalLine = (label: string, value: unknown): string[] =>
  value === undefined
    ? []
    : [
        `${label}: ${typeof value === "object" ? JSON.stringify(value) : displayText(value)}`,
      ];
const list = (
  name: string,
  items: Json[],
  columns: readonly [string, string][],
  next: unknown,
): string =>
  [
    `${items.length} ${name}${items.length === 1 ? "" : "s"}`,
    "",
    ...(items.length ? [rows(items, columns)] : [`No ${name}s.`]),
    ...optionalLine("Next cursor", next),
  ].join("\n");
// An app listener Routine has no schedule; it fires on new events in the app.
function schedule(routine: Json): string {
  const listener = routine.listener as Json | undefined;
  if (listener) return `listens to ${String(listener.app)}`;
  const item = routine.schedule as Json;
  if (item.kind === "every_n_hours")
    return `every ${String(item.interval_hours)} hours`;
  if (item.kind === "once") return `once at ${String(item.run_at)}`;
  return `${String(item.kind)} ${Array.isArray(item.weekdays) ? `${item.weekdays.join(", ")} ` : ""}${String(item.time)} ${String(item.timezone)}`;
}
function knowledge(command: string, result: Json): string {
  const output: string[] = [];
  for (const [label, key] of [
    ["Status", "status"],
    ["Strategy", "strategy"],
    ["Evidence ID", "evidenceId"],
    ["Title", "title"],
    ["Collection", "collection"],
    ["Page", "pageKey"],
    ["Revision", "revision"],
    ["Complete", "complete"],
    ["Indexed at", "indexedAt"],
    ["Request ID", "requestId"],
  ])
    output.push(...optionalLine(label!, result[key!]));
  if (result.lineStart !== undefined)
    output.push(
      `Lines: ${displayText(result.lineStart)}–${String(result.lineEnd)}`,
    );
  if (result.headingPath !== undefined)
    output.push(`Headings: ${(result.headingPath as string[]).join(" > ")}`);
  if (result.source !== undefined)
    output.push(`Source: ${JSON.stringify(result.source)}`);
  if (result.directory !== undefined)
    output.push(
      "Directory:",
      rows(result.directory as Json[], [
        ["SECTION ID", "sectionId"],
        ["TITLE", "title"],
        ["LEVEL", "level"],
        ["PURPOSE", "purpose"],
      ]),
    );
  if (result.items !== undefined) {
    const items = result.items as Json[];
    output.push(`Chunks: ${items.length}`);
    for (const item of items) {
      output.push(
        "",
        `[${String(item.citeAs)}] ${singleLine(item.title)}`,
        `Evidence ID: ${String(item.evidenceId)}`,
      );
      for (const key of [
        "collection",
        "pageKey",
        "revision",
        "headingPath",
        "lineStart",
        "lineEnd",
        "score",
        "source",
        "representation",
        "facet",
        "timeHint",
        "metadata",
        "directory",
        "excerpt",
        "content",
      ])
        output.push(...optionalLine(key, item[key]));
    }
  }
  if (result.sections !== undefined)
    for (const item of result.sections as Json[]) {
      output.push(
        "",
        `Section ID: ${String(item.sectionId)}`,
        `Title: ${singleLine(item.title)}`,
        `Offset: ${String(item.offset)}`,
        `Truncated: ${String(item.truncated)}`,
        ...optionalLine("Next offset", item.nextOffset),
        "Content:",
        String(item.content),
      );
    }
  if (result.content !== undefined)
    output.push("", "Content:", displayText(result.content));
  if (result.facts !== undefined)
    output.push("", `Facts: ${JSON.stringify(result.facts, null, 2)}`);
  if (result.missingSections !== undefined)
    output.push(`Missing sections: ${JSON.stringify(result.missingSections)}`);
  if (result.gaps !== undefined)
    output.push(`Gaps: ${JSON.stringify(result.gaps, null, 2)}`);
  return output.join("\n");
}
function taskCheck(result: Json): string {
  if (result.tasks !== undefined)
    return list(
      "task",
      result.tasks as Json[],
      [
        ["ID", "task_id"],
        ["NAME", "name"],
        ["STATUS", "status"],
        ["REASON", "reason"],
        ["UPDATED", "updated_at"],
      ],
      undefined,
    );
  const task = result.task as Json;
  const approvals = task.pending_approvals as Json[];
  const activity = task.recent_activity as Json[];
  const report = task.last_report as Json | undefined;
  return [
    `Task: ${singleLine(task.name)} (${singleLine(task.task_id)})`,
    `Status: ${singleLine(task.status)}${task.reason === undefined ? "" : ` (${singleLine(task.reason)})`} since ${singleLine(task.status_since)}`,
    `Queued messages: ${String(task.queued_message_count)}`,
    ...(approvals.length
      ? [
          "Pending approvals:",
          ...approvals.map(
            (item) =>
              `  ${singleLine(item.kind)}: ${singleLine(item.title)}${item.expires_at === undefined ? "" : ` (expires ${singleLine(item.expires_at)})`}`,
          ),
        ]
      : []),
    ...(activity.length
      ? [
          "Recent activity:",
          ...activity.map(
            (item) =>
              `  ${singleLine(item.at)}  ${singleLine(item.kind)}  ${singleLine(item.summary)}`,
          ),
        ]
      : []),
    ...(report
      ? [`Last report (${singleLine(report.at)}):`, displayText(report.body)]
      : []),
  ].join("\n");
}
export function renderBusinessResult(command: string, result: Json): string {
  if (command === "room members")
    return [
      `Room: ${singleLine(result.room_id)}`,
      ...optionalLine("Inbox", result.inbox_id),
      `Membership revision: ${String(result.membership_revision)}`,
      list(
        "member",
        result.members as Json[],
        [
          ["ACTOR ID", "actor_id"],
          ["KIND", "kind"],
          ["NAME", "display_name"],
          ["AGENT TYPE", "agent_type"],
          ["DESCRIPTION", "description"],
        ],
        undefined,
      ),
    ].join("\n");
  if (command === "room invite")
    return result.added
      ? `Added Agent ${singleLine(result.actor_id)} to Room ${singleLine(result.room_id)}. Wake it with an Agent reference in that Room.`
      : `Agent ${singleLine(result.actor_id)} is already a member of Room ${singleLine(result.room_id)}.`;
  if (command === "room protocol")
    return [
      `Room: ${singleLine(result.room_id)}`,
      `Revision: ${String(result.revision)}`,
      `Updated at: ${String(result.updated_at)}`,
      "",
      String(result.raw_markdown),
    ].join("\n");
  if (command === "agent get")
    return [
      `Agent: ${singleLine(result.name)}`,
      `Actor ID: ${singleLine(result.actor_id)}`,
      `Description: ${singleLine(result.description || undefined)}`,
      "Prompt:",
      displayText(result.prompt),
    ].join("\n");
  if (command === "agent create" || command === "agent update") {
    if (result.status === "confirmation_pending")
      return [
        `Confirmation requested: the sponsor must approve this on the card in the chat (card ${singleLine(result.message_id)}).`,
        "TeamHub applies it after approval and sends you the result; a denial comes with its reason, and an unapproved card expires after 24 hours.",
        "Do not run this command again, and do not try another way to do the same thing; continue with other work.",
      ].join("\n");
    if (command === "agent update")
      return `Applied the change to Agent ${singleLine(result.actor_id)}.`;
    return result.room_id === undefined
      ? `Created Agent ${singleLine(result.actor_id)}.`
      : `Created Agent ${singleLine(result.actor_id)} in Room ${singleLine(result.room_id)}. Wake it with an Agent reference in that Room.`;
  }
  if (command === "agent list") {
    const items = result.agents as Json[];
    if (!items.length)
      return [
        "No available agents.",
        ...optionalLine("Next cursor", result.next_cursor),
      ].join("\n");
    return list(
      "agent",
      items,
      [
        ["ACTOR ID", "actor_id"],
        ["NAME", "name"],
        ["DESCRIPTION", "description"],
      ],
      result.next_cursor,
    );
  }
  if (command === "tracking-items list")
    return list(
      "tracking item",
      result.items as Json[],
      [
        ["ID", "id"],
        ["KIND", "kind"],
        ["DUE", "due_at"],
        ["CONTENT", "content"],
        ["SESSION", "session_path"],
      ],
      undefined,
    );
  if (
    command === "tracking-items add" ||
    command === "tracking-items update" ||
    command === "tracking-items done"
  )
    return [
      `Tracking Item ${singleLine(result.id)} (${singleLine(result.status)}, revision ${String(result.revision)})`,
      `Kind: ${singleLine(result.kind)}`,
      `Content: ${singleLine(result.content)}`,
      ...optionalLine("Due", result.due_at ?? result.due_text ?? undefined),
    ].join("\n");
  if (command === "apps list")
    return list(
      "connection",
      result.connections as Json[],
      [
        ["CONNECTION ID", "connectionId"],
        ["NAME", "name"],
        ["DISPLAY NAME", "displayName"],
        ["IDENTITY", "identityLabel"],
      ],
      undefined,
    );
  if (command === "apps search") {
    const tools = result.tools as Json[];
    return [
      `${tools.length} tool${tools.length === 1 ? "" : "s"}`,
      ...tools.flatMap((item) => [
        "",
        `Tool: ${singleLine(item.toolSlug)}`,
        `Version: ${singleLine(item.toolVersion)}`,
        `Name: ${singleLine(item.name)}`,
        `Description: ${String(item.description)}`,
        `Connections: ${JSON.stringify(item.availableConnections, null, 2)}`,
        `Input schema: ${JSON.stringify(item.inputSchema, null, 2)}`,
        `Output schema: ${JSON.stringify(item.outputSchema, null, 2)}`,
      ]),
    ].join("\n");
  }
  if (command === "apps execute") {
    const confirmation = result.confirmation as
      | Record<string, unknown>
      | undefined;
    if (confirmation)
      return [
        `Confirmation requested: the sponsor must approve this on the card in the chat (card ${singleLine(confirmation.messageId)}).`,
        "TeamHub runs it after approval and sends you the result; a denial comes with its reason, and an unapproved card expires after 24 hours.",
        "Do not run this command again, and do not try another way to do the same thing; continue with other work.",
      ].join("\n");
    return `App tool result:\n${JSON.stringify(result.data, null, 2)}`;
  }
  if (command.startsWith("knowledge ")) return knowledge(command, result);
  if (command === "task check") return taskCheck(result);
  if (command === "task create")
    return [
      result.duplicate_request
        ? "Task already created"
        : "Task created and running",
      `Task ID: ${String(result.task_id)}`,
    ].join("\n");
  if (command === "task send")
    return [
      result.duplicate_request
        ? "Message already sent"
        : result.delivery === "started"
          ? "Message sent; the Task is running again"
          : result.delivery === "steered"
            ? "Message steered into the running turn; it runs next if the turn can't take it"
            : "Message queued behind the running turn",
      `Task ID: ${String(result.task_id)}`,
    ].join("\n");
  if (command === "task stop")
    return [
      result.duplicate_request ? "Task already stopped" : "Task stopped",
      `Task ID: ${String(result.task_id)}`,
    ].join("\n");
  if (command === "room create")
    return [
      "Room creation approval requested",
      `Status: ${String(result.status)}`,
      `Approval request: ${String(result.creation_approval_request_id)}`,
      `Message ID: ${String(result.message_id)}`,
    ].join("\n");
  if (command === "room collaborate")
    return [
      `Published Room collaboration protocol`,
      `Room: ${String(result.room_id)}`,
      `Revision: ${String(result.revision)}`,
      `Notified actors: ${JSON.stringify(result.notified_actor_ids)}`,
    ].join("\n");
  if (command === "routine list")
    return list(
      "routine",
      (result.routines as Json[]).map((item) => ({
        ...item,
        schedule: schedule(item),
      })),
      [
        ["ID", "id"],
        ["NAME", "name"],
        ["ENABLED", "enabled"],
        ["SCHEDULE", "schedule"],
        ["NEXT RUN", "next_run_at"],
      ],
      undefined,
    );
  if (command === "routine delete")
    return `Deleted routine ${String(result.routine_id)}`;
  if (command.startsWith("routine ")) {
    const routine = result.routine as Json;
    const action = command.slice("routine ".length);
    return [
      `${action === "run" ? "Posted routine instruction" : action === "create" ? "Created routine" : action === "pause" ? "Paused routine" : "Enabled routine"} ${String(routine.id)}`,
      `Name: ${String(routine.name)}`,
      `Enabled: ${String(routine.enabled)}`,
      `Schedule: ${schedule(routine)}`,
      ...optionalLine("Next run", routine.next_run_at),
      ...optionalLine("Mention Actor ID", routine.mention_actor_id),
      `Instruction: ${String(routine.instruction)}`,
    ].join("\n");
  }
  if (command === "profile skill publish")
    return `Published Skill\n${Object.entries(result)
      .map(
        ([key, value]) =>
          `${key}: ${typeof value === "object" ? JSON.stringify(value) : displayText(value)}`,
      )
      .join("\n")}`;
  if (command === "personal-profile show") {
    const current = result.current as Json | null;
    if (current === null)
      return "No Personal Profile yet. Write one with teamhub personal-profile write (omit --base-revision).";
    return [
      `Revision: ${singleLine(current.revision_id)}`,
      `Created at: ${singleLine(current.created_at)}`,
      `Source apps: ${Array.isArray(current.source_apps) ? current.source_apps.join(", ") || "none" : "unknown"}`,
      "Profile (edit this JSON and write the complete document back):",
      JSON.stringify(current.profile, null, 2),
    ].join("\n");
  }
  if (command === "personal-profile start")
    return `The Profile page shows the Personal Profile as being written since ${singleLine(result.building_since)}.`;
  if (command === "personal-profile write")
    return `Published Personal Profile revision ${singleLine(result.revision_id)} at ${singleLine(result.created_at)}.`;
  if (
    command === "account-profile show" ||
    command === "account-profile update"
  )
    return [
      `Name: ${singleLine(result.name)}`,
      `Bio: ${singleLine(result.bio)}`,
      `Organization: ${singleLine(result.organization)}`,
    ].join("\n");
  throw new TypeError(`No business renderer for ${command}`);
}
