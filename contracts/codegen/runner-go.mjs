// Renders the Runner Gateway envelope schema as one dependency-free Go
// package, so the Daemon and TeamHub decode the same message shapes the
// Agent Service validates. Shapes the schema leaves open (oneOf unions, opaque
// objects, JSON values) stay json.RawMessage; their owners decode them.

export const RUNNER_GO_MODULE =
  "github.com/simplexai-labs/linger/contracts-go/runnergateway";

const INITIALISMS = new Map(
  [
    "id",
    "ids",
    "url",
    "pid",
    "mcp",
    "cli",
    "json",
    "http",
    "api",
    "sha256",
    "ms",
  ].map((word) => [
    word,
    word === "ids" ? "IDs" : word === "ms" ? "Ms" : word.toUpperCase(),
  ]),
);

export function renderRunnerGoModule() {
  return `module ${RUNNER_GO_MODULE}\n\ngo 1.24.0\n`;
}

export function renderRunnerGo(schema) {
  const defs = schema.$defs;
  const types = new Map();
  const order = [];
  const nameFor = (ref) => ref.replace("#/$defs/", "");

  const resolve = (node) => (node?.$ref ? defs[nameFor(node.$ref)] : node);

  // Merges own, allOf and conditional properties; only top-level required
  // keys and every allOf part's required keys stay required.
  const collect = (
    node,
    into = { properties: new Map(), required: new Set() },
  ) => {
    const target = resolve(node);
    for (const part of target.allOf ?? []) collect(part, into);
    for (const [key, value] of Object.entries(target.properties ?? {})) {
      const existing = into.properties.get(key);
      // Conditional branches declare bare `{}` placeholders.
      if (!existing || Object.keys(existing).length === 0)
        into.properties.set(key, value);
    }
    for (const key of target.required ?? []) into.required.add(key);
    for (const branch of [target.then, target.else]) {
      for (const [key, value] of Object.entries(branch?.properties ?? {})) {
        if (!into.properties.has(key)) into.properties.set(key, value);
      }
    }
    return into;
  };

  const isStruct = (node) => {
    const target = resolve(node);
    return (
      target !== undefined &&
      target.oneOf === undefined &&
      target.anyOf === undefined &&
      (target.properties !== undefined || target.allOf !== undefined)
    );
  };

  const scalar = (node) => {
    const target = resolve(node);
    if (target.const !== undefined || target.enum !== undefined) {
      const values = target.const !== undefined ? [target.const] : target.enum;
      if (values.every((value) => typeof value === "string")) return "string";
      if (values.every((value) => typeof value === "boolean")) return "bool";
    }
    if (target.type === "string") return "string";
    if (target.type === "boolean") return "bool";
    if (target.type === "integer")
      return target.minimum !== undefined && target.minimum >= 0
        ? "uint64"
        : "int64";
    if (target.type === "number") return "float64";
    return undefined;
  };

  const goType = (node, owner, field) => {
    if (node.$ref) {
      const name = nameFor(node.$ref);
      if (isStruct(node)) {
        declare(name, defs[name]);
        return name;
      }
      const target = defs[name];
      if (target.type === "array")
        return `[]${goType(target.items, name, "Item")}`;
      return scalar(node) ?? "json.RawMessage";
    }
    if (node.type === "array")
      return `[]${goType(node.items, owner, field + "Item")}`;
    // A keyed map of structured values, such as release archives by target.
    if (
      node.type === "object" &&
      node.properties === undefined &&
      typeof node.additionalProperties === "object" &&
      isStruct(node.additionalProperties)
    )
      return `map[string]${goType(node.additionalProperties, owner, field + "Value")}`;
    if (isStruct(node)) {
      const name = owner + field;
      declare(name, node);
      return name;
    }
    return scalar(node) ?? "json.RawMessage";
  };

  const declare = (name, node) => {
    if (types.has(name)) return;
    types.set(name, undefined);
    const { properties, required } = collect(node);
    const fields = [];
    for (const [key, value] of properties) {
      const field = goField(key);
      let type = goType(value, name, field);
      const optional = !required.has(key);
      const pointer =
        optional &&
        (type === "bool" ||
          type === "uint64" ||
          type === "int64" ||
          type === "float64" ||
          (!type.startsWith("[]") &&
            !type.startsWith("map[") &&
            type !== "string" &&
            type !== "json.RawMessage"));
      if (pointer) type = `*${type}`;
      const fixed = resolve(value).const;
      fields.push({
        key,
        field,
        type,
        tag: `json:"${key}${optional ? ",omitempty" : ""}"`,
        required: !optional,
        fixed: typeof fixed === "string" ? fixed : undefined,
      });
    }
    types.set(name, { name, fields });
    order.push(name);
  };

  for (const name of Object.keys(defs))
    if (isStruct({ $ref: `#/$defs/${name}` })) declare(name, defs[name]);

  const messages = (envelope) =>
    defs[envelope].oneOf.map(({ $ref }) => {
      const name = nameFor($ref);
      const { properties } = collect(defs[name]);
      const match = ["target", "kind", "state", "outcome"]
        .filter((key) => properties.get(key)?.const !== undefined)
        .map((key) => [key, properties.get(key).const]);
      return { name, type: properties.get("type").const, match };
    });
  const agentMessages = messages("AgentToDaemonEnvelope");
  const daemonMessages = messages("DaemonToAgentEnvelope");

  const constant = (prefix, value) =>
    prefix + goField(value.replace(/\./g, "_"));
  const typeConstants = new Map();
  const discriminatorConstants = new Map();
  for (const message of [...agentMessages, ...daemonMessages]) {
    typeConstants.set(constant("Type", message.type), message.type);
    for (const [key, value] of message.match)
      discriminatorConstants.set(constant(goField(key), value), value);
  }

  const lines = [
    "// Code generated from contracts/runner-gateway/envelope.schema.json. DO NOT EDIT.",
    "",
    "// Package runnergateway holds the Runner Gateway message shapes the Daemon",
    "// exchanges with the Agent Service.",
    "package runnergateway",
    "",
    'import (\n\t"bytes"\n\t"encoding/json"\n\t"fmt"\n)',
    "",
    "// ProtocolVersion is the only Runner Gateway protocol this release speaks.",
    `const ProtocolVersion = ${JSON.stringify(defs.ProtocolVersion.const)}`,
    "",
    "// Runner capabilities name host features; everything else is part of the protocol.",
    "const (",
    ...defs.RunnerCapability.enum.map(
      (value) =>
        `\t${constant("Capability", value)} = ${JSON.stringify(value)}`,
    ),
    ")",
    "",
    "// Message types.",
    "const (",
    ...[...typeConstants].map(
      ([key, value]) => `\t${key} = ${JSON.stringify(value)}`,
    ),
    ")",
    "",
    "// Message discriminators within one type.",
    "const (",
    ...[...discriminatorConstants].map(
      ([key, value]) => `\t${key} = ${JSON.stringify(value)}`,
    ),
    ")",
    "",
    "// Message names one frame shape by its type and the constant fields that",
    "// tell it apart from the other shapes of that type.",
    "type Message struct {",
    "\tName  string",
    "\tType  string",
    "\tMatch map[string]string",
    "}",
    "",
    "// AgentToDaemonMessages lists every frame the Agent Service sends.",
    "var AgentToDaemonMessages = []Message{",
    ...agentMessages.map(messageLiteral),
    "}",
    "",
    "// DaemonToAgentMessages lists every frame the Daemon sends.",
    "var DaemonToAgentMessages = []Message{",
    ...daemonMessages.map(messageLiteral),
    "}",
    "",
  ];
  for (const name of order) {
    const type = types.get(name);
    lines.push(`// ${name} mirrors the ${name} schema shape.`);
    lines.push(`type ${name} struct {`);
    for (const field of type.fields)
      lines.push(`\t${field.field} ${field.type} \`${field.tag}\``);
    lines.push("}", "");
    const requiredKeys = type.fields
      .filter((field) => field.required)
      .map((field) => field.key);
    const fixedFields = type.fields.filter(
      (field) => field.fixed !== undefined,
    );
    lines.push(
      `// FixedFields lists the keys whose value the schema fixes for a ${name}.`,
      `func (${name}) FixedFields() map[string]string { return ${
        fixedFields.length === 0
          ? "nil"
          : `map[string]string{${fixedFields
              .map(
                (field) =>
                  `${JSON.stringify(field.key)}: ${JSON.stringify(field.fixed)}`,
              )
              .join(", ")}}`
      } }`,
      "",
      `// RequiredFields lists the keys a ${name} must carry.`,
      `func (${name}) RequiredFields() []string { return ${
        requiredKeys.length === 0
          ? "nil"
          : `[]string{${requiredKeys.map((key) => JSON.stringify(key)).join(", ")}}`
      } }`,
      "",
    );
  }
  lines.push(
    "// Shape is a generated message shape.",
    "type Shape interface {",
    "\tRequiredFields() []string",
    "\tFixedFields() map[string]string",
    "}",
    "",
    "// Decode reads data into value, rejecting unknown and missing top-level keys",
    "// and top-level values other than the ones the schema fixes.",
    "func Decode(data []byte, value Shape) error {",
    "\tvar keys map[string]json.RawMessage",
    "\tif err := json.Unmarshal(data, &keys); err != nil {",
    "\t\treturn err",
    "\t}",
    "\tfor _, key := range value.RequiredFields() {",
    '\t\tif raw, ok := keys[key]; !ok || string(raw) == "null" {',
    '\t\t\treturn fmt.Errorf("%T requires %s", value, key)',
    "\t\t}",
    "\t}",
    "\tfor key, want := range value.FixedFields() {",
    "\t\tvar got string",
    "\t\tif raw, ok := keys[key]; ok && (json.Unmarshal(raw, &got) != nil || got != want) {",
    '\t\t\treturn fmt.Errorf("%T requires %s %q", value, key, want)',
    "\t\t}",
    "\t}",
    "\tdecoder := json.NewDecoder(bytes.NewReader(data))",
    "\tdecoder.DisallowUnknownFields()",
    "\treturn decoder.Decode(value)",
    "}",
    "",
    "// Discriminate names the shape of a frame among messages.",
    "func Discriminate(data []byte, messages []Message) (Message, error) {",
    "\tvar head map[string]json.RawMessage",
    "\tif err := json.Unmarshal(data, &head); err != nil {",
    "\t\treturn Message{}, err",
    "\t}",
    "\tvar frameType string",
    '\tif err := json.Unmarshal(head["type"], &frameType); err != nil {',
    '\t\treturn Message{}, fmt.Errorf("frame type: %w", err)',
    "\t}",
    "\tfor _, message := range messages {",
    "\t\tif message.Type != frameType {",
    "\t\t\tcontinue",
    "\t\t}",
    "\t\tmatched := true",
    "\t\tfor key, want := range message.Match {",
    "\t\t\tvar value string",
    "\t\t\tif json.Unmarshal(head[key], &value) != nil || value != want {",
    "\t\t\t\tmatched = false",
    "\t\t\t}",
    "\t\t}",
    "\t\tif matched {",
    "\t\t\treturn message, nil",
    "\t\t}",
    "\t}",
    '\treturn Message{}, fmt.Errorf("unknown Runner Gateway frame type %q", frameType)',
    "}",
    "",
  );
  return lines.join("\n");
}

function messageLiteral(message) {
  const match =
    message.match.length === 0
      ? "nil"
      : `map[string]string{${message.match
          .map(
            ([key, value]) =>
              `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
          )
          .join(", ")}}`;
  return `\t{Name: ${JSON.stringify(message.name)}, Type: ${JSON.stringify(message.type)}, Match: ${match}},`;
}

function goField(key) {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (INITIALISMS.has(lower)) return INITIALISMS.get(lower);
      return word[0].toUpperCase() + word.slice(1);
    })
    .join("");
}
