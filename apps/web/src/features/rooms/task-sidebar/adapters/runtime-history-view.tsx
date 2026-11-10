import { ChevronRight, Sparkles } from "lucide-react";
import { useMemo } from "react";

import {
  toolGroupPresentation,
  toolPresentation,
} from "@/features/rooms/runtime-status/runtime-tool-presentation";

import { MessageMarkdown } from "@/features/rooms/chat/message-markdown";
import type { TeamHubMessageActivityRecord } from "@/features/teamhub/teamhub-types";

type HistoryCategory = TeamHubMessageActivityRecord["category"];

export function RuntimeHistoryView({
  records,
}: {
  records: TeamHubMessageActivityRecord[];
}) {
  const orderedRecords = useMemo(
    () => [...records].sort((left, right) => left.ordinal - right.ordinal),
    [records],
  );
  const callPairs = useMemo(
    () => indexToolCalls(orderedRecords),
    [orderedRecords],
  );
  const items = useMemo(
    () => activityTimelineItems(orderedRecords, callPairs),
    [callPairs, orderedRecords],
  );
  return (
    <ol
      aria-label="Activity log"
      className="space-y-1 bg-white px-4 py-3 text-xs font-normal leading-5 text-app-body"
    >
      {items.map((item) =>
        item.kind === "tool_calls" ? (
          <RuntimeToolCallsActivity calls={item.calls} key={item.key} />
        ) : (
          <RuntimeActivityRecord key={item.key} record={item.record} />
        ),
      )}
    </ol>
  );
}

interface ActivityToolCall {
  pair?: ToolCallPair;
  record: TeamHubMessageActivityRecord;
}

type ActivityTimelineItem =
  | { calls: ActivityToolCall[]; key: string; kind: "tool_calls" }
  | {
      kind: "record";
      key: string;
      record: TeamHubMessageActivityRecord;
    };

function activityTimelineItems(
  records: TeamHubMessageActivityRecord[],
  callPairs: ReadonlyMap<string, ToolCallPair>,
): ActivityTimelineItem[] {
  const items: ActivityTimelineItem[] = [];
  const thinkingTitles = new Set<string>();
  for (const source of records.flatMap(claudeActivityRecords)) {
    let record = source;
    if (record.native_type === "event_msg.mcp_tool_call_end") {
      const invocation = asObject(nativePayload(record)?.invocation);
      record = {
        ...record,
        category: "tool_call",
        tool_name:
          stringValue(invocation?.tool)
            ?.replaceAll("_", " ")
            .replace(/^./, (letter) => letter.toUpperCase()) ?? "Tool call",
      };
    } else if (record.category === "tool_call") {
      if (record.tool_name === "exec") continue;
    } else if (record.category === "reasoning") {
      const summary = reasoningText(record);
      if (!summary?.trim()) continue;
      if (thinkingTitles.has(summary)) continue;
      thinkingTitles.add(summary);
    } else if (record.category === "message") {
      if (
        isEventRecord(record) ||
        (!isAssistantMessage(record) && !isUserMessage(record)) ||
        (isUserMessage(record) && activityMessageText(record).length > 240)
      )
        continue;
    } else {
      continue;
    }
    const pair = record.tool_call_id
      ? callPairs.get(record.tool_call_id)
      : undefined;
    if (record.category !== "tool_call") {
      items.push({
        kind: "record",
        key: `record-${record.ordinal}-${items.length}`,
        record,
      });
      continue;
    }
    const previous = items.at(-1);
    if (previous?.kind === "tool_calls") {
      previous.calls.push({ pair, record });
      continue;
    }
    items.push({
      calls: [{ pair, record }],
      key: `tool-calls-${record.ordinal}`,
      kind: "tool_calls",
    });
  }
  return items;
}

function RuntimeToolCallsActivity({ calls }: { calls: ActivityToolCall[] }) {
  const presentedCalls = calls.map(({ pair, record }) => {
    const name = record.tool_name ?? pair?.call?.tool_name ?? "Tool call";
    const invocation = asObject(nativePayload(record)?.invocation);
    // Native history carries tool names, not activity kinds: show the name.
    return {
      record,
      name: stringValue(invocation?.tool) ?? name,
      ...toolPresentation("tool"),
    };
  });
  const { icon: GroupIcon, label: groupLabel } =
    toolGroupPresentation(presentedCalls);
  return (
    <li>
      <details className="group">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 py-1.5 text-app-muted hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
          <span className="relative inline-flex size-[15px] shrink-0 items-center justify-center">
            <GroupIcon
              aria-hidden="true"
              className="absolute inset-0 m-auto group-hover:hidden group-focus-within:hidden group-open:hidden"
              size={15}
            />
            <ChevronRight
              aria-hidden="true"
              className="absolute inset-0 m-auto hidden group-hover:block group-focus-within:block group-open:block group-open:rotate-90 motion-reduce:transition-none"
              size={15}
            />
          </span>
          <span className="min-w-0 flex-1 truncate" title={groupLabel}>
            {groupLabel}
          </span>
        </summary>
        <ul className="space-y-1 pb-3 pl-[1.45rem]">
          {presentedCalls.map(({ record, name, icon: Icon, label }) => {
            return (
              <li
                className="flex min-h-7 items-center gap-2"
                key={`${record.ordinal}:${record.tool_call_id}`}
              >
                <Icon aria-label={label} className="shrink-0" size={13} />
                <span className="truncate" title={name}>
                  {name}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
}

function RuntimeActivityRecord({
  record,
}: {
  record: TeamHubMessageActivityRecord;
}) {
  if (record.category === "reasoning") {
    const title = reasoningText(record)?.replace(/^\*\*([\s\S]+)\*\*$/, "$1");
    return (
      <li className="flex min-h-8 items-start gap-2 py-1.5 text-app-muted">
        <Sparkles aria-hidden="true" className="mt-0.5 shrink-0" size={15} />
        <p className="min-w-0 flex-1 line-clamp-2" title={title}>
          {title}
        </p>
      </li>
    );
  }
  return (
    <li className="py-2">
      <MessageMarkdown
        authorKind={isAssistantMessage(record) ? "agent" : "human"}
        body={activityMessageText(record)}
      />
    </li>
  );
}

function activityMessageText(record: TeamHubMessageActivityRecord) {
  const payload = nativePayload(record);
  return (
    stringValue(payload?.message) ??
    stringValue(payload?.text) ??
    textContent(payload?.content) ??
    "No message text recorded"
  );
}

function nativePayload(record: TeamHubMessageActivityRecord) {
  const nativeRecord = asObject(record.native_record);
  return (
    asObject(nativeRecord?.payload) ??
    asObject(nativeRecord?.message) ??
    nativeRecord
  );
}

function claudeBlockCategory(type: unknown): HistoryCategory | undefined {
  switch (type) {
    case "text":
      return "message";
    case "thinking":
    case "redacted_thinking":
      return "reasoning";
    case "tool_use":
    case "server_tool_use":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    default:
      return undefined;
  }
}

function claudeActivityRecords(
  record: TeamHubMessageActivityRecord,
): TeamHubMessageActivityRecord[] {
  const blocks = claudeMessageBlocks(record);
  if (!blocks) return [record];
  const native = asObject(record.native_record)!;
  const message = asObject(native.message)!;
  return blocks.flatMap((block) => {
    const category = claudeBlockCategory(block.type);
    if (!category) return [];
    return [
      {
        ...record,
        category,
        tool_call_id: stringValue(block.id ?? block.tool_use_id),
        tool_name: stringValue(block.name),
        native_record: { ...native, message: { ...message, content: [block] } },
      },
    ];
  });
}

function reasoningText(
  record: TeamHubMessageActivityRecord,
): string | undefined {
  const payload = nativePayload(record);
  const block = nativeContentBlock(record, payload);
  if (block?.type === "thinking" || block?.type === "redacted_thinking") {
    return (
      claudeThinkingSummary(block) ??
      "Thinking recorded · private content hidden"
    );
  }
  return stringValue(payload?.text) ?? textContent(payload?.summary);
}

function nativeContentBlock(
  record: TeamHubMessageActivityRecord,
  payload: JsonObject | undefined,
) {
  if (!Array.isArray(payload?.content)) return undefined;
  const blocks = payload.content.flatMap((value) => {
    const block = asObject(value);
    return block ? [block] : [];
  });
  switch (record.category) {
    case "tool_call":
      return blocks.find(
        (block) =>
          (block.type === "tool_use" || block.type === "server_tool_use") &&
          (!record.tool_call_id || block.id === record.tool_call_id),
      );
    case "tool_result":
      return blocks.find(
        (block) =>
          block.type === "tool_result" &&
          (!record.tool_call_id || block.tool_use_id === record.tool_call_id),
      );
    case "reasoning":
      return blocks.find(
        (block) =>
          block.type === "thinking" || block.type === "redacted_thinking",
      );
    default:
      return undefined;
  }
}

function isUserMessage(record: TeamHubMessageActivityRecord) {
  return record.role === "user" || record.native_type.endsWith(".user_message");
}

function isAssistantMessage(record: TeamHubMessageActivityRecord) {
  return (
    record.role === "assistant" || record.native_type.endsWith(".agent_message")
  );
}

function isEventRecord(record: TeamHubMessageActivityRecord) {
  return record.native_type.startsWith("event_msg.");
}

function textContent(value: unknown): string | undefined {
  const parts = collectText(value).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  const object = asObject(value);
  if (!object) return [];
  if (typeof object.text === "string") return [object.text];
  return object.content === undefined ? [] : collectText(object.content);
}

function indexToolCalls(records: TeamHubMessageActivityRecord[]) {
  const candidates = new Map<
    string,
    {
      calls: TeamHubMessageActivityRecord[];
      results: TeamHubMessageActivityRecord[];
    }
  >();
  for (const record of records) {
    const blocks = claudeMessageBlocks(record);
    if (blocks) {
      for (const block of blocks) {
        const category = claudeBlockCategory(block.type);
        const id = stringValue(
          category === "tool_result" ? block.tool_use_id : block.id,
        );
        if (!id || (category !== "tool_call" && category !== "tool_result"))
          continue;
        const candidate = candidates.get(id) ?? { calls: [], results: [] };
        candidate[category === "tool_call" ? "calls" : "results"].push(record);
        candidates.set(id, candidate);
      }
      continue;
    }
    if (
      !record.tool_call_id ||
      (record.category !== "tool_call" && record.category !== "tool_result")
    ) {
      continue;
    }
    const current = candidates.get(record.tool_call_id) ?? {
      calls: [],
      results: [],
    };
    current[record.category === "tool_call" ? "calls" : "results"].push(record);
    candidates.set(record.tool_call_id, current);
  }
  const pairs = new Map<string, ToolCallPair>();
  for (const [callId, candidate] of candidates) {
    if (candidate.calls.length > 1 || candidate.results.length > 1) continue;
    pairs.set(callId, {
      ...(candidate.calls[0] ? { call: candidate.calls[0] } : {}),
      ...(candidate.results[0] ? { result: candidate.results[0] } : {}),
    });
  }
  return pairs;
}

type JsonObject = Record<string, unknown>;

interface ToolCallPair {
  readonly call?: TeamHubMessageActivityRecord;
  readonly result?: TeamHubMessageActivityRecord;
}

function claudeMessageBlocks(
  record: TeamHubMessageActivityRecord,
): JsonObject[] | undefined {
  const native = asObject(record.native_record);
  if (native?.type !== "user" && native?.type !== "assistant") return undefined;
  const message = asObject(native.message);
  if (typeof message?.content === "string")
    return [{ type: "text", text: message.content }];
  return Array.isArray(message?.content)
    ? message.content.flatMap((value) => {
        const block = asObject(value);
        return block ? [block] : [];
      })
    : undefined;
}

function claudeThinkingSummary(block: JsonObject): string | undefined {
  if (typeof block.summary === "string") return block.summary;
  if (!Array.isArray(block.summary)) return undefined;
  return (
    block.summary
      .flatMap((part) => {
        const text = asObject(part)?.text;
        return typeof text === "string" ? [text] : [];
      })
      .join("\n\n") || undefined
  );
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
