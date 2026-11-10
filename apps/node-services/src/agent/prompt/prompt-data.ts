const PROMPT_DATA_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "\\u0026",
  "<": "\\u003c",
  ">": "\\u003e",
});

export const serializePromptData = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[&<>]/g,
    (character) => PROMPT_DATA_ESCAPES[character] ?? character,
  );
