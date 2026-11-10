import {
  type CanvasTarget,
  canvasStatusKeys,
  canvasTargets,
} from "./canvas-targets";

// A canvas is a Room Document whose first block is a code block like
//   canvas: gmail
//   to: lisa@acme.com
//   subject: Follow-up
//   status: draft
// The rest of the Document is the content to deliver.

export type CanvasStatus = "editing" | "draft" | "sent";

export interface CanvasDocument {
  blockId: string;
  /** Registered target, or a generic one named after an unknown id. */
  target: CanvasTarget;
  fields: Record<string, string>;
  status: CanvasStatus;
  link?: string;
}

interface CanvasBlock {
  id: string;
  type: string;
  content?: unknown;
}

const headerLine = /^canvas:\s*([a-z0-9][a-z0-9_-]{0,63})\s*$/iu;
const fieldLine = /^([a-z][a-z0-9_]{0,63}):\s?(.*)$/iu;

function codeText(block: CanvasBlock): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((item: unknown) =>
      item && typeof item === "object" && "text" in item
        ? String(item.text)
        : "",
    )
    .join("");
}

export function readCanvas(blocks: CanvasBlock[]): CanvasDocument | undefined {
  const first = blocks[0];
  if (first?.type !== "codeBlock") return undefined;
  const lines = codeText(first).split("\n");
  const id = headerLine.exec(lines[0]?.trim() ?? "")?.[1]?.toLowerCase();
  if (!id) return undefined;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const match = fieldLine.exec(line.trim());
    if (match) fields[match[1]!.toLowerCase()] = match[2]!.trim();
  }
  const status = fields.status;
  return {
    blockId: first.id,
    target: canvasTargets[id] ?? { id, label: id, fields: [] },
    fields,
    status: status === "draft" || status === "sent" ? status : "editing",
    link: /^https:\/\//u.test(fields.link ?? "") ? fields.link : undefined,
  };
}

/**
 * The code block text for these fields: the header first, then the
 * target's fields, the shared status fields, and any others as they were.
 */
export function canvasText(canvas: CanvasDocument): string {
  const order = [
    ...canvas.target.fields.map((field) => field.key),
    ...canvasStatusKeys,
  ];
  const keys = [
    ...order,
    ...Object.keys(canvas.fields).filter((key) => !order.includes(key)),
  ];
  return [
    `canvas: ${canvas.target.id}`,
    ...keys.flatMap((key) =>
      canvas.fields[key] !== undefined ||
      canvas.target.fields.some((field) => field.key === key)
        ? [`${key}: ${(canvas.fields[key] ?? "").replace(/\s*\n\s*/gu, " ")}`]
        : [],
    ),
  ].join("\n");
}
