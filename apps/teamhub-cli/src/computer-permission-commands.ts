import { sleep } from "@linger/service-kit";
import type { components } from "@linger/wire-contracts/teamhub-agent-api/types";
import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, option } from "./command-input.js";
import { displayText } from "./display-text.js";
import { CliError } from "./errors.js";
import { teamHubData } from "./http-client.js";

type Schemas = components["schemas"];
type PermissionId = Schemas["ComputerPermissionId"];
type Subject = Schemas["ComputerPermissionSubject"];
type PermissionStatus = Schemas["ComputerPermissionStatus"];

const permissionIds: readonly PermissionId[] = [
  "screen_recording",
  "accessibility",
];
const subjectByFor: Readonly<Record<string, Subject>> = {
  shell: "linger",
  "computer-use": "computer_use",
};
const subjectLabels: Readonly<Record<Subject, string>> = {
  linger: "Linger",
  computer_use: "Computer use (CuaDriver)",
};
// The card settles itself on the owner's Mac; polling only lets a short
// --wait observe that without ending the turn.
const pollIntervalMs = 2_000;
const maxWaitSeconds = 120;
const maxReasonLength = 200;

const singleLineText = (value: unknown): string =>
  displayText(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
function invalid(message: string): never {
  throw new CliError("usage", message);
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const permissionStatusSchema = {
  type: "object",
  properties: {
    platform: { enum: ["darwin", "windows", "linux"] },
    host: { enum: ["desktop", "standalone"] },
    subjects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { enum: ["linger", "computer_use"] },
          permissions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { enum: permissionIds },
                state: {
                  enum: ["granted", "denied", "not_determined", "unknown"],
                },
                prompt: { enum: ["available", "settings_only"] },
                relaunch_required: { type: "boolean" },
              },
              required: ["id", "state", "prompt", "relaunch_required"],
            },
          },
        },
        required: ["subject", "permissions"],
      },
    },
  },
  required: ["platform", "host", "subjects"],
};

function permissionLines(computerID: unknown, value: unknown): string[] {
  const status = asRecord(value);
  const subjects = Array.isArray(status.subjects) ? status.subjects : [];
  const header = `Computer ${singleLineText(computerID)} (${singleLineText(status.platform)}, ${singleLineText(status.host)})`;
  if (!subjects.length)
    return [`${header}: not a Mac, so no privacy permissions are needed.`];
  return [
    `${header}:`,
    ...subjects.map((item) => {
      const subject = asRecord(item);
      const label =
        subjectLabels[subject.subject as Subject] ??
        singleLineText(subject.subject);
      const entries = (
        Array.isArray(subject.permissions) ? subject.permissions : []
      ).map((entry) => {
        const permission = asRecord(entry);
        const relaunch = permission.relaunch_required
          ? " (relaunch needed)"
          : "";
        return `${singleLineText(permission.id)} ${singleLineText(permission.state)}${relaunch}`;
      });
      return `  ${label}: ${entries.join(", ")}`;
    }),
  ];
}

function allGranted(
  status: PermissionStatus,
  subject: Subject,
  permissions: readonly PermissionId[],
): boolean {
  const entries =
    status.subjects.find((item) => item.subject === subject)?.permissions ?? [];
  return permissions.every(
    (id) => entries.find((entry) => entry.id === id)?.state === "granted",
  );
}

async function readStatus(
  client: Parameters<NonNullable<CommandDefinition["execute"]>>[1]["client"],
): Promise<{ computer_id: string; permissions: PermissionStatus }> {
  return teamHubData(
    client.api.POST("/api/agent/v1/computer/permissions/status", { body: {} }),
  );
}

const computerPermissionsStatus: CommandDefinition = {
  command: ["computer", "permissions", "status"],
  toolName: "read_computer_permissions",
  operationId: false,
  description:
    "Read the macOS privacy permissions (Screen Recording, Accessibility) of this Agent's Computer for Linger and for computer use.",
  readOnly: true,
  usage: ["teamhub computer permissions status"],
  options: {},
  notes: [
    "Linger owns shell commands such as screencapture and osascript; Computer use (CuaDriver) owns the computer-use tools.",
    "When a permission is missing, run teamhub computer permissions request. Never operate System Settings or privacy prompts yourself.",
  ],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      computer_id: { type: "string" },
      permissions: permissionStatusSchema,
    },
    required: ["computer_id", "permissions"],
  },
  normalize: async (args) => {
    assertPositionals(args, 0);
    return { input: {} };
  },
  execute: async (_input, context) => ({
    ...(await readStatus(context.client)),
  }),
  render: (result) =>
    permissionLines(result.computer_id, result.permissions).join("\n"),
};

function parsePermissions(value: string | undefined): PermissionId[] {
  if (value === undefined) invalid("Provide --permissions.");
  const list = value.split(",").map((item) => item.trim());
  if (list.some((item) => !permissionIds.includes(item as PermissionId)))
    invalid(
      "--permissions must be a comma list of screen_recording and accessibility.",
    );
  if (new Set(list).size !== list.length)
    invalid("--permissions values must be unique.");
  return list as PermissionId[];
}
function parseWait(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (
    !/^[1-9]\d*$/u.test(value) ||
    Number(value) < 1 ||
    Number(value) > maxWaitSeconds
  )
    invalid(`--wait must be an integer from 1 to ${maxWaitSeconds}.`);
  return Number(value);
}

const computerPermissionsRequest: CommandDefinition = {
  command: ["computer", "permissions", "request"],
  toolName: "request_computer_permission",
  operationId: false,
  description:
    "Ask the owner of this Computer to grant macOS permissions: posts a permission card in this chat unless they are already granted.",
  // Like browser connect it only requests a card; TeamHub reuses a pending
  // one, so a repeated call needs no receipt.
  readOnly: true,
  usage: [
    "teamhub computer permissions request --permissions screen_recording[,accessibility] [--for shell|computer-use] [--reason TEXT] [--wait SECONDS]",
  ],
  options: {
    "--permissions": {
      description: "Comma list of screen_recording and accessibility.",
    },
    "--for": {
      description:
        "shell (default) for Linger, which owns shell commands such as screencapture; computer-use for CuaDriver.",
    },
    "--reason": {
      description: `Optional plain text shown on the card; at most ${maxReasonLength} characters.`,
    },
    "--wait": {
      description: `After posting the card, wait up to this many seconds (1-${maxWaitSeconds}) for the owner to grant.`,
    },
  },
  notes: [
    "Run this when teamhub computer permissions status shows a missing permission, or a screenshot or computer-use tool fails for lack of one.",
    "When it posts the card, end your turn. The card wakes you once everything is granted or the owner declines. Never operate System Settings or privacy prompts yourself.",
  ],
  inputSchema: {
    type: "object",
    properties: {
      subject: { enum: ["linger", "computer_use"] },
      permissions: {
        type: "array",
        items: { enum: permissionIds },
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
      },
      reason: { type: "string", minLength: 1, maxLength: maxReasonLength },
      wait_seconds: { type: "integer", minimum: 1, maximum: maxWaitSeconds },
    },
    required: ["subject", "permissions"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { enum: ["ready", "permission_requested", "granted"] },
      computer_id: { type: "string" },
      permissions: permissionStatusSchema,
      room_id: { type: "string" },
      message_id: { type: "string" },
      interaction_id: { type: "string" },
    },
    required: ["status", "computer_id", "permissions"],
  },
  normalize: async (args) => {
    assertPositionals(args, 0);
    const permissions = parsePermissions(option(args, "--permissions"));
    const target = option(args, "--for") ?? "shell";
    const subject = subjectByFor[target];
    if (!subject) invalid("--for must be shell or computer-use.");
    const reason = option(args, "--reason")?.trim();
    if (reason !== undefined && reason.length === 0)
      invalid("--reason must not be empty.");
    if (reason !== undefined && [...reason].length > maxReasonLength)
      invalid(`--reason must be at most ${maxReasonLength} characters.`);
    const wait = parseWait(option(args, "--wait"));
    return {
      input: {
        subject,
        permissions,
        ...(reason === undefined ? {} : { reason }),
        ...(wait === undefined ? {} : { wait_seconds: wait }),
      },
    };
  },
  execute: async (input, context) => {
    const subject = input.subject as Subject;
    const permissions = input.permissions as PermissionId[];
    const result = await teamHubData(
      context.client.api.POST("/api/agent/v1/computer/permissions/request", {
        body: {
          subject,
          permissions,
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        },
      }),
    );
    if (result.status !== "ready" && result.status !== "permission_requested")
      throw new CliError(
        "invalid_response",
        "TeamHub did not answer the computer permission request.",
      );
    const waitSeconds = input.wait_seconds;
    if (
      result.status !== "permission_requested" ||
      typeof waitSeconds !== "number"
    )
      return result;
    const deadline = Date.now() + waitSeconds * 1_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result;
      await sleep(Math.min(pollIntervalMs, remaining));
      const current = await readStatus(context.client);
      if (allGranted(current.permissions, subject, permissions))
        return { ...result, ...current, status: "granted" };
    }
  },
  render: (result) => {
    const lines = permissionLines(result.computer_id, result.permissions);
    if (result.status === "permission_requested")
      return [
        `Permission card posted (${singleLineText(result.message_id)}). End your turn now; the card wakes you once everything is granted or the owner declines.`,
        ...lines,
      ].join("\n");
    const lead =
      result.status === "granted"
        ? "The owner granted the permissions. Continue your work."
        : "No requested permission is missing. Continue your work.";
    return [lead, ...lines].join("\n");
  },
};

export const computerPermissionCommandDefinitions: readonly CommandDefinition[] =
  [computerPermissionsStatus, computerPermissionsRequest];
