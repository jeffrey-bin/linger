import { createHash } from "node:crypto";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
export interface DocumentFileSnapshot {
  filePath: string;
  content: Uint8Array;
  sha256: string;
  sizeBytes: number;
}
export class DocumentImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const playgroundFilePathSchema = {
  parse(value: string): string {
    if (
      !value.startsWith("./playground/") ||
      value.length > 1037 ||
      value.includes("\\") ||
      Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value
        .slice(13)
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw invalid();
    return value;
  },
};

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const invalid = () =>
  new DocumentImageError(
    "invalid_document_images",
    "Invalid, changed, unsupported or oversized document image source. Keep image files in the current Playground; do not split a document just because of image bytes.",
  );

type Tree = ReturnType<typeof processor.parse>;
interface ImageNode {
  type: string;
  url: string;
  alt?: string | null;
  title?: string | null;
}
function parse(snapshot: DocumentFileSnapshot) {
  if (snapshot.content.length > MAX_BYTES) throw invalid();
  return processor.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(snapshot.content),
  );
}
// Resolve reference-style images before changing URLs. Preserve ordinary links and code.
function images(tree: Tree): ImageNode[] {
  const definitions = new Map<string, { url: string; title?: string | null }>();
  for (const node of tree.children)
    if (node.type === "definition")
      definitions.set(node.identifier.toUpperCase(), node);
  const result: ImageNode[] = [];
  const stack: unknown[] = [tree];
  while (stack.length) {
    const node = stack.pop() as {
      type: string;
      children?: unknown[];
      identifier?: string;
      url?: string;
    };
    if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier!.toUpperCase());
      if (definition)
        Object.assign(node, {
          type: "image",
          url: definition.url,
          title: definition.title,
        });
    }
    if (node.type === "image") result.push(node as ImageNode);
    if (result.length > 4096) throw invalid();
    if (node.children) for (const child of node.children) stack.push(child);
  }
  return result;
}
function imageType(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString()))
    return "image/gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw invalid();
}
function decode(uri: string): { bytes: Buffer; mediaType: string } {
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(
      uri,
    );
  if (!match) throw invalid();
  const bytes = Buffer.from(match[2]!, "base64");
  const mediaType = match[1]!.toLowerCase();
  if (
    !bytes.length ||
    bytes.toString("base64") !== match[2] ||
    imageType(bytes) !== mediaType
  )
    throw invalid();
  return { bytes, mediaType };
}
export function prepareDocumentSource(snapshot: DocumentFileSnapshot) {
  const source = playgroundFilePathSchema.parse(
    snapshot.filePath.startsWith("./playground/")
      ? snapshot.filePath
      : "./playground/" + snapshot.filePath,
  );
  const tree = parse(snapshot);
  let imageCount = 0;
  const sourceHash = hash(snapshot.content);
  for (const node of images(tree)) {
    if (!/^data:/iu.test(node.url)) continue;
    const { bytes } = decode(node.url);
    node.url = `document-image:${hash(bytes)}?source=${encodeURIComponent(source)}&sha256=${sourceHash}`;
    imageCount++;
  }
  // Definitions are no longer needed for converted images. Do not return large payloads to the model.
  tree.children = tree.children.filter(
    (node) => node.type !== "definition" || !/^data:/iu.test(node.url),
  );
  const markdown = processor.stringify(tree);
  const textBytes = Buffer.byteLength(markdown);
  if (textBytes > MAX_TEXT_BYTES)
    throw new DocumentImageError(
      "document_text_too_large",
      "Text after image extraction exceeds 1 MiB. Organize or split the text, not the images.",
    );
  return {
    markdown,
    source_file: source,
    source_bytes: snapshot.content.length,
    text_bytes: textBytes,
    image_count: imageCount,
  };
}

// Callers install immutable image files before replacing the editable body.
export function extractDocumentImages(snapshot: DocumentFileSnapshot) {
  const tree = parse(snapshot);
  const files = new Map<string, Uint8Array>();
  const prefix = `${Array.from(path.posix.basename(snapshot.filePath)).slice(0, 20).join("")}.image-`;
  for (const node of images(tree)) {
    if (!/^data:/iu.test(node.url)) continue;
    const { bytes, mediaType } = decode(node.url);
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.slice(6);
    const filename = `${prefix}${hash(bytes)}.${extension}`;
    files.set(filename, bytes);
    node.url = filename;
  }
  if (!files.size) return { content: snapshot.content, files };
  tree.children = tree.children.filter(
    (node) => node.type !== "definition" || !/^data:/iu.test(node.url),
  );
  const content = Buffer.from(processor.stringify(tree));
  if (content.length > MAX_TEXT_BYTES)
    throw new DocumentImageError(
      "document_text_too_large",
      "Text after image extraction exceeds 1 MiB; organize the text, not the images.",
    );
  return { content, files };
}

export async function bundleDocumentImages<T extends DocumentFileSnapshot>(
  snapshot: T,
  readFile: (
    filePath: string,
    signal: AbortSignal,
  ) => Promise<DocumentFileSnapshot>,
  signal: AbortSignal,
): Promise<T> {
  if (!/\.(?:md|markdown)$/iu.test(snapshot.filePath)) return snapshot;
  const tree = parse(snapshot);
  const nodes = images(tree);
  const sources = new Map<string, Promise<Map<string, string>>>();
  const locals = new Map<string, Promise<string>>();
  let changed = false;
  let totalBytes = snapshot.content.length;
  let expandedBytes = snapshot.content.length;
  function replaceImage(node: ImageNode, uri: string) {
    expandedBytes += Buffer.byteLength(uri);
    if (expandedBytes > MAX_BYTES) throw invalid();
    node.url = uri;
    changed = true;
  }
  async function read(filePath: string) {
    signal.throwIfAborted();
    const file = await readFile(
      playgroundFilePathSchema.parse(filePath),
      signal,
    );
    totalBytes += file.content.length;
    if (totalBytes > MAX_BYTES) throw invalid();
    return file;
  }
  await concurrentImages(nodes, async (node) => {
    signal.throwIfAborted();
    if (node.url.startsWith("/") || /^file:/iu.test(node.url)) throw invalid();
    if (/^data:/iu.test(node.url)) decode(node.url);
    if (/^document-image:/iu.test(node.url)) {
      const match =
        /^document-image:([a-f0-9]{64})\?source=([^&]+)&sha256=([a-f0-9]{64})$/u.exec(
          node.url,
        );
      if (!match) throw invalid();
      const sourcePath = playgroundFilePathSchema.parse(
        decodeURIComponent(match[2]!),
      );
      const key = sourcePath + ":" + match[3];
      let available = sources.get(key);
      if (!available) {
        available = (async () => {
          const source = await read(sourcePath);
          if (hash(source.content) !== match[3]) throw invalid();
          const found = new Map<string, string>();
          for (const image of images(parse(source)))
            if (/^data:/iu.test(image.url)) {
              const decoded = decode(image.url);
              found.set(hash(decoded.bytes), image.url);
            }
          return found;
        })();
        sources.set(key, available);
      }
      const uri = (await available).get(match[1]!);
      if (!uri) throw invalid();
      replaceImage(node, uri);
    } else if (!/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(node.url)) {
      const local = decodeURIComponent(node.url);
      if (
        local.includes("\\") ||
        local.includes("\0") ||
        local.includes("?") ||
        local.includes("#")
      )
        throw invalid();
      const filePath =
        "./" +
        path.posix.normalize(
          path.posix.join(
            path.posix.dirname(
              snapshot.filePath.startsWith("./playground/")
                ? snapshot.filePath
                : "./playground/" + snapshot.filePath,
            ),
            local,
          ),
        );
      const safePath = playgroundFilePathSchema.parse(filePath);
      let uri = locals.get(safePath);
      if (!uri) {
        uri = read(safePath).then(
          (image) =>
            `data:${imageType(image.content)};base64,${Buffer.from(image.content).toString("base64")}`,
        );
        locals.set(safePath, uri);
      }
      replaceImage(node, await uri);
    }
  });
  if (!changed) return snapshot;
  const content = Buffer.from(processor.stringify(tree));
  if (content.length > MAX_BYTES) throw invalid();
  return {
    ...snapshot,
    content,
    sizeBytes: content.length,
    sha256: hash(content),
  };
}

async function concurrentImages<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++]!;
        try {
          await work(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}

export { inferFileMetadata } from "./media-type.js";
export { matchesMediaContent } from "./media.js";
