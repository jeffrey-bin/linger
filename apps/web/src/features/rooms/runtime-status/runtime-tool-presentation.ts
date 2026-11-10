import {
  BookOpen01Icon,
  BubbleChatIcon,
  CheckListIcon,
  CommandLineIcon,
  FileEditIcon,
  Globe02Icon,
  Image01Icon,
  RefreshIcon,
  Search01Icon,
  SearchVisualIcon,
  UserGroupIcon,
  UserIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import {
  FilePenLine,
  BookOpen,
  Globe,
  Image,
  ListChecks,
  MessageCircle,
  RefreshCw,
  ScanSearch,
  Search,
  SquareTerminal,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";

import type { RuntimeActivityEntry } from "./runtime-presentation-events";

// `icon` stays Lucide for the Runtime history view; other surfaces render `glyph`.
const presentations = {
  command: { icon: SquareTerminal, glyph: CommandLineIcon, label: "Command" },
  read: { icon: BookOpen, glyph: BookOpen01Icon, label: "Read file" },
  edit: { icon: FilePenLine, glyph: FileEditIcon, label: "Edit files" },
  search: { icon: Search, glyph: Search01Icon, label: "Search" },
  browser: { icon: Globe, glyph: Globe02Icon, label: "Web browsing" },
  message: { icon: MessageCircle, glyph: BubbleChatIcon, label: "Message" },
  message_read: {
    icon: MessageCircle,
    glyph: BubbleChatIcon,
    label: "Read messages",
  },
  delegation: {
    icon: Users,
    glyph: UserGroupIcon,
    label: "Agent collaboration",
  },
  image: { icon: Image, glyph: Image01Icon, label: "Image" },
  interaction: { icon: UserRound, glyph: UserIcon, label: "User input" },
  recovery: { icon: RefreshCw, glyph: RefreshIcon, label: "Recovery" },
  review: { icon: ScanSearch, glyph: SearchVisualIcon, label: "Review" },
  tool: { icon: Wrench, glyph: Wrench01Icon, label: "Tool" },
};
type ToolCategory = keyof typeof presentations;

// The Computer classifies each Runtime's tools into these runtime-neutral kinds.
const kinds: Record<string, ToolCategory> = {
  command: "command",
  read: "read",
  file_change: "edit",
  search: "search",
  browse: "browser",
  message: "message",
  message_read: "message_read",
  image: "image",
  delegation: "delegation",
  response: "message",
  interaction: "interaction",
  recovery: "recovery",
  review: "review",
  tool: "tool",
};

export function toolPresentation(kind: string) {
  const category = kinds[kind] ?? "tool";
  return { category, ...presentations[category], summary: summaries[category] };
}

const summaries: Record<ToolCategory, string> = {
  command: "Running a command",
  read: "Reviewing files",
  edit: "Updating files",
  search: "Searching for information",
  browser: "Reviewing online information",
  message: "Sending an update",
  message_read: "Reading messages",
  delegation: "Coordinating with another agent",
  image: "Working with images",
  interaction: "Waiting for your input",
  recovery: "Recovering the task",
  review: "Reviewing the results",
  tool: "Working on the task",
};

export function toolGroupPresentation(
  calls: readonly ReturnType<typeof toolPresentation>[],
) {
  const single = calls.length === 1 ? calls[0] : undefined;
  if (single) {
    return { icon: single.icon, glyph: single.glyph, label: single.summary };
  }
  const categories = [...new Set(calls.map((call) => call.category))];
  const category = categories.length === 1 ? categories[0] : undefined;
  return {
    icon: calls[0]?.icon ?? ListChecks,
    glyph: calls[0]?.glyph ?? CheckListIcon,
    label:
      calls.length > 1 && (!category || category === "tool")
        ? `Working through ${calls.length} steps`
        : category
          ? summaries[category]
          : "Working through the task",
  };
}

export function toolInputFromEntries(
  entries: readonly RuntimeActivityEntry[] = [],
) {
  const entry = entries.find(
    (entry) =>
      entry.type === "content" &&
      entry.block.label?.toLowerCase() === "input" &&
      entry.block.format === "json",
  );
  if (entry?.type === "content") return entry.block.content;
  const fields: Record<string, string> = {};
  const keys: Record<string, string> = {
    command: "command",
    path: "path",
    file: "file_path",
    query: "query",
    url: "url",
  };
  for (const entry of entries) {
    if (entry.type !== "content") continue;
    const key = keys[entry.block.label?.toLowerCase() ?? ""];
    if (key) fields[key] = entry.block.content;
  }
  return fields;
}

// Phrases for Activities the Computer does not name itself, such as an MCP
// tool. An unnamed command has none: the status line keeps its last text.
const statusPhrases: Record<Exclude<ToolCategory, "command">, string> = {
  read: "Reading files",
  edit: "Editing files",
  search: "Searching",
  browser: "Browsing the web",
  message: "Sending a message",
  message_read: "Reading messages",
  delegation: "Working with another agent",
  image: "Working with images",
  interaction: "Waiting for your input",
  recovery: "Recovering the task",
  review: "Reviewing the results",
  tool: "Using tools",
};

/** How the Room status line names an Activity. */
export interface ActivityStatusLine {
  /** The Runtime's own description, which starts a new group of the line. */
  title?: string;
  /** The steps the Activity takes, in order. */
  steps: readonly string[];
}

/**
 * The Room status line's words for an Activity: the Runtime's description or
 * the steps the Computer read from it, else its kind's phrase.
 */
export function activityStatusLine(
  kind: string,
  input?: unknown,
): ActivityStatusLine {
  const fields = inputFields(input);
  const title =
    typeof fields.status_title === "string" ? fields.status_title.trim() : "";
  if (title) return { steps: [], title };
  const steps = Array.isArray(fields.status_steps)
    ? fields.status_steps.filter(
        (step): step is string =>
          typeof step === "string" && step.trim() !== "",
      )
    : [];
  if (steps.length > 0) return { steps };
  const category = toolPresentation(kind).category;
  return { steps: category === "command" ? [] : [statusPhrases[category]] };
}

function inputFields(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}
