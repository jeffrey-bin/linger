import type {
  TeamHubAgentSkillRegistration,
  TeamHubAgentTemplate,
  TeamHubAgentTemplateSkillImport,
  TeamHubSkillManifest,
} from "@/features/teamhub/teamhub-types";

import { acceptsEmptySkillConfig } from "../members/agent-resource-catalog";

/** A template Skill this Workspace can neither bind nor copy. */
export interface UnavailableTemplateBinding {
  key: string;
  name: string;
}

export interface ResolvedAgentTemplateBindings {
  skillBindings: TeamHubAgentSkillRegistration[];
  /** Skills the publisher shared that are copied into the creator's own Skills on create. */
  importableSkills: TeamHubAgentSkillRegistration[];
  unavailableSkills: UnavailableTemplateBinding[];
}

/**
 * Maps template Skills onto what this Workspace can bind today: exact Skill
 * versions when they still exist, otherwise the newest active version. A Skill
 * the catalog cannot resolve is copied from the publisher when TeamHub reports
 * it importable. Anything else is reported instead of failing the whole
 * creation.
 */
export function resolveAgentTemplateBindings(
  template: Pick<TeamHubAgentTemplate, "skill_bindings">,
  catalog: {
    skills: readonly TeamHubSkillManifest[];
    imports?: readonly TeamHubAgentTemplateSkillImport[];
  },
): ResolvedAgentTemplateBindings {
  const bindableSkills = new Map<string, TeamHubSkillManifest[]>();
  for (const manifest of catalog.skills) {
    if (
      manifest.availability !== "active" ||
      !acceptsEmptySkillConfig(manifest.config_schema)
    ) {
      continue;
    }
    const versions = bindableSkills.get(manifest.skill_id) ?? [];
    versions.push(manifest);
    bindableSkills.set(manifest.skill_id, versions);
  }
  const importable = new Set(
    (catalog.imports ?? [])
      .filter((item) => item.status === "importable")
      .map((item) => item.source.skill_id),
  );

  const resolved: ResolvedAgentTemplateBindings = {
    importableSkills: [],
    skillBindings: [],
    unavailableSkills: [],
  };
  for (const binding of template.skill_bindings) {
    const versions = bindableSkills.get(binding.skill_id) ?? [];
    const manifest =
      versions.find(
        (candidate) => candidate.manifest_version === binding.manifest_version,
      ) ?? newestManifest(versions);
    if (manifest) {
      resolved.skillBindings.push({
        manifest_version: manifest.manifest_version,
        name: manifest.name,
        skill_id: manifest.skill_id,
      });
    } else if (importable.has(binding.skill_id)) {
      resolved.importableSkills.push({
        manifest_version: binding.manifest_version,
        name: binding.name,
        skill_id: binding.skill_id,
      });
    } else {
      resolved.unavailableSkills.push({
        key: binding.skill_id,
        name: binding.name,
      });
    }
  }
  return resolved;
}

/**
 * The Skills to bind once TeamHub has copied the importable ones: each copy
 * replaces nothing and is added once, and a reference that could not be copied
 * after all is simply left out, as it would have been skipped before.
 */
export function withImportedTemplateSkills(
  skillBindings: readonly TeamHubAgentSkillRegistration[],
  imports: readonly TeamHubAgentTemplateSkillImport[],
): TeamHubAgentSkillRegistration[] {
  const result = [...skillBindings];
  const seen = new Set(result.map((binding) => binding.skill_id));
  for (const item of imports) {
    if (
      item.status !== "imported" ||
      !item.skill ||
      seen.has(item.skill.skill_id)
    ) {
      continue;
    }
    seen.add(item.skill.skill_id);
    result.push({
      manifest_version: item.skill.manifest_version,
      name: item.skill.name,
      skill_id: item.skill.skill_id,
    });
  }
  return result;
}

function newestManifest<T extends { manifest_version: string }>(
  manifests: readonly T[],
) {
  return manifests.reduce<T | undefined>(
    (newest, candidate) =>
      !newest ||
      compareManifestVersions(
        candidate.manifest_version,
        newest.manifest_version,
      ) > 0
        ? candidate
        : newest,
    undefined,
  );
}

function compareManifestVersions(left: string, right: string) {
  const parse = (value: string) =>
    value
      .split(/[-+]/, 1)[0]!
      .split(".")
      .map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}
