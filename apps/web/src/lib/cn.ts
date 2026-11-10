export type ClassValue = string | false | null | undefined;

/** Joins truthy class names. It does not merge conflicting Tailwind utilities. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
