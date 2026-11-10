import type { Json } from "./connector-runtime.js";

export const str = { type: "string" };
export const id = { type: "string", minLength: 1 };
export const array = (items: Json): Json => ({ type: "array", items });
export const object = (
  properties: Json,
  required: string[] = Object.keys(properties),
): Json => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const accountSchema = object({
  connectionId: id,
  name: id,
  displayName: str,
  identityLabel: str,
});
export const rootSchema = (
  properties: Json,
  required = Object.keys(properties),
): Json =>
  object({ account: accountSchema, ...properties }, ["account", ...required]);
export const pageOutput = { hasMore: { type: "boolean" }, nextCursor: id };
const address = object({ email: id, name: str }, ["email"]);
const attachment = object(
  {
    name: str,
    mimeType: str,
    sizeBytes: { type: "integer", minimum: 0 },
    attachmentId: str,
    type: { enum: ["file", "item", "reference"] },
    isInline: { type: "boolean" },
  },
  [],
);
export const mailSummarySchema = object(
  {
    messageId: id,
    threadId: id,
    subject: str,
    from: address,
    receivedAt: { type: "string", format: "date-time" },
    unread: { type: "boolean" },
    snippet: str,
  },
  ["messageId"],
);
export const mailSchema = {
  ...object(
    {
      ...(mailSummarySchema.properties as Json),
      to: array(address),
      cc: array(address),
      bcc: array(address),
      bodyText: str,
      bodyHtml: str,
      attachments: array(attachment),
    },
    ["messageId"],
  ),
  anyOf: [{ required: ["bodyText"] }, { required: ["bodyHtml"] }],
};
export const mailWriteSchema = object(
  {
    action: { enum: ["sent", "drafted", "draft_updated", "archived"] },
    acknowledged: { const: true },
    messageId: id,
    threadId: id,
    draftId: id,
    url: id,
  },
  ["action", "acknowledged"],
);
const eventTime = {
  oneOf: [
    object({ date: { type: "string", format: "date" } }),
    object(
      { dateTime: { type: "string", format: "date-time" }, timeZone: id },
      ["dateTime"],
    ),
  ],
};
export const eventSchema = object(
  {
    eventId: id,
    calendarId: id,
    title: str,
    description: str,
    location: str,
    status: str,
    organizerEmail: str,
    url: str,
    meetingUrl: str,
    recurringEventId: str,
    start: eventTime,
    end: eventTime,
    attendees: array(object({ email: id, responseStatus: str }, ["email"])),
  },
  ["eventId"],
);
export const calendarWriteSchema = object(
  {
    action: { enum: ["created", "updated", "canceled"] },
    acknowledged: { const: true },
    event: eventSchema,
    eventId: id,
  },
  ["action", "acknowledged"],
);
