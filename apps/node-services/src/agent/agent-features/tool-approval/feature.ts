import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import { CONTEXT_INSTRUCTIONS_FEATURE_ID } from "../context-instructions/feature.js";
import {
  TOOL_APPROVAL_PROTOCOL,
  TOOL_APPROVAL_PROTOCOL_COMPACT,
} from "../../prompt/tool-approval-protocol.js";

export const TOOL_APPROVAL_FEATURE_ID = "tool-approval";

/**
 * Runtime permission review for the Contexts that review Runtime permission
 * prompts. It matches only when TeamHub has a permission judge; a matched
 * feature also makes the Context's Runs declare the review, so without a
 * judge no prompt makes the round trip and the protocol is not taught.
 * Document Contexts never review.
 */
export const createToolApprovalFeature = (): FeatureDeclaration =>
  defineFeature({
    id: TOOL_APPROVAL_FEATURE_ID,
    match: {
      contextKinds: ["meta", "alter_ego"],
      capabilities: ["permissionReview"],
    },
    context: {
      ports: {
        contributeContextInstructions: {
          after: [CONTEXT_INSTRUCTIONS_FEATURE_ID],
        },
      },
      create: () => ({
        contributeContextInstructions: (_view, facts) =>
          facts.compactInstructions
            ? TOOL_APPROVAL_PROTOCOL_COMPACT
            : TOOL_APPROVAL_PROTOCOL,
      }),
    },
  });
