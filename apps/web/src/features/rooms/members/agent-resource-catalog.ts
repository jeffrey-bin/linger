import Ajv from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import draft6MetaSchema from "ajv/dist/refs/json-schema-draft-06.json";
import AjvDraft04 from "ajv-draft-04";

import type { TeamHubSkillManifest } from "@/features/teamhub/teamhub-types";

interface ManifestPage<T> {
  items: T[];
  page: { has_more: boolean; next_cursor?: string };
}

const draft7 = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
draft7.addMetaSchema(draft6MetaSchema);
const draft4 = new AjvDraft04({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
const draft2019 = new Ajv2019({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
const draft2020 = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

export function acceptsEmptySkillConfig(
  schema: TeamHubSkillManifest["config_schema"],
) {
  try {
    const selection = selectSchemaDialect(schema.$schema);
    if (!selection) return false;
    const normalizedSchema = selection.canonicalDialect
      ? { ...schema, $schema: selection.canonicalDialect }
      : schema;
    return selection.validator.validate(normalizedSchema, {}) === true;
  } catch {
    return false;
  }
}

function selectSchemaDialect(dialect: unknown) {
  if (dialect === undefined) {
    return { canonicalDialect: undefined, validator: draft2020 };
  }
  if (typeof dialect !== "string") return undefined;

  const withoutEmptyFragment = dialect.endsWith("#")
    ? dialect.slice(0, -1)
    : dialect;
  const identifier = withoutEmptyFragment.replace(/^https?:\/\//, "");
  switch (identifier) {
    case "json-schema.org/schema":
    case "json-schema.org/draft/2020-12/schema":
      return {
        canonicalDialect: "https://json-schema.org/draft/2020-12/schema",
        validator: draft2020,
      };
    case "json-schema.org/draft/2019-09/schema":
      return {
        canonicalDialect: "https://json-schema.org/draft/2019-09/schema",
        validator: draft2019,
      };
    case "json-schema.org/draft-07/schema":
      return {
        canonicalDialect: "http://json-schema.org/draft-07/schema#",
        validator: draft7,
      };
    case "json-schema.org/draft-06/schema":
      return {
        canonicalDialect: "http://json-schema.org/draft-06/schema#",
        validator: draft7,
      };
    case "json-schema.org/draft-04/schema":
      return {
        canonicalDialect: "http://json-schema.org/draft-04/schema#",
        validator: draft4,
      };
    default:
      return undefined;
  }
}

export async function loadAllManifestPages<T>(
  loadPage: (page: {
    cursor?: string;
    limit: number;
  }) => Promise<ManifestPage<T>>,
) {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const current = await loadPage({ cursor, limit: 100 });
    items.push(...current.items);
    if (!current.page.has_more) return items;

    const nextCursor = current.page.next_cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("TeamHub returned an invalid catalog cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return items;
}
