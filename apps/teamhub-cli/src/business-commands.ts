import { teamHubData } from "./http-client.js";
import { loadAgentCommandSchema } from "./command-schema-loader.js";
import type {
  CommandArguments,
  CommandDefinition,
  CommandInputReader,
  CommandOption,
} from "./command-definition.js";
import { reportInFinalReply } from "./command-definition.js";
import {
  assertPositionals,
  jsonSource,
  markdownBodySource,
  option,
  parseJsonValue,
  requiredOption,
  targetFromFlags,
  values,
} from "./command-input.js";
import { parseActorReferences } from "./command-mentions.js";
import { CliError } from "./errors.js";
import {
  resolveConnectorAccount,
  validateAccountSelector,
} from "./connector-runtime.js";
import { renderBusinessResult } from "./business-render.js";
import { displayText } from "./display-text.js";
import { computerPermissionCommandDefinitions } from "./computer-permission-commands.js";

type Json = Record<string, unknown>;
const singleLineText = (value: unknown): string =>
  displayText(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
function invalid(message: string): never {
  throw new CliError("usage", message);
}
const flag = (description: string, repeatable = false): CommandOption => ({
  description,
  ...(repeatable ? { repeatable: true } : {}),
});
const bodyOptions = {
  "--content": flag(
    "Inline Markdown body; outside code, \\n, \\t and \\\\ are decoded.",
  ),
  "--file": flag("Read UTF-8 body from a file or - for stdin."),
};
const listOptions = {
  "--limit": flag("Maximum items in this page; 1-100."),
  "--cursor": flag("Exact next_cursor returned by the previous page."),
};
const jsonOptions = (name: string, description: string) => ({
  [`--${name}`]: flag(description),
  [`--${name}-file`]: flag(`Read ${name} JSON from a file or - for stdin.`),
});
const optional = (field: string, value: unknown): Json =>
  value === undefined ? {} : { [field]: value };
const object = (value: unknown, label: string): Json => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must contain one JSON object.`);
  return value as Json;
};
const integer = (
  value: string | undefined,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  if (value === undefined) return undefined;
  if (
    !/^(?:0|[1-9]\d*)$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    invalid(`${label} must be an integer from ${min} to ${max}.`);
  return Number(value);
};
async function validate(
  tool: string,
  input: Json,
  wire: Json = input,
): Promise<Json> {
  const schema = await loadAgentCommandSchema(tool);
  if (schema && !schema.input.safeParse(wire).success)
    invalid(
      "Command input does not match its business schema. Run this command with --schema.",
    );
  return input;
}
function definition(
  command: string[],
  toolName: string,
  description: string,
  options: Readonly<Record<string, CommandOption>>,
  normalize: CommandDefinition["normalize"],
  extras: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    command,
    toolName,
    description,
    options,
    normalize,
    readOnly: false,
    schema: true,
    operationId: extras.readOnly !== true,
    usage: [`teamhub ${command.join(" ")} [flags]`],
    render: (result) => renderBusinessResult(command.join(" "), result),
    ...extras,
  };
}
function uniqueList(
  args: CommandArguments,
  repeated: string,
  structured: string,
  required: boolean,
): unknown {
  const list = values(args, repeated);
  const json = option(args, structured);
  if (list.length && json !== undefined)
    invalid(`Choose ${repeated} or ${structured}.`);
  if (json !== undefined) return parseJsonValue(json);
  if (!list.length && required)
    invalid(`Provide ${repeated} at least once or ${structured}.`);
  if (new Set(list).size !== list.length)
    invalid(`${repeated} values must be unique.`);
  return list.length ? [...list] : undefined;
}
async function initialMessage(
  args: CommandArguments,
  reader: CommandInputReader,
): Promise<unknown> {
  const ordinary = ["--content", "--file"].some(
    (name) => option(args, name) !== undefined,
  );
  const structured = [
    "--initial-message-segments",
    "--initial-message-segments-file",
  ].some((name) => option(args, name) !== undefined);
  if (ordinary && structured)
    invalid("Choose a body source or initial-message-segments, not both.");
  if (structured)
    return jsonSource(
      args,
      reader,
      "--initial-message-segments",
      "--initial-message-segments-file",
    );
  return parseActorReferences((await markdownBodySource(args, reader))!);
}
const creationOptions = {
  "--description": flag("Optional description."),
  "--member-id": flag(
    "Explicit member Actor ID; repeat for each member.",
    true,
  ),
  "--member-ids": flag("Explicit member Actor ID array as JSON."),
  ...bodyOptions,
  ...jsonOptions(
    "initial-message-segments",
    "Initial text/reference segments as a JSON array.",
  ),
};

// TeamHub rejects these in a Task too, but the CLI hides its explanation.
const agentsUnavailableInTask =
  "A Task cannot list, read, create, or change Agents. Say what you need in your final reply; the Meta that started the Task can do it.";
const promptFlags = ["--prompt", "--prompt-file"] as const;
const promptOptions = {
  "--prompt": flag(
    "Complete working prompt; outside code, \\n, \\t and \\\\ are decoded.",
  ),
  "--prompt-file": flag("Read the UTF-8 prompt from a file or - for stdin."),
};
const agentList = definition(
  ["agent", "list"],
  "list_available_agents",
  "List active General Agents of the current Human sponsor.",
  listOptions,
  async (args) => {
    assertPositionals(args, 0);
    return {
      input: await validate("list_available_agents", {
        ...optional(
          "limit",
          integer(option(args, "--limit"), "--limit", 1, 100),
        ),
        ...optional("cursor", option(args, "--cursor")),
      }),
    };
  },
  { readOnly: true, unavailableInTask: agentsUnavailableInTask },
);
const agentGet = definition(
  ["agent", "get"],
  "get_agent",
  "Read one General Agent's name, description and complete prompt.",
  { "--agent-id": flag("Exact Agent Actor ID from teamhub agent list.") },
  async (args) => {
    assertPositionals(args, 0);
    return {
      input: await validate("get_agent", {
        actor_id: requiredOption(args, "--agent-id"),
      }),
    };
  },
  { readOnly: true, unavailableInTask: agentsUnavailableInTask },
);
const agentCreate = definition(
  ["agent", "create"],
  "create_agent",
  "Create a General Agent in this Room; a Direct Room needs the sponsor's card.",
  {
    "--name": flag("Stable role-oriented Agent name."),
    "--description": flag("Optional Human-facing description."),
    ...promptOptions,
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    return {
      input: await validate("create_agent", {
        name: requiredOption(args, "--name"),
        prompt: await markdownBodySource(args, reader, true, promptFlags),
        ...optional("description", option(args, "--description")),
      }),
    };
  },
  {
    approval: "confirm",
    unavailableInTask: agentsUnavailableInTask,
    notes: [
      "Outside a Direct Room the new Agent joins this Room at once; wake it there with an Agent reference.",
      "In a Direct Room the sponsor first approves a confirmation card in the chat; TeamHub then creates the Agent and sends you the result, or the denial and its reason.",
    ],
  },
);
const agentUpdate = definition(
  ["agent", "update"],
  "update_agent",
  "Change the name, description or prompt of yourself or another General Agent of the sponsor.",
  {
    "--agent-id": flag("Agent Actor ID to change; omit it to change yourself."),
    "--name": flag("New Agent name."),
    "--description": flag("New Human-facing description."),
    ...promptOptions,
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    const input = {
      ...optional("actor_id", option(args, "--agent-id")),
      ...optional("name", option(args, "--name")),
      ...optional("description", option(args, "--description")),
      ...optional(
        "prompt",
        await markdownBodySource(args, reader, false, promptFlags),
      ),
    };
    if (!["name", "description", "prompt"].some((key) => key in input))
      invalid("Provide --name, --description, --prompt or --prompt-file.");
    return { input: await validate("update_agent", input) };
  },
  {
    approval: "confirm",
    unavailableInTask: agentsUnavailableInTask,
    notes: [
      "TeamHub applies the change at once only to an uninitialized Agent in this Room. Otherwise the sponsor approves a confirmation card in the chat; TeamHub then applies it and sends you the result, or the denial and its reason.",
    ],
  },
);

function projectConnection(value: unknown): Json {
  const { appKey, ...connection } = object(value, "Connection");
  return { ...connection, name: appKey };
}
const appsList = definition(
  ["apps", "list"],
  "list_connected_apps",
  "List connected app accounts delegated to this Agent.",
  {},
  async (args) => {
    assertPositionals(args, 0);
    return { input: {} };
  },
  {
    readOnly: true,
    notes: [
      "When the needed app is missing, run teamhub apps connect <app-key>.",
    ],
    project: (result) => ({
      connections: (result.connections as unknown[]).map(projectConnection),
    }),
  },
);
const appsConnect: CommandDefinition = {
  command: ["apps", "connect"],
  toolName: "connect_app",
  operationId: false,
  description:
    "Request access to one Connected App: returns the delegated account, or posts an authorization card in this chat when none is authorized.",
  readOnly: true,
  usage: ["teamhub apps connect <app-key> [--account <connection-id|label>]"],
  arguments: ["<app-key>"],
  options: {
    "--account": flag(
      "Select a connection ID or complete account label; when authorization is missing, an authorization card is shown in the chat.",
    ),
  },
  notes: [
    "Use this when the app the user wants has no delegated account in apps list, instead of asking the Human to connect it manually. After the Human completes the card, continue the original task.",
    "Help and schema are available offline; TeamHub checks current access at execution time.",
  ],
  inputSchema: {
    type: "object",
    properties: {
      appKey: { type: "string", pattern: "^[a-z0-9_]{1,120}$" },
      account: { type: "string" },
    },
    required: ["appKey"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { const: "ready" },
      account: { type: "object" },
    },
    required: ["status", "account"],
  },
  normalize: async (args) => {
    assertPositionals(args, 1);
    const appKey = args.positionals[0]!;
    if (!/^[a-z0-9_]{1,120}$/u.test(appKey))
      invalid("<app-key> must be a catalog key such as linear.");
    const account = option(args, "--account");
    validateAccountSelector(account);
    return { input: { appKey, ...optional("account", account) } };
  },
  execute: async (input, context) => ({
    status: "ready",
    account: await resolveConnectorAccount(
      context,
      input.appKey as string,
      input.account as string | undefined,
    ),
  }),
  render: (result) => {
    const account = result.account as Json;
    return `Connected: ${singleLineText(account.connection_id)} (${singleLineText(account.identity_label ?? account.display_name)})`;
  },
};
const browserConnect: CommandDefinition = {
  command: ["browser", "connect"],
  toolName: "request_browser_connection",
  operationId: false,
  description:
    "Ask the owner of this Computer to connect their everyday Chrome: posts a browser connection card in this chat unless Chrome is already connected.",
  // Like apps connect it only requests a card; TeamHub reuses a pending one,
  // so a repeated call needs no receipt.
  readOnly: true,
  usage: ["teamhub browser connect"],
  options: {},
  notes: [
    "Run this when a browser tool returns BROWSER_CONNECTION_REQUIRED or BROWSER_CONNECTION_INVALID. Never ask for the extension token in a message.",
    "When it posts the card, end your turn. The card result wakes you when the owner connects Chrome or declines.",
  ],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      status: { enum: ["ready", "connection_requested"] },
      message_id: { type: "string" },
      interaction_id: { type: "string" },
    },
    required: ["status"],
  },
  normalize: async (args) => {
    assertPositionals(args, 0);
    return { input: {} };
  },
  execute: async (_input, context) => {
    const result = await teamHubData(
      context.client.api.POST("/api/agent/v1/computer/browser-connection", {
        body: {},
      }),
    );
    if (result.status !== "ready" && result.status !== "connection_requested")
      throw new CliError(
        "invalid_response",
        "TeamHub did not answer the browser connection request.",
      );
    return result;
  },
  render: (result) =>
    result.status === "ready"
      ? "Chrome is connected. Call the browser tool again."
      : `Browser connection card posted (${singleLineText(result.message_id)}). End your turn now; the card result wakes you when the owner connects Chrome or declines.`,
};
const autoRemindersItem = {
  type: "object",
  properties: {
    connection_id: { type: "string" },
    app_key: { type: "string" },
    identity_label: { type: "string" },
    status: { type: "string" },
    enabled: { type: "boolean" },
  },
  required: ["connection_id", "app_key", "identity_label", "status", "enabled"],
};
const autoRemindersLine = (item: Json): string =>
  `${singleLineText(item.connection_id)}  ${singleLineText(item.app_key)}  ${singleLineText(item.identity_label)}  auto reminders ${item.enabled ? "on" : "off"}`;
const autoRemindersNote =
  "Auto reminders let AnotherMe watch the Human's Gmail, Outlook, Google Calendar or Slack and remind them of things that need attention. Only Another Me can use it, and only for connections its own Human owns.";
const appsAutoRemindersList: CommandDefinition = {
  command: ["apps", "auto-reminders", "list"],
  toolName: "list_auto_reminders",
  operationId: false,
  description:
    "List your Human's connected apps that support auto reminders, and whether each is on.",
  readOnly: true,
  usage: ["teamhub apps auto-reminders list"],
  options: {},
  notes: [autoRemindersNote],
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: { connections: { type: "array", items: autoRemindersItem } },
    required: ["connections"],
  },
  normalize: async (args) => {
    assertPositionals(args, 0);
    return { input: {} };
  },
  execute: async (_input, context) =>
    teamHubData(
      context.client.api.POST("/api/agent/v1/apps/auto-reminders/list", {
        body: {},
      }),
    ),
  render: (result) => {
    const items = result.connections as Json[];
    return items.length
      ? items.map(autoRemindersLine).join("\n")
      : "No connected app supports auto reminders.";
  },
};
const appsAutoRemindersSet: CommandDefinition = {
  command: ["apps", "auto-reminders", "set"],
  toolName: "set_auto_reminders",
  operationId: true,
  description:
    "Turn auto reminders on or off for one of your Human's connections when they ask.",
  readOnly: false,
  usage: ["teamhub apps auto-reminders set <connection-id> --on|--off"],
  arguments: ["<connection-id>"],
  options: {
    "--on": { description: "Turn auto reminders on.", boolean: true },
    "--off": { description: "Turn auto reminders off.", boolean: true },
  },
  examples: ["teamhub apps auto-reminders set <connection-id> --off"],
  notes: [
    autoRemindersNote,
    "Find the connection ID with teamhub apps auto-reminders list. Repeating the same switch is harmless, so replaying after an unknown outcome is safe.",
  ],
  inputSchema: {
    type: "object",
    properties: {
      connectionId: { type: "string", minLength: 1, maxLength: 128 },
      enabled: { type: "boolean" },
    },
    required: ["connectionId", "enabled"],
    additionalProperties: false,
  },
  outputSchema: autoRemindersItem,
  normalize: async (args) => {
    assertPositionals(args, 1);
    const connectionId = args.positionals[0]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(connectionId))
      invalid("<connection-id> must be a connection ID from the list.");
    const on = option(args, "--on") !== undefined;
    const off = option(args, "--off") !== undefined;
    if (on === off) invalid("Choose exactly one of --on or --off.");
    return { input: { connectionId, enabled: on } };
  },
  execute: async (input, context) =>
    teamHubData(
      context.client.api.POST("/api/agent/v1/apps/auto-reminders/set", {
        body: {
          connection_id: input.connectionId as string,
          enabled: input.enabled as boolean,
        },
      }),
    ),
  render: (result) => autoRemindersLine(result),
};
const appsSearch = definition(
  ["apps", "search"],
  "search_app_tools",
  "Discover versioned tools for one concrete app action.",
  {
    "--connectionId": flag("Exact delegated connection ID."),
    "--name": flag("Exact application name, for example notion."),
    "--limit": flag("Maximum tools; 1-50, default 20."),
  },
  async (args) => {
    assertPositionals(args, 1);
    const input: Json = {
      query: args.positionals[0],
      ...optional("connectionId", option(args, "--connectionId")),
      ...optional("name", option(args, "--name")),
      ...optional("limit", integer(option(args, "--limit"), "--limit", 1, 50)),
    };
    const { name, ...wire } = input;
    return {
      input: await validate("search_app_tools", input, {
        ...wire,
        ...optional("appKey", name),
      }),
    };
  },
  {
    readOnly: true,
    arguments: ["<query>"],
    execute: async (input, context) => {
      const { decodeAgentCommandResult } = await import("./business-routes.js");
      const result = await teamHubData(
        context.client.api.POST("/api/agent/v1/apps/tools/search", {
          // The generated type requires limit because the contract gives it a
          // default; an omitted limit takes that default.
          body: {
            query: input.query as string,
            ...optional("connection_id", input.connectionId),
            ...optional("app_key", input.name),
            ...optional("limit", input.limit),
          } as never,
        }),
      );
      return decodeAgentCommandResult("search_app_tools", result);
    },
    project: (result) => ({
      tools: (result.tools as Json[]).map(
        ({ appKey, availableConnections, ...tool }) => ({
          ...tool,
          name: appKey,
          availableConnections: (availableConnections as unknown[]).map(
            projectConnection,
          ),
        }),
      ),
    }),
  },
);
const appsExecute = definition(
  ["apps", "execute"],
  "execute_app_tool",
  "Execute one exact app tool version; uncertain results are not retried automatically.",
  {
    "--connectionId": flag("Delegated connection ID."),
    "--toolSlug": flag("Exact toolSlug from search."),
    "--toolVersion": flag("Exact immutable toolVersion from search."),
    ...jsonOptions("arguments", "Complete tool arguments as a JSON object."),
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    const argumentsValue = await jsonSource(
      args,
      reader,
      "--arguments",
      "--arguments-file",
    );
    if (argumentsValue === undefined)
      invalid(
        "Provide --arguments or --arguments-file, including {} for a tool without arguments.",
      );
    return {
      input: await validate("execute_app_tool", {
        connectionId: requiredOption(args, "--connectionId"),
        toolSlug: requiredOption(args, "--toolSlug"),
        toolVersion: requiredOption(args, "--toolVersion"),
        arguments: object(argumentsValue, "--arguments"),
      }),
    };
  },
);

const knowledgeDefinitions: CommandDefinition[] = [
  definition(
    ["knowledge", "search"],
    "search_knowledge",
    "Search every source of authorized knowledge; each result names its source kind.",
    {
      "--alternate": flag(
        "Synonym, translation or related term searched beside the query; up to 6.",
        true,
      ),
      ...Object.fromEntries(
        ["date-from", "date-to", "event-from", "event-to"].map((name) => [
          `--${name}`,
          flag("YYYY-MM-DD ranking preference; other dates may appear."),
        ]),
      ),
    },
    async (args) => {
      assertPositionals(args, 1);
      const input: Json = { query: args.positionals[0] };
      if (values(args, "--alternate").length)
        input.alternates = [...values(args, "--alternate")];
      for (const [name, field] of [
        ["date-from", "dateFrom"],
        ["date-to", "dateTo"],
        ["event-from", "eventFrom"],
        ["event-to", "eventTo"],
      ])
        Object.assign(input, optional(field!, option(args, `--${name}`)));
      await validate("search_knowledge", input);
      return { input };
    },
    {
      readOnly: true,
      arguments: ["<query>"],
      execute: async (input, context) => {
        const { formatKnowledgeCliOutput } =
          await import("./domains/knowledge/format-output.js");
        return formatKnowledgeCliOutput(
          "search",
          input,
          await teamHubData(
            context.client.api.POST("/api/agent/v1/knowledge/search", {
              body: input as never,
            }),
          ),
        );
      },
    },
  ),
  definition(
    ["knowledge", "read"],
    "read_knowledge",
    "Read exact authorized evidence sections.",
    {
      "--section-id": flag(
        "Exact sectionId from this source; 1-8 unique values.",
        true,
      ),
      "--offset": flag("Continue one section at this exact offset; 0-200000."),
    },
    async (args) => {
      assertPositionals(args, 1);
      const input: Json = { evidenceId: args.positionals[0] };
      const sectionIds = [...values(args, "--section-id")];
      if (
        sectionIds.length < 1 ||
        sectionIds.length > 8 ||
        new Set(sectionIds).size !== sectionIds.length
      )
        invalid("Provide 1-8 distinct --section-id values.");
      const offset = integer(option(args, "--offset"), "--offset", 0, 200000);
      if (offset !== undefined && sectionIds.length !== 1)
        invalid("--offset requires exactly one --section-id.");
      Object.assign(input, { sectionIds }, optional("offset", offset));
      await validate("read_knowledge", input, rawReadWire(input));
      return { input };
    },
    {
      readOnly: true,
      arguments: ["<evidence-id>"],
      execute: async (input, context) => {
        const { formatKnowledgeCliOutput } =
          await import("./domains/knowledge/format-output.js");
        const wire = rawReadWire(input);
        return formatKnowledgeCliOutput(
          "read",
          wire,
          await teamHubData(
            context.client.api.POST("/api/agent/v1/knowledge/read", {
              body: wire as never,
            }),
          ),
        );
      },
    },
  ),
];
function rawReadWire(input: Json): Json {
  return {
    evidenceId: input.evidenceId,
    sectionRequests: (input.sectionIds as string[]).map((sectionId) => ({
      sectionId,
      ...optional("offset", input.offset),
    })),
  };
}

const skillPublish = definition(
  ["profile", "skill", "publish"],
  "publish_skill",
  "Publish a deterministic Skill package from an existing folder.",
  {},
  async (args, reader) => {
    assertPositionals(args, 1);
    if (args.positionals[0] === "-")
      invalid("Skill publication requires a real local folder.");
    return {
      input: {
        folder_path: (await import("node:path")).default.resolve(
          reader.cwd,
          args.positionals[0]!,
        ),
      },
    };
  },
  {
    schema: false,
    operationId: false,
    fileRoute: "skill/publish",
    arguments: ["<folder>"],
  },
);
const roomCreate = definition(
  ["room", "create"],
  "create_room",
  "Request Human approval for a Room and its first message.",
  {
    "--name": flag("Proposed Room name."),
    ...creationOptions,
    "--artifact-id": flag(
      "Authorized existing Document ID; repeat up to five times.",
      true,
    ),
    "--artifacts": flag("Authorized Document IDs as a JSON array."),
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    return {
      input: await validate("create_room", {
        name: requiredOption(args, "--name"),
        ...optional("description", option(args, "--description")),
        member_ids: uniqueList(args, "--member-id", "--member-ids", true),
        ...optional(
          "artifacts",
          uniqueList(args, "--artifact-id", "--artifacts", false),
        ),
        initial_message_segments: await initialMessage(args, reader),
      }),
    };
  },
  {
    defaultTarget: "room",
    unavailableInTask: reportInFinalReply,
  },
);
const collaborate = definition(
  ["room", "collaborate"],
  "create_team_md",
  "Publish a complete team.md collaboration protocol in this Room.",
  bodyOptions,
  async (args, reader) => {
    assertPositionals(args, 0);
    return {
      input: await validate("create_team_md", {
        content: await markdownBodySource(args, reader),
      }),
    };
  },
  {
    defaultTarget: "room",
    unavailableInTask: reportInFinalReply,
  },
);
const roomMembers = definition(
  ["room", "members"],
  "get_room_members",
  "Read current members of the configured Room or one of its Threads.",
  { "--thread": flag("Use this Thread ID inside the configured Room.") },
  async (args) => {
    assertPositionals(args, 0);
    const selected = targetFromFlags(args, ["thread"]);
    return {
      ...selected,
      input: selected.target
        ? await validate("get_room_members", {
            inbox_id: `thread:${selected.target.id}`,
          })
        : {},
    };
  },
  { readOnly: true, operationId: false, defaultTarget: "room" },
);
const roomInvite = definition(
  ["room", "invite"],
  "add_room_member",
  "Add an existing Agent to the configured Room.",
  { "--agent-id": flag("Exact Agent Actor ID from teamhub agent list.") },
  async (args) => {
    assertPositionals(args, 0);
    return {
      input: await validate("add_room_member", {
        actor_id: requiredOption(args, "--agent-id"),
      }),
    };
  },
  {
    defaultTarget: "room",
    unavailableInTask:
      "A Task cannot add Agents to a Room. Say which Agent you need in your final reply; the Meta that started the Task can invite it.",
    notes: [
      "The Agent joins at once with your sponsor's authority; wake it there with an Agent reference.",
      "A Direct Room or Thread keeps its members; create a collaboration Room with teamhub room create instead.",
    ],
  },
);
const roomProtocol = definition(
  ["room", "protocol"],
  "get_team_md",
  "Read the current collaboration protocol of the configured Room.",
  {},
  async (args) => {
    assertPositionals(args, 0);
    return { input: {} };
  },
  { readOnly: true, operationId: false, defaultTarget: "room" },
);
const taskCreate = definition(
  ["task", "create"],
  "create_task",
  "Delegate a Task to your own AlterEgo; it starts at once, no approval is requested.",
  {
    "--name": flag("Short Task title, 1-120 characters."),
    "--requirement": flag(
      "Self-contained plain-text brief: the work, the Room context it needs, Document IDs or file paths, the completion standard and what to report.",
    ),
    "--requirement-file": flag(
      "Read the requirement from a UTF-8 file, or - for stdin.",
    ),
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    const inline = option(args, "--requirement");
    const file = option(args, "--requirement-file");
    if ((inline === undefined) === (file === undefined))
      invalid("Provide exactly one of --requirement or --requirement-file.");
    return {
      input: await validate("create_task", {
        name: requiredOption(args, "--name"),
        requirement: inline ?? (await reader.text(file!)),
      }),
    };
  },
  {
    defaultTarget: "room",
    unavailableInTask: reportInFinalReply,
  },
);
const taskCheck = definition(
  ["task", "check"],
  "check_task",
  "Show one delegated Task's status, activity, pending approvals and last report, or list this Room's Tasks.",
  { "--task-id": flag("Task to show; omit to list this Room's Tasks.") },
  async (args) => {
    assertPositionals(args, 0);
    return {
      input: await validate(
        "check_task",
        optional("task_id", option(args, "--task-id")),
      ),
    };
  },
  {
    readOnly: true,
    operationId: false,
    defaultTarget: "room",
    unavailableInTask: reportInFinalReply,
  },
);
const taskSend = definition(
  ["task", "send"],
  "send_task",
  "Continue, correct or wake a delegated Task; queues behind a running turn unless --steer joins it.",
  {
    "--task-id": flag("Task to message."),
    "--message": flag("Plain-text instruction for the Task's AlterEgo."),
    "--message-file": flag(
      "Read the message from a UTF-8 file, or - for stdin.",
    ),
    "--steer": {
      description:
        "Join the running turn when it can take the message; otherwise it runs next.",
      boolean: true,
    },
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    const inline = option(args, "--message");
    const file = option(args, "--message-file");
    if ((inline === undefined) === (file === undefined))
      invalid("Provide exactly one of --message or --message-file.");
    return {
      input: await validate("send_task", {
        task_id: requiredOption(args, "--task-id"),
        message: inline ?? (await reader.text(file!)),
        ...(option(args, "--steer") === undefined ? {} : { steer: true }),
      }),
    };
  },
  {
    defaultTarget: "room",
    unavailableInTask: reportInFinalReply,
  },
);
const taskStop = definition(
  ["task", "stop"],
  "stop_task",
  "Cancel a delegated Task's current turn; its work is kept and task send resumes it.",
  { "--task-id": flag("Task to stop.") },
  async (args) => {
    assertPositionals(args, 0);
    return {
      input: await validate("stop_task", {
        task_id: requiredOption(args, "--task-id"),
      }),
    };
  },
  {
    defaultTarget: "room",
    unavailableInTask: reportInFinalReply,
  },
);

async function schedule(
  args: CommandArguments,
  reader: CommandInputReader,
): Promise<unknown> {
  const jsonProvided = ["--schedule", "--schedule-file"].some(
    (name) => option(args, name) !== undefined,
  );
  const daily = option(args, "--daily"),
    weekly = option(args, "--weekly"),
    every = option(args, "--every-hours"),
    at = option(args, "--at"),
    timezone = option(args, "--timezone"),
    weekdays = values(args, "--weekday");
  const simple = [daily, weekly, every, at].filter(
    (value) => value !== undefined,
  ).length;
  if (jsonProvided) {
    if (simple || timezone !== undefined || weekdays.length)
      invalid(
        "Complete schedule JSON is exclusive with all simple schedule flags.",
      );
    return jsonSource(args, reader, "--schedule", "--schedule-file");
  }
  if (simple !== 1)
    invalid(
      "Choose --daily, --weekly, --every-hours, --at or complete schedule JSON.",
    );
  if (at !== undefined) {
    if (weekdays.length) invalid("--at cannot include weekday.");
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(at) || Number.isNaN(Date.parse(at)))
      invalid(
        "--at must be an RFC 3339 time with an offset, such as 2026-10-22T14:30:00-04:00.",
      );
    return { kind: "once", run_at: at, ...optional("timezone", timezone) };
  }
  if (every !== undefined) {
    if (timezone !== undefined || weekdays.length)
      invalid("--every-hours cannot include timezone or weekday.");
    return {
      kind: "every_n_hours",
      interval_hours: integer(every, "--every-hours", 1, 168),
    };
  }
  if (timezone === undefined)
    invalid("Provide --timezone explicitly for a daily or weekly schedule.");
  if (daily !== undefined) {
    if (weekdays.length) invalid("--weekday requires --weekly.");
    return { kind: "daily", time: daily, timezone };
  }
  return { kind: "weekly", time: weekly, timezone, weekdays: [...weekdays] };
}
const routines = ["create", "list", "pause", "enable", "run", "delete"].map(
  (action) =>
    definition(
      ["routine", action],
      `${action}_routine${action === "list" ? "s" : ""}`,
      action === "run"
        ? "Publish a Routine instruction once; this does not prove Agent work completed."
        : `${action[0]!.toUpperCase() + action.slice(1)} a Routine in the configured Room.`,
      {
        ...(action === "create"
          ? {
              "--name": flag("Routine name."),
              ...bodyOptions,
              "--mention-actor-id": flag(
                "Current Room Agent Actor ID, or self.",
              ),
              ...jsonOptions(
                "schedule",
                "Complete daily, weekly, every_n_hours or once schedule JSON.",
              ),
              "--daily": flag("Daily local time as HH:MM."),
              "--weekly": flag("Weekly local time as HH:MM."),
              "--weekday": flag("Selected weekday; repeat unique days.", true),
              "--timezone": flag("Explicit IANA timezone for daily or weekly."),
              "--every-hours": flag("Repeat every 1-168 hours."),
              "--at": flag(
                "Fire once at this RFC 3339 time (with offset); done afterwards.",
              ),
              "--tracking-item": flag(
                "Tracking Item ID this Routine serves; requires --purpose.",
              ),
              "--purpose": flag(
                "What this Routine checks or reminds for its Tracking Item.",
              ),
            }
          : {}),
      },
      async (args, reader) => {
        assertPositionals(
          args,
          action === "create" || action === "list" ? 0 : 1,
        );
        const input: Json =
          action === "create"
            ? {
                name: requiredOption(args, "--name"),
                instruction: await markdownBodySource(args, reader),
                schedule: await schedule(args, reader),
                ...optional(
                  "mention_actor_id",
                  option(args, "--mention-actor-id"),
                ),
                ...optional(
                  "tracking_item_id",
                  option(args, "--tracking-item"),
                ),
                ...optional("tracking_purpose", option(args, "--purpose")),
              }
            : action === "list"
              ? {}
              : { routine_id: args.positionals[0] };
        if (
          action === "create" &&
          (!(input.name as string).trim() ||
            !(input.instruction as string).trim())
        )
          invalid("Routine name and instruction must not be blank.");
        return {
          input: await validate(
            `${action}_routine${action === "list" ? "s" : ""}`,
            input,
          ),
        };
      },
      {
        readOnly: action === "list",
        defaultTarget: "room-or-task",
        ...(action !== "create" && action !== "list"
          ? { arguments: ["<routine-id>"] }
          : {}),
      },
    ),
);

const trackingItemCommands = (
  [
    ["list", "list_tracking_items"],
    ["add", "add_tracking_item"],
    ["update", "update_tracking_item"],
    ["done", "complete_tracking_item"],
  ] as const
).map(([action, tool]) =>
  definition(
    ["tracking-items", action],
    tool,
    `Tracking Items: ${action}.`,
    action === "list"
      ? {
          ...listOptions,
          "--include-closed": {
            description: "Include done and expired facts.",
            boolean: true,
          },
        }
      : jsonOptions("item", "Tracking Item command JSON; see --schema."),
    async (args, reader) => {
      assertPositionals(args, 0);
      const input =
        action === "list"
          ? {
              ...optional("cursor", option(args, "--cursor")),
              ...optional(
                "limit",
                integer(option(args, "--limit"), "limit", 1, 200),
              ),
              ...(option(args, "--include-closed")
                ? { include_closed: true }
                : {}),
            }
          : object(
              await jsonSource(args, reader, "--item", "--item-file"),
              "input",
            );
      return { input: await validate(tool, input) };
    },
    {
      readOnly: action === "list",
      execute: async (input, context) =>
        await teamHubData(
          context.client.api.POST(`/api/agent/v1/tracking-items/${action}`, {
            body: input as never,
          }),
        ),
    },
  ),
);

const ownerNote =
  "Acts on the Human who owns this Agent (AnotherMe only), never on another Human.";
const personalProfileShow = definition(
  ["personal-profile", "show"],
  "get_personal_profile",
  "Read the current Personal Profile document of the Human who owns this Agent.",
  {},
  async (args) => {
    assertPositionals(args, 0);
    return { input: await validate("get_personal_profile", {}) };
  },
  {
    readOnly: true,
    notes: [
      ownerNote,
      "Prints the revision_id and the profile JSON document to edit; says so when the owner has no Personal Profile yet.",
    ],
  },
);
const personalProfileStart = definition(
  ["personal-profile", "start"],
  "start_personal_profile_build",
  "Tell the Profile page of the Human who owns this Agent that their Personal Profile is being written.",
  {},
  async (args) => {
    assertPositionals(args, 0);
    return { input: await validate("start_personal_profile_build", {}) };
  },
  {
    notes: [
      ownerNote,
      "Run it when you start gathering sources for a new or rebuilt Profile, before delegating the work.",
      "The next personal-profile write ends the build; otherwise it ends after 30 minutes. Running it again keeps the original start.",
    ],
  },
);
const personalProfileWrite = definition(
  ["personal-profile", "write"],
  "write_personal_profile",
  "Replace the whole Personal Profile of the Human who owns this Agent with the given JSON document.",
  {
    "--base-revision": flag(
      "revision_id from personal-profile show; omit only when show returned current: null.",
    ),
    "--source-app": flag(
      "An app key actually used as evidence; repeat for each app.",
      true,
    ),
    "--content": flag("Inline complete profile JSON document."),
    "--file": flag(
      "Read the profile JSON document from a file or - for stdin.",
    ),
  },
  async (args, reader) => {
    assertPositionals(args, 0);
    const profile = await jsonSource(args, reader, "--content", "--file");
    if (profile === undefined)
      throw new CliError("usage", "Provide --content or --file.");
    return {
      input: await validate("write_personal_profile", {
        ...optional("base_revision_id", option(args, "--base-revision")),
        profile,
        ...(values(args, "--source-app").length
          ? { source_apps: values(args, "--source-app") }
          : {}),
      }),
    };
  },
  {
    notes: [
      ownerNote,
      "Run personal-profile show first, edit its profile JSON, write the complete document, and pass its revision_id as --base-revision.",
      "TeamHub validates the document and renders its Markdown; profile_document_invalid and profile_module_empty name the rejected field.",
      "A profile_revision_conflict means the Profile changed since you read it: show it again, merge, and write again.",
    ],
  },
);
const accountProfileShow = definition(
  ["account-profile", "show"],
  "get_account_profile",
  "Read the name, bio and organization of the Human who owns this Agent.",
  {},
  async (args) => {
    assertPositionals(args, 0);
    return { input: await validate("get_account_profile", {}) };
  },
  { readOnly: true, notes: [ownerNote] },
);
const accountProfileUpdate = definition(
  ["account-profile", "update"],
  "update_account_profile",
  "Set the name, bio or organization of the Human who owns this Agent.",
  {
    "--name": flag("Display name."),
    "--bio": flag("Short bio."),
    "--organization": flag("Organization."),
  },
  async (args) => {
    assertPositionals(args, 0);
    const input = {
      ...optional("name", option(args, "--name")),
      ...optional("bio", option(args, "--bio")),
      ...optional("organization", option(args, "--organization")),
    };
    if (!Object.keys(input).length)
      invalid("Provide --name, --bio or --organization.");
    return { input: await validate("update_account_profile", input) };
  },
  { notes: [ownerNote] },
);

export const businessCommandDefinitions: readonly CommandDefinition[] = [
  agentList,
  agentGet,
  agentCreate,
  agentUpdate,
  appsList,
  appsConnect,
  browserConnect,
  ...computerPermissionCommandDefinitions,
  appsAutoRemindersList,
  appsAutoRemindersSet,
  appsSearch,
  appsExecute,
  ...knowledgeDefinitions,
  ...trackingItemCommands,
  personalProfileShow,
  personalProfileStart,
  personalProfileWrite,
  accountProfileShow,
  accountProfileUpdate,
  skillPublish,
  roomCreate,
  collaborate,
  roomMembers,
  roomInvite,
  roomProtocol,
  taskCreate,
  taskCheck,
  taskSend,
  taskStop,
  ...routines,
];
