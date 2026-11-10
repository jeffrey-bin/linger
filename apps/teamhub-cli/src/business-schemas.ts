interface Schema {
  [key: string]: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
}
const string = { type: "string" };
function rename(schema: Schema | undefined, from: string, to: string): void {
  if (!schema?.properties?.[from]) return;
  schema.properties[to] = schema.properties[from];
  delete schema.properties[from];
  if (schema.required)
    schema.required = schema.required.map((name: string) =>
      name === from ? to : name,
    );
}
function visit(value: Schema, callback: (item: Schema) => void): void {
  callback(value);
  for (const child of Object.values(value))
    if (Array.isArray(child))
      child.forEach((item) => {
        if (item && typeof item === "object") visit(item as Schema, callback);
      });
    else if (child && typeof child === "object")
      visit(child as Schema, callback);
}
export function publicBusinessSchemas(
  tool: string,
  original: Schema,
): { input_schema: object; output_schema: object } {
  const input = structuredClone(
    original.input_schema ?? { type: "object" },
  ) as Schema;
  const output = structuredClone(
    original.output_schema ?? { type: "object" },
  ) as Schema;
  if (["list_connected_apps", "search_app_tools"].includes(tool)) {
    rename(input, "appKey", "name");
    visit(output, (item) => rename(item, "appKey", "name"));
  }
  if (["search_knowledge", "read_knowledge"].includes(tool)) {
    output.properties ??= {};
    output.properties.schemaVersion = { type: "integer", const: 2 };
    output.required = [
      ...new Set([...(output.required ?? []), "schemaVersion"]),
    ];
    if (tool === "search_knowledge")
      rename(
        output.properties.items?.items as Schema | undefined,
        "id",
        "evidenceId",
      );
    visit(output, (item) => {
      rename(
        item.properties?.directory?.items as Schema | undefined,
        "id",
        "sectionId",
      );
      rename(
        item.properties?.sections?.items as Schema | undefined,
        "id",
        "sectionId",
      );
    });
    if (tool === "read_knowledge") {
      delete input.properties?.sectionRequests;
      input.properties = {
        ...input.properties,
        sectionIds: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: string,
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 200000,
          description: "Requires exactly one section ID.",
        },
      };
      input.required = ["evidenceId", "sectionIds"];
    }
  }
  return { input_schema: input, output_schema: output };
}
