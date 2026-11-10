import { open } from "node:fs/promises";
import path from "node:path";
import { decodeInlineEscapes } from "./content-segments.js";
import type {
  CommandArguments,
  CommandInputReader,
  CommandOption,
  NormalizedCommandInput,
} from "./command-definition.js";
import { CliError } from "./errors.js";

const byteLimit = 5 * 1024 * 1024;
export function option(
  args: CommandArguments,
  name: string,
): string | undefined {
  const found = args.options[name];
  if (found && found.length > 1)
    throw new CliError("usage", `Use ${name} at most once.`);
  return found?.[0];
}
export function values(
  args: CommandArguments,
  name: string,
): readonly string[] {
  return args.options[name] ?? [];
}
export function requiredOption(args: CommandArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new CliError("usage", `Provide ${name}.`);
  return value;
}
export function assertPositionals(
  args: CommandArguments,
  min: number,
  max = min,
): void {
  if (args.positionals.length < min || args.positionals.length > max)
    throw new CliError(
      "usage",
      "Provide the positional arguments shown in this command's help.",
    );
}
export function parseArguments(
  args: readonly string[],
  definitions: Readonly<Record<string, CommandOption>>,
): CommandArguments {
  const options: Record<string, string[]> = Object.create(null);
  const positionals: string[] = [];
  const ordered: { name: string; value: string }[] = [];
  let literal = false;
  let stdin = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (literal || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    const definition = Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    if (!definition)
      throw new CliError(
        "usage",
        `Unknown option: ${name}. Run this command with --help.`,
      );
    if (options[name] && !definition.repeatable)
      throw new CliError("usage", `Use ${name} at most once.`);
    if (definition.boolean && separator >= 0)
      throw new CliError("usage", `${name} does not take a value.`);
    const value = definition.boolean
      ? "true"
      : separator >= 0
        ? token.slice(separator + 1)
        : args[++index];
    if (value === undefined)
      throw new CliError("usage", `Provide a value after ${name}.`);
    if (value.includes("\0"))
      throw new CliError("invalid_input", `${name} cannot contain NUL.`);
    if (value === "-" && (name === "--file" || name.endsWith("-file"))) {
      if (stdin)
        throw new CliError("usage", "Only one input source may read stdin.");
      stdin = true;
    }
    (options[name] ??= []).push(value);
    ordered.push({ name, value });
  }
  return { options, positionals, ordered };
}

export function parseJsonValue(text: string): unknown {
  if (Buffer.byteLength(text) > byteLimit)
    throw new CliError("invalid_input", "JSON input must not exceed 5 MiB.");
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new CliError("invalid_input", "Provide one valid JSON value.");
  }
  // JSON.parse discards duplicate properties. Inspect the validated token stream
  // separately so escaped aliases cannot silently replace an earlier value.
  const stack: { keys?: Set<string>; expectingKey: boolean }[] = [];
  const tokens = text.matchAll(
    /"(?:\\.|[^"\\])*"|[{}[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu,
  );
  for (const match of tokens) {
    const token = match[0];
    if (token === "{" || token === "[") {
      if (stack.length >= 100)
        throw new CliError(
          "invalid_input",
          "JSON nesting must not exceed 100 levels.",
        );
      stack.push({
        ...(token === "{" ? { keys: new Set<string>() } : {}),
        expectingKey: token === "{",
      });
    } else if (token === "}" || token === "]") stack.pop();
    else {
      const frame = stack.at(-1);
      if (!frame?.keys) continue;
      if (token === ",") frame.expectingKey = true;
      else if (token === ":") frame.expectingKey = false;
      else if (frame.expectingKey && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (frame.keys.has(key))
          throw new CliError(
            "invalid_input",
            "JSON objects cannot contain duplicate keys.",
          );
        frame.keys.add(key);
      }
    }
  }
  return result;
}

export function createInputReader(dependencies: {
  cwd: string;
  readInput?: (source: string) => Promise<string>;
}): CommandInputReader {
  let stdinRead = false;
  const text = async (source: string): Promise<string> => {
    if (!source || source.includes("\0"))
      throw new CliError(
        "invalid_input",
        "Provide a valid input file path or - for stdin.",
      );
    if (source === "-") {
      if (stdinRead)
        throw new CliError("usage", "Only one input source may read stdin.");
      stdinRead = true;
    }
    const filename =
      source === "-" ? "-" : path.resolve(dependencies.cwd, source);
    try {
      if (dependencies.readInput) {
        const result = await dependencies.readInput(filename);
        if (Buffer.byteLength(result) > byteLimit)
          throw new CliError("invalid_input", "Input must not exceed 5 MiB.");
        return result;
      }
      let handle;
      if (filename !== "-") {
        handle = await open(filename, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > byteLimit)
            throw new CliError(
              "invalid_input",
              "Input must be a regular file of at most 5 MiB.",
            );
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      const stream = handle ? handle.createReadStream() : process.stdin;
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const part of stream) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += chunk.length;
          if (size > byteLimit)
            throw new CliError("invalid_input", "Input must not exceed 5 MiB.");
          chunks.push(chunk);
        }
      } finally {
        if (handle) {
          stream.destroy();
          await handle.close();
        }
      }
      try {
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(Buffer.concat(chunks));
      } catch {
        throw new CliError(
          "invalid_input",
          "Input must contain valid UTF-8 text.",
        );
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        "invalid_input",
        "Could not read the input file or stdin.",
      );
    }
  };
  return {
    cwd: dependencies.cwd,
    text,
    json: async (source) => parseJsonValue(await text(source)),
  };
}

export async function bodySource(
  args: CommandArguments,
  reader: CommandInputReader,
  required = true,
  [inlineFlag, fileFlag]: readonly [string, string] = ["--content", "--file"],
): Promise<string | undefined> {
  const content = option(args, inlineFlag);
  const file = option(args, fileFlag);
  if (content !== undefined && file !== undefined)
    throw new CliError(
      "usage",
      `Choose ${inlineFlag} or ${fileFlag}, not both.`,
    );
  if (content !== undefined) return content;
  if (file !== undefined) return reader.text(file);
  if (required)
    throw new CliError("usage", `Provide ${inlineFlag} or ${fileFlag}.`);
  return undefined;
}
/** Markdown bodies decode \n, \t and \\ in inline --content outside code; files stay literal. */
export async function markdownBodySource(
  args: CommandArguments,
  reader: CommandInputReader,
  required = true,
  flags: readonly [string, string] = ["--content", "--file"],
): Promise<string | undefined> {
  const body = await bodySource(args, reader, required, flags);
  return body !== undefined && option(args, flags[0]) !== undefined
    ? decodeInlineEscapes(body)
    : body;
}
export async function jsonSource(
  args: CommandArguments,
  reader: CommandInputReader,
  inlineFlag: string,
  fileFlag: string,
): Promise<unknown> {
  const inline = option(args, inlineFlag);
  const file = option(args, fileFlag);
  if (inline !== undefined && file !== undefined)
    throw new CliError(
      "usage",
      `Choose ${inlineFlag} or ${fileFlag}, not both.`,
    );
  return inline !== undefined
    ? parseJsonValue(inline)
    : file !== undefined
      ? reader.json(file)
      : undefined;
}
export function targetFromFlags(
  args: CommandArguments,
  allowedTypes: readonly string[],
): Pick<NormalizedCommandInput, "target"> {
  const found = allowedTypes.flatMap((type) => {
    const id = option(args, `--${type}`);
    return id === undefined ? [] : [{ type, id }];
  });
  if (found.length > 1)
    throw new CliError(
      "usage",
      `Choose only one target: ${allowedTypes.map((type) => `--${type}`).join(", ")}.`,
    );
  const target = found[0];
  if (!target) return {};
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(target.id) ||
    (target.type !== "inbox" &&
      /^(?:room|thread|task|meta|taskmeta):/u.test(target.id))
  )
    throw new CliError(
      "usage",
      `Provide a bare resource ID after --${target.type}.`,
    );
  // A target names a resource inside the configured caller Context; it never
  // replaces that Context.
  return { target };
}
