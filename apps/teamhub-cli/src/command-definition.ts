import type { TeamHubHttpClient } from "./http-client.js";
import type { CliTiming } from "./timing.js";

export interface CommandOption {
  readonly description: string;
  readonly boolean?: boolean;
  readonly repeatable?: boolean;
}

export interface CommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, readonly string[]>>;
  readonly ordered: readonly { name: string; value: string }[];
}

export interface CommandInputReader {
  readonly cwd: string;
  text(source: string): Promise<string>;
  json(source: string): Promise<unknown>;
}

export interface CommandTarget {
  readonly type: string;
  readonly id: string;
}

export interface NormalizedCommandInput {
  readonly input: Record<string, unknown>;
  readonly target?: CommandTarget;
  readonly scope?: { readonly kind: string; readonly id: string };
  readonly toolName?: string;
}

export interface CommandExecutionContext {
  readonly client: TeamHubHttpClient;
  readonly cwd: string;
  readonly stateRoot: string;
  /** Present for write commands; TeamHub deduplicates the write by it. */
  readonly operationId?: string;
  readonly timing?: CliTiming;
  readonly fetch?: typeof fetch;
  readonly target?: CommandTarget;
}

/**
 * How hosts approve a call. allow: run it. confirm: run it; TeamHub itself
 * asks the sponsor through a confirmation card before a write that needs
 * approval (connector writes, Agent changes). judge: the host's permission
 * reviewer decides.
 */
export type CommandApproval = "allow" | "confirm" | "judge";

/** CLI syntax and presentation; TeamHub remains the business authority. */
export interface CommandDefinition {
  readonly command: readonly string[];
  readonly toolName: string;
  readonly description: string;
  readonly readOnly: boolean;
  /** Defaults to allow, except judge for the generic app tool call. */
  readonly approval?: CommandApproval;
  readonly usage: readonly string[];
  readonly options: Readonly<Record<string, CommandOption>>;
  readonly arguments?: readonly string[];
  readonly examples?: readonly string[];
  readonly notes?: readonly string[];
  readonly outputDescription?: string;
  readonly operationId?: boolean;
  /** False for writes a connected application performs: TeamHub cannot
   * deduplicate them, so an unknown outcome is never retried. */
  readonly allowUnknownReplay?: boolean;
  readonly schema?: boolean;
  readonly fileRoute?: string;
  readonly defaultTarget?: "room" | "room-or-task" | "task";
  /** Fails with this message, before any request, in a configured Task Context. */
  readonly unavailableInTask?: string;
  readonly inputSchema?: object;
  readonly outputSchema?: object;
  normalize(
    args: CommandArguments,
    reader: CommandInputReader,
  ): Promise<NormalizedCommandInput>;
  prepare?(
    input: Record<string, unknown>,
    context: CommandExecutionContext,
  ): Promise<Record<string, unknown>>;
  execute?(
    input: Record<string, unknown>,
    context: CommandExecutionContext,
  ): Promise<Record<string, unknown>>;
  project?(result: Record<string, unknown>): Record<string, unknown>;
  render?(
    result: Record<string, unknown>,
    input?: Record<string, unknown>,
  ): string;
}

// A Task's AlterEgo reports through its final reply. TeamHub
// refuses these commands too; refusing first names the alternative.
export const reportInFinalReply =
  "In a Task you don't send messages or create Documents, Rooms, or Tasks. Put what the Meta needs in your final reply and write files under ./playground/<task-id>/.";
