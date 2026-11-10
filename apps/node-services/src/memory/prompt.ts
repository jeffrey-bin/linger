import { weeklySourceCatalog } from "./report-source-references.js";
import { weeklyReportSchema } from "./weekly-report.js";
import fs from "node:fs/promises";
import path from "node:path";
import { previousDate } from "./date.js";
import { writeJsonFile, writeTextFile } from "./fs-utils.js";
import { weeklyUpdateDir, type CliOptions } from "./options.js";
import { promptRoot } from "./paths.js";
import {
  memorySyncPolicy,
  type MemoryPathRule,
  type MemorySyncTask,
} from "./sync-policy.js";
import type { AnotherMeSubject, WeeklyCollection } from "./types.js";

export interface PromptArtifacts {
  promptPath: string;
  schemaPath: string;
  outputPath: string;
}

export function renderSyncPolicyBoundary(task: MemorySyncTask): string {
  const policy = memorySyncPolicy(task);
  const formatRules = (rules: readonly MemoryPathRule[]) =>
    rules.length > 0
      ? rules
          .map(
            (rule) =>
              `- \`${rule.path}\` — ${rule.capabilities.join(", ")}${
                rule.scope ? ` (${rule.scope})` : ""
              }`,
          )
          .join("\n")
      : "- none";
  return [
    "## Executable Sync Boundary",
    "",
    `This ${task} output is enforced by the runtime policy below; do not emit paths outside it.`,
    "",
    "Allowed input paths and capabilities:",
    formatRules(policy.inputs),
    "",
    "Allowed output paths and capabilities:",
    formatRules(policy.outputs),
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

export function weeklyPromptPath(
  options: Pick<CliOptions, "memoryRoot"> & { weekStart: string },
  memorySubjectKey: string,
) {
  return path.join(
    weeklyUpdateDir(options, memorySubjectKey),
    "weekly.prompt.md",
  );
}

export function weeklySchemaPath(
  options: Pick<CliOptions, "memoryRoot"> & { weekStart: string },
  memorySubjectKey: string,
) {
  return path.join(
    weeklyUpdateDir(options, memorySubjectKey),
    "weekly.schema.json",
  );
}

export function weeklyLlmOutputPath(
  options: Pick<CliOptions, "memoryRoot"> & { weekStart: string },
  memorySubjectKey: string,
) {
  return path.join(
    weeklyUpdateDir(options, memorySubjectKey),
    "weekly.llm-output.json",
  );
}

export async function writeWeeklyPrompt(
  options: Pick<CliOptions, "memoryRoot"> & { weekStart: string },
  collection: WeeklyCollection,
  subject: Pick<
    AnotherMeSubject,
    "representedHumanActorId" | "representedHumanDisplayName"
  >,
): Promise<PromptArtifacts> {
  collection = {
    ...collection,
    existingMemoryFiles: collection.existingMemoryFiles.filter(
      ({ path }) =>
        path.includes("/timeline/daily/") || path.includes("/timeline/weekly/"),
    ),
  };
  const promptPath = weeklyPromptPath(options, collection.memorySubjectKey);
  const schemaPath = weeklySchemaPath(options, collection.memorySubjectKey);
  const outputPath = weeklyLlmOutputPath(options, collection.memorySubjectKey);
  await writeTextFile(
    promptPath,
    await renderWeeklyPrompt(collection, subject),
  );
  await writeJsonFile(
    schemaPath,
    weeklyReportSchema(
      weeklySourceCatalog(collection).map((source) => source.sourceRef),
    ),
  );
  return { promptPath, schemaPath, outputPath };
}

async function renderWeeklyPrompt(
  collection: WeeklyCollection,
  subject: Pick<
    AnotherMeSubject,
    "representedHumanActorId" | "representedHumanDisplayName"
  >,
): Promise<string> {
  const prompt = (
    await renderTemplate(
      ["sync", "weekly", "weekly-user.md"],
      collection.weekStart,
      {
        schemaVersion: collection.schemaVersion,
        weekStart: collection.weekStart,
        weekEnd: collection.weekEnd,
        timeZone: collection.timeZone,
        generatedAt: collection.generatedAt,
        source: collection.source,
        memorySubjectKey: collection.memorySubjectKey,
        representedHuman: {
          actorId: subject.representedHumanActorId,
          displayName: subject.representedHumanDisplayName,
        },
        existingMemoryFiles: collection.existingMemoryFiles.map(
          (file, index) => ({
            source_ref: weeklySourceCatalog(collection)[index]!.sourceRef,
            role: file.path.includes("/timeline/daily/")
              ? "current_week_evidence"
              : "previous_week_baseline_only",
            content: file.content,
          }),
        ),
      },
    )
  ).replaceAll("{{weekStart}}", collection.weekStart);
  return `${prompt}\n\n${renderSyncPolicyBoundary("weekly")}\n`;
}

async function renderTemplate(
  segments: string[],
  date: string,
  collection: unknown,
): Promise<string> {
  const template = await fs.readFile(
    path.join(promptRoot, ...segments),
    "utf8",
  );
  return template
    .replaceAll("{{date}}", date)
    .replaceAll("{{historyDate}}", previousDate(date))
    .replaceAll("{{collectionJson}}", JSON.stringify(collection, null, 2));
}
