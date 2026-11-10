import { z } from "zod";

export const teamHubIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)
  .describe("Stable TeamHub identifier.");

export const teamHubRoomInboxIdSchema = z
  .string()
  .min(6)
  .max(69)
  .regex(/^room:[A-Za-z0-9][A-Za-z0-9_-]*$/u)
  .describe("TeamHub-internal public Room Inbox identifier.");

export const teamHubThreadInboxIdSchema = z
  .string()
  .min(8)
  .max(71)
  .regex(/^thread:[A-Za-z0-9][A-Za-z0-9_-]*$/u)
  .describe("TeamHub-internal public Thread Inbox identifier.");

export const roomIdSchema = z
  .string()
  .min(6)
  .max(64)
  .regex(/^room[_-][A-Za-z0-9_-]*$/u)
  .describe("Bare TeamHub Room identifier without a room: prefix.");

const taskInboxIdSchema = z
  .string()
  .min(6)
  .max(133)
  .regex(/^task:[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .describe("Public Task Inbox identifier.");

export const sendMessageInboxIdSchema = z
  .union([roomIdSchema, teamHubThreadInboxIdSchema, taskInboxIdSchema])
  .describe(
    "Bare Room identifier, public Thread Inbox prefixed with thread:, or public Task Inbox prefixed with task:.",
  );

export const toTeamHubRoomInboxId = (roomId: string): string =>
  `room:${roomIdSchema.parse(roomId)}`;

export const fromTeamHubRoomInboxId = (inboxId: string): string => {
  const parsed = teamHubRoomInboxIdSchema.parse(inboxId);
  return roomIdSchema.parse(parsed.slice("room:".length));
};

export const toTeamHubPublicInboxId = (inboxId: string): string => {
  const parsed = sendMessageInboxIdSchema.parse(inboxId);
  return taskInboxIdSchema.safeParse(parsed).success ||
    teamHubThreadInboxIdSchema.safeParse(parsed).success
    ? parsed
    : toTeamHubRoomInboxId(parsed);
};

export const fromTeamHubPublicInboxId = (inboxId: string): string => {
  const taskInbox = taskInboxIdSchema.safeParse(inboxId);
  if (taskInbox.success) return taskInbox.data;
  if (teamHubThreadInboxIdSchema.safeParse(inboxId).success) return inboxId;
  return fromTeamHubRoomInboxId(inboxId);
};
