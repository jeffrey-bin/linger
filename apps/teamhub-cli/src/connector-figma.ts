import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, bodySource, option } from "./command-input.js";
import {
  choice,
  number,
  schema,
  stringSchema,
  text,
  usage,
} from "./connector-input.js";
import {
  connectorDefinition,
  optionalFields,
  record,
  requiredString,
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import {
  assertNewOutput,
  connectorTransferURL,
  saveConnectorDownload,
} from "./connector-files.js";
import { ConnectorError as CliError } from "./errors.js";
import { displayText } from "./display-text.js";
const descriptions = {
  read: "Read a shallow design-file tree or a single node.",
  export:
    "Export selected nodes locally; supports node URLs and explicit multi-select.",
  comments: "List design-file comments and their reply relationships.",
  comment: "Post a comment on a design file or reply to a root comment.",
};
type Action = keyof typeof descriptions;
export const figmaCommandDefinitions: CommandDefinition[] = (
  Object.keys(descriptions) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["figma", action],
    description: descriptions[action],
    readOnly: action !== "comment",
    options:
      action === "read"
        ? {
            "--node": value("Read one node; a URL may include the node-id."),
            "--depth": value("Tree depth 1–5; default 1."),
          }
        : action === "export"
          ? {
              "--node": value(
                "Node ID to export; repeatable; a node URL may omit this.",
                true,
              ),
              "--format": value("png / jpg / svg / pdf; required."),
              "--output": value(
                "Save one node as a new file; save multiple nodes into a new directory.",
              ),
              "--scale": value("png/jpg scale 0.01–4; default 1."),
            }
          : action === "comment"
            ? {
                "--content": value("Comment body; exclusive with --file."),
                "--file": value("UTF-8 body file; - reads stdin."),
                "--reply": value("Root comment ID to reply to."),
              }
            : {},
    usage: [
      `teamhub figma ${action} <file-key|url>${action === "export" ? " [--node <id>] --format <png|jpg|svg|pdf> --output <path>" : action === "comment" ? " (--content <text> | --file <path|->) [--reply <id>]" : ""} [flags]`,
    ],
    examples:
      action === "export"
        ? [
            "teamhub figma export 'https://www.figma.com/design/FILE_KEY/Design?node-id=1-2' --format png --scale 2 --output ./screen.png",
            "teamhub figma export FILE_KEY --node 1:2 --node 1:3 --format pdf --output ./selected-pages",
          ]
        : action === "comment"
          ? [
              "teamhub figma comment FILE_KEY --content 'Please unify this spacing to 16.'",
            ]
          : [
              `teamhub figma ${action} 'https://www.figma.com/design/FILE_KEY/Design'`,
            ],
    notes: [
      "Figma Design only; FigJam, Slides, whole-file export, and PDF merge are out of scope.",
    ],
    inputSchema: schema(
      {
        fileKey: stringSchema,
        ...(action === "read"
          ? {
              nodeId: stringSchema,
              depth: { type: "integer", minimum: 1, maximum: 5, default: 1 },
            }
          : action === "export"
            ? {
                nodes: {
                  type: "array",
                  items: stringSchema,
                  minItems: 1,
                  maxItems: 20,
                  uniqueItems: true,
                },
                format: { enum: ["png", "jpg", "svg", "pdf"] },
                output: stringSchema,
                scale: { type: "number", minimum: 0.01, maximum: 4 },
              }
            : action === "comment"
              ? { content: stringSchema, replyId: stringSchema }
              : {}),
      },
      ["fileKey"],
    ),
    normalize: async (args, reader) => {
      assertPositionals(args, 1);
      const target = figmaTarget(
        text(args.positionals[0], "file key or URL", 4096),
      );
      const input: Json = { fileKey: target.fileKey };
      if (action === "read" || action === "export") {
        const explicit = args.options["--node"] ?? [];
        if (target.nodeId && explicit.length)
          usage("Choose the link's node or explicit --node options, not both.");
        const nodes = [
          ...explicit.map(figmaNode),
          ...(target.nodeId ? [target.nodeId] : []),
        ];
        if (new Set(nodes).size !== nodes.length || nodes.length > 20)
          usage("Choose 1–20 distinct node IDs.");
        if (action === "read") {
          if (nodes[0]) input.nodeId = nodes[0];
          input.depth = number(option(args, "--depth"), "--depth", 1, 5, 1);
        } else {
          if (!nodes.length)
            usage(
              "Provide --node or a node link; whole-file export is not supported.",
            );
          input.nodes = nodes;
          input.format = choice(
            text(option(args, "--format"), "--format"),
            ["png", "jpg", "svg", "pdf"],
            "--format",
          );
          const scale = option(args, "--scale");
          if (
            scale !== undefined &&
            !["png", "jpg"].includes(String(input.format))
          )
            usage("--scale only applies to PNG/JPG.");
          if (
            scale !== undefined &&
            (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(scale) ||
              !Number.isFinite(Number(scale)) ||
              Number(scale) < 0.01 ||
              Number(scale) > 4)
          )
            usage("--scale must be a number from 0.01 to 4.");
          if (["png", "jpg"].includes(String(input.format)))
            input.scale = Number(scale ?? 1);
          input.output = await assertNewOutput(
            text(option(args, "--output"), "--output", 4096),
            reader.cwd,
          );
        }
      }
      if (action === "comment") {
        const body = await bodySource(args, reader, true);
        if (
          !body?.trim() ||
          Buffer.byteLength(body) > 1048576 ||
          body.includes("\u0000")
        )
          usage("Provide nonblank UTF-8 comment text of at most 1 MiB.");
        input.content = body;
        if (option(args, "--reply") !== undefined)
          input.replyId = text(option(args, "--reply"), "--reply");
      }
      return { input };
    },
    bindings: (input) =>
      action === "read"
        ? [input.nodeId ? "FIGMA_GET_FILE_NODES" : "FIGMA_GET_FILE_JSON"]
        : action === "export"
          ? ["FIGMA_GET_FILE_NODES", "FIGMA_RENDER_IMAGES_OF_FILE_NODES"]
          : action === "comments"
            ? ["FIGMA_GET_COMMENTS_IN_A_FILE"]
            : [
                "FIGMA_GET_FILE_JSON",
                "FIGMA_GET_COMMENTS_IN_A_FILE",
                "FIGMA_ADD_A_COMMENT_TO_A_FILE",
              ],
    execute: (input, runtime) => executeFigma(action, input, runtime),
  }),
);
function figmaNode(value: string): string {
  const node = value.replace(/^(\d+)-(\d+)$/u, "$1:$2");
  if (!/^\d+:\d+$/u.test(node)) usage("Use a node ID such as 1:2 or 1-2.");
  return node;
}
export function figmaTarget(value: string): {
  fileKey: string;
  nodeId?: string;
} {
  if (!value.startsWith("https://")) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(value))
      usage("Provide a Figma Design file key or HTTPS link.");
    return { fileKey: value };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    usage("Provide a Figma Design link.");
  }
  const match = /^\/(?:design|file)\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(
    url!.pathname,
  );
  if (
    !["figma.com", "www.figma.com"].includes(url!.hostname) ||
    url!.username ||
    url!.password ||
    url!.port ||
    !match
  )
    usage("Only Figma Design file links are supported.");
  const nodes = url!.searchParams.getAll("node-id");
  if (nodes.length > 1) usage("The link contains multiple node-id values.");
  return {
    fileKey: match![1]!,
    ...(nodes[0] ? { nodeId: figmaNode(nodes[0]) } : {}),
  };
}
function figmaComment(value: unknown): Json {
  const c = record(value);
  return optionalFields({
    commentId: requiredString(c.id, "comment ID"),
    author: c.user
      ? optionalFields({ id: record(c.user).id, name: record(c.user).handle })
      : undefined,
    text: c.message,
    createdAt: c.created_at,
    parentId: c.parent_id || undefined,
    resolvedAt: c.resolved_at,
    position: c.client_meta,
  });
}
function figmaTree(value: unknown): Json {
  const n = record(value);
  return optionalFields({
    nodeId: requiredString(n.id, "node ID"),
    name: n.name,
    type: requiredString(n.type, "node type"),
    text: n.characters,
    children: Array.isArray(n.children) ? n.children.map(figmaTree) : undefined,
  });
}
async function executeFigma(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (action === "read") {
    const raw = await runtime.call(
      input.nodeId ? "FIGMA_GET_FILE_NODES" : "FIGMA_GET_FILE_JSON",
      optionalFields({
        file_key: input.fileKey,
        ids: input.nodeId,
        depth: input.depth,
        ...(input.nodeId ? {} : { response_detail: "full" }),
      }),
    );
    if (raw.editorType && raw.editorType !== "figma")
      throw new CliError(
        "unsupported_combination",
        "This file is not Figma Design.",
      );
    const node = input.nodeId
      ? record(record(record(raw.nodes)[displayText(input.nodeId)]).document)
      : record(raw.document);
    return optionalFields({
      file: {
        fileKey: input.fileKey,
        name: requiredString(raw.name, "file name"),
        version: raw.version,
        lastModified: raw.lastModified,
        document: figmaTree(node),
      },
    });
  }
  if (action === "comments") {
    const raw = await runtime.call("FIGMA_GET_COMMENTS_IN_A_FILE", {
      file_key: input.fileKey,
      as_md: false,
    });
    if (!Array.isArray(raw.comments))
      throw new CliError(
        "incomplete_response",
        "The file comments are unavailable.",
      );
    return { fileKey: input.fileKey, comments: raw.comments.map(figmaComment) };
  }
  if (action === "comment") {
    const file = await runtime.call("FIGMA_GET_FILE_JSON", {
      file_key: input.fileKey,
      depth: 1,
      response_detail: "full",
    });
    if (file.editorType && file.editorType !== "figma")
      throw new CliError(
        "unsupported_combination",
        "Only Figma Design comments are supported.",
      );
    if (input.replyId) {
      const raw = await runtime.call("FIGMA_GET_COMMENTS_IN_A_FILE", {
        file_key: input.fileKey,
        as_md: false,
      });
      if (!Array.isArray(raw.comments))
        throw new CliError(
          "incomplete_response",
          "The comment list is unavailable.",
        );
      const match = raw.comments
        .map((x) => record(x))
        .filter((x) => x.id === input.replyId);
      if (match.length !== 1 || match[0]!.parent_id)
        throw new CliError(
          "invalid_input",
          "--reply must identify a root comment in this file.",
        );
    }
    const raw = await runtime.call(
      "FIGMA_ADD_A_COMMENT_TO_A_FILE",
      optionalFields({
        file_key: input.fileKey,
        message: input.content,
        comment_id: input.replyId,
      }),
      true,
    );
    return {
      result: {
        action: "commented",
        acknowledged: true,
        fileKey: input.fileKey,
        ...figmaComment(raw.data ?? raw),
      },
    };
  }
  const nodes = input.nodes as string[];
  const raw = await runtime.call("FIGMA_GET_FILE_NODES", {
    file_key: input.fileKey,
    ids: nodes,
    depth: 1,
  });
  if (raw.editorType && raw.editorType !== "figma")
    throw new CliError(
      "unsupported_combination",
      "Only Figma Design nodes can be exported.",
    );
  const found = record(raw.nodes);
  for (const id of nodes)
    if (!found[id] || record(record(found[id]).document).id !== id)
      throw new CliError(
        "not_found",
        "An export node does not exist or is inaccessible.",
      );
  const rendered = await runtime.call(
    "FIGMA_RENDER_IMAGES_OF_FILE_NODES",
    optionalFields({
      file_key: input.fileKey,
      ids: nodes.join(","),
      format: input.format,
      scale: input.scale,
      version: raw.version,
    }),
  );
  if (rendered.err)
    throw new CliError(
      "provider_error",
      "Figma could not render the selected nodes.",
    );
  const images = record(rendered.images);
  for (const id of nodes) connectorTransferURL(images[id]);
  if (nodes.length > 1) await mkdir(String(input.output), { mode: 0o700 });
  const files = [];
  for (const id of nodes) {
    const output =
      nodes.length === 1
        ? String(input.output)
        : path.join(
            String(input.output),
            `${id.replaceAll(":", "-")}.${displayText(input.format)}`,
          );
    files.push({
      nodeId: id,
      format: input.format,
      ...(await saveConnectorDownload(images[id], output, runtime.context)),
    });
  }
  return { fileKey: input.fileKey, files };
}
