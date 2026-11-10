import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals } from "./command-input.js";
import { ConnectorError } from "./errors.js";
import {
  connectorDefinition,
  optionalFields,
  requiredString,
  value,
} from "./connector-runtime.js";

// A canvas becomes a Gmail draft whose images show in the body: TeamHub reads
// the canvas, fills the recipients and subject left out from its header,
// embeds its Document images inline, attaches its file blocks and saves the
// draft. Sending stays a
// separate, explicit `gmail send --draft`.
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export const gmailCanvasCommandDefinitions: readonly CommandDefinition[] = [
  connectorDefinition({
    command: ["gmail", "canvas-draft"],
    description:
      "Save the canvas as a Gmail draft with images in the body and file blocks attached; does not send.",
    readOnly: false,
    usage: [
      "teamhub gmail canvas-draft <document-id> [--update <draft-id>] [--to <email> ...] [--cc <email> ...] [--subject <text>] [flags]",
    ],
    options: {
      "--update": value("Update the same draft instead of creating a new one."),
      "--to": value(
        "Recipient; repeatable. Reads the canvas to field when omitted.",
        true,
      ),
      "--cc": value(
        "Cc; repeatable. Reads the canvas cc field when omitted.",
        true,
      ),
      "--subject": value(
        "Subject with no line breaks. Reads the canvas subject when omitted.",
      ),
    },
    examples: [
      "teamhub gmail canvas-draft document_example",
      "teamhub gmail canvas-draft document_example --update r-123",
    ],
    notes: [
      "Images are sent as inline email images; total size must not exceed 5 MiB.",
      "File blocks are sent as attachments; total size must not exceed 15 MiB.",
      "Send with teamhub gmail send --draft <draft-id>.",
    ],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_id"],
      properties: {
        document_id: { type: "string", pattern: idPattern.source },
        update: { type: "string", minLength: 1, maxLength: 256 },
        to: { type: "array", items: { type: "string" }, maxItems: 50 },
        cc: { type: "array", items: { type: "string" }, maxItems: 50 },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: 998,
          pattern: "^[^\\r\\n]*$",
        },
        account: { type: "string" },
      },
    },
    async normalize(args) {
      assertPositionals(args, 1);
      const documentId = args.positionals[0]!;
      if (!idPattern.test(documentId))
        throw new ConnectorError("usage", "Provide a Native Document ID.");
      return {
        input: optionalFields({
          document_id: documentId,
          update: args.options["--update"]?.[0],
          to: args.options["--to"],
          cc: args.options["--cc"],
          subject: args.options["--subject"]?.[0],
        }),
      };
    },
    bindings: () => [],
    async execute(input, runtime) {
      const draftId = input.update as string | undefined;
      const saved = await runtime.write(
        "/api/agent/v1/apps/gmail/canvas-draft",
        optionalFields({
          connection_id: requiredString(
            runtime.account.connection_id,
            "connection ID",
          ),
          document_id: input.document_id,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          draft_id: draftId,
        }),
      );
      return {
        result: {
          action: draftId === undefined ? "drafted" : "draft_updated",
          acknowledged: true,
          draftId: requiredString(saved.draft_id, "draft ID"),
          ...optionalFields({
            messageId: saved.message_id,
            threadId: saved.thread_id,
          }),
          inlineImages: Number(saved.inline_images ?? 0),
          attachments: Array.isArray(saved.attachments)
            ? saved.attachments.map(String)
            : [],
        },
      };
    },
  }),
];
