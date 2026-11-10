/** "2 hours ago" for a past instant, used for when a Computer was last seen. */
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size)
      return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
