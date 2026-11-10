import type { CommandApproval } from "./command-definition.js";
import { commandDefinitions } from "./domain-commands.js";

/**
 * Machine-readable command metadata written next to the built CLI, not a CLI
 * command, so Agents never read it. Hosts use it to decide which TeamHub
 * commands skip their own permission review; it grants nothing, and TeamHub
 * still authorizes every request.
 */
export interface CommandManifest {
  readonly schema_version: 2;
  readonly commands: readonly {
    readonly command: readonly string[];
    readonly approval: CommandApproval;
  }[];
}

export function commandManifest(): CommandManifest {
  return {
    schema_version: 2,
    commands: commandDefinitions.map((definition) => ({
      command: definition.command,
      approval:
        definition.approval ??
        (definition.toolName === "execute_app_tool" ? "judge" : "allow"),
    })),
  };
}
