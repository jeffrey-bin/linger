// Where a canvas is delivered. Adding a target only needs an entry here and
// the matching skills/builtin/canvas target guide for the Agent.

export interface CanvasTargetField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface CanvasTarget {
  id: string;
  label: string;
  fields: CanvasTargetField[];
}

export const canvasTargets: Record<string, CanvasTarget> = {
  gmail: {
    id: "gmail",
    label: "Gmail",
    fields: [
      { key: "to", label: "To", placeholder: "name@example.com" },
      { key: "cc", label: "Cc" },
      { key: "subject", label: "Subject" },
    ],
  },
};

/** Fields every canvas shares, whatever its target. */
export const canvasStatusKeys = ["status", "link", "external_id"] as const;
