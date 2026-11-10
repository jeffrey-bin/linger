/** Display text for an untyped JSON field: structured values serialize as JSON. */
export const displayText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
};
