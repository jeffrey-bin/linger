import { parseActorReferences as parse } from "./content-segments.js";
import { CliError } from "./errors.js";

export function parseActorReferences(
  content: string,
  style: "message" | "comment" = "message",
): Record<string, unknown>[] {
  try {
    return parse(content, style);
  } catch {
    throw new CliError(
      "usage_error",
      "Actor reference must contain a valid Actor ID.",
    );
  }
}
