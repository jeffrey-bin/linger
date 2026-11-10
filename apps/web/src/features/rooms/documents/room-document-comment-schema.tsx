import {
  type BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  type PartialBlock,
} from "@blocknote/core";
import { createReactInlineContentSpec } from "@blocknote/react";
import { parseDocumentClipboardAnchor } from "../files/document-clipboard-link";

import { roomDocumentCodeBlockSpec } from "./room-document-mermaid-code-block";
import { roomDocumentImageBlockSpec } from "./room-document-image-preview";
import { RoomDocumentReference } from "./room-document-reference";

const roomDocumentMention = createReactInlineContentSpec(
  {
    content: "none",
    propSchema: {
      actorId: { default: "" },
      label: { default: "" },
    },
    type: "mention",
  },
  {
    render: ({ inlineContent }) => (
      <span
        className="room-document-comment-mention"
        data-actor-id={inlineContent.props.actorId}
      >
        @{inlineContent.props.label.replace(/^@/, "")}
      </span>
    ),
  },
);

const roomDocumentLink = createReactInlineContentSpec(
  {
    content: "none",
    propSchema: {
      documentId: { default: "" },
      href: { default: "" },
      label: { default: "" },
      tenantId: { default: "" },
    },
    type: "documentLink",
  },
  {
    parse: (element) => {
      const link = parseDocumentClipboardAnchor(
        element,
        globalThis.location?.origin ?? "http://localhost",
      );
      return link
        ? {
            documentId: link.documentId,
            href: link.url,
            label: link.title,
            tenantId: link.tenantId,
          }
        : undefined;
    },
    render: ({ inlineContent }) => (
      <RoomDocumentReference {...inlineContent.props} />
    ),
    toExternalHTML: ({ inlineContent }) => (
      <a
        data-linger-document-id={inlineContent.props.documentId}
        data-linger-tenant-id={inlineContent.props.tenantId}
        href={inlineContent.props.href}
      >
        {inlineContent.props.label}
      </a>
    ),
  },
);

export const roomDocumentCommentSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: roomDocumentCodeBlockSpec,
    image: roomDocumentImageBlockSpec(),
  },
}).extend({
  inlineContentSpecs: {
    documentLink: roomDocumentLink,
    mention: roomDocumentMention,
  },
});

export type RoomDocumentEditor = BlockNoteEditor<
  typeof roomDocumentCommentSchema.blockSchema,
  typeof roomDocumentCommentSchema.inlineContentSchema,
  typeof roomDocumentCommentSchema.styleSchema
>;

export type RoomDocumentPartialBlock = PartialBlock<
  typeof roomDocumentCommentSchema.blockSchema,
  typeof roomDocumentCommentSchema.inlineContentSchema,
  typeof roomDocumentCommentSchema.styleSchema
>;
