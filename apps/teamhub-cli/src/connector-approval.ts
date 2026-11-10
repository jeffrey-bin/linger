import type { CommandApproval } from "./command-definition.js";

/**
 * How hosts approve each wrapped connector write. Reads are always
 * allowed. TeamHub holds the final external write of "confirm" commands for
 * the sponsor's confirmation card (it classifies every tool call itself), so
 * hosts allow them; "judge" commands go to the host's permission reviewer.
 */
export const connectorWriteApproval: Readonly<Record<string, CommandApproval>> =
  {
    "gmail send": "confirm",
    "gmail reply": "confirm",
    "gmail draft": "allow",
    "gmail canvas-draft": "allow",
    "gmail archive": "allow",
    "outlook send": "confirm",
    "outlook reply": "confirm",
    "outlook draft": "allow",
    "outlook archive": "allow",
    "slack send": "confirm",
    "slack react": "judge",
    "gcal create": "judge",
    "gcal update": "judge",
    "gcal cancel": "judge",
    "notion create": "confirm",
    "notion append": "confirm",
    "notion edit": "confirm",
    "gdrive mkdir": "allow",
    "gdrive upload": "judge",
    "figma comment": "judge",
    "github comment": "confirm",
    "github create-issue": "confirm",
    "image-gen": "judge",
    "video-gen": "judge",
  };
