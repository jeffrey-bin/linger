import type { AgentType } from "../../executor/types.js";
import type { ExecutionContextRef } from "../../executor/context-ref.js";

export interface ReplyRhythmSettings {
  readonly activationRate: number;
  readonly enabled: boolean;
  readonly maxMessageCount: number;
  readonly minMessageCount: number;
  readonly version: string;
}

export interface ReplyRhythmInput {
  readonly agentId: string;
  readonly agentType: AgentType;
  readonly contextRef: ExecutionContextRef;
  readonly turnKey: string;
  readonly settings?: ReplyRhythmSettings;
}

export type ReplyRhythmDecision =
  | { readonly state: "not_offered" }
  | {
      readonly state: "offered";
      readonly maxMessageCount: number;
      readonly minMessageCount: number;
      readonly version: string;
    };
