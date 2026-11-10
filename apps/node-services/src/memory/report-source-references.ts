import type { WeeklyCollection } from "./types.js";

export interface ReportSourceReference {
  resource: string;
  sourceRef: string;
  title: string;
}

export function weeklySourceCatalog(
  collection: WeeklyCollection,
): ReportSourceReference[] {
  return collection.existingMemoryFiles.map((file) => {
    const date = file.path.split("/").at(-1)!.replace(/\.md$/u, "");
    const daily = file.path.includes("/timeline/daily/");
    return {
      sourceRef: `${daily ? "daily" : "previous_week"}_${date}`,
      resource: `memory://${daily ? "timeline/daily" : "timeline/weekly"}/${date}.md`,
      title: `${daily ? "Daily" : "Previous Weekly baseline"} ${date}`,
    };
  });
}
