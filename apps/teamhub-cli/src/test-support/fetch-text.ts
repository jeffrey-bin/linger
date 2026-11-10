/** URL text of a fetch() input captured by a test double. */
export const requestUrlText = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/** String body of a fetch() init captured by a test double. */
export const requestBodyText = (body: RequestInit["body"]): string => {
  if (typeof body !== "string") {
    throw new TypeError("Expected a string request body");
  }
  return body;
};
