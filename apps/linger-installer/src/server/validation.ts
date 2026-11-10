import type { components } from "@linger/wire-contracts/linger-installer/types";
type Input = components["schemas"]["InstallationInput"];
type Model = components["schemas"]["ModelConfiguration"];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid input");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Invalid input");
}
export function instanceName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(value))
    throw new Error("Invalid instance");
  return value;
}
export function validateModel(value: unknown): Model {
  const model = object(value);
  fields(model, ["baseUrl", "model", "apiKey"]);
  if (
    typeof model.baseUrl !== "string" ||
    typeof model.model !== "string" ||
    !/^[-a-zA-Z0-9_./:]{1,256}$/.test(model.model) ||
    typeof model.apiKey !== "string" ||
    !model.apiKey.trim() ||
    model.apiKey.length > 16384 ||
    /[\r\n\0]/.test(model.apiKey)
  )
    throw new Error("Invalid model");
  const url = new URL(model.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Invalid model URL");
  return { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey };
}
export function validateLocalModelsAuthority(
  value: unknown,
): components["schemas"]["LocalModelsAuthority"] {
  const authority = object(value);
  fields(authority, ["localModelsApproval", "localModelsReplan"]);
  if (
    authority.localModelsApproval !== undefined &&
    (typeof authority.localModelsApproval !== "string" ||
      !/^[a-f0-9]{64}$/.test(authority.localModelsApproval))
  )
    throw new Error("Invalid local model approval");
  if (
    authority.localModelsReplan !== undefined &&
    typeof authority.localModelsReplan !== "boolean"
  )
    throw new Error("Invalid local model review");
  if (
    authority.localModelsApproval !== undefined &&
    authority.localModelsReplan !== undefined
  )
    throw new Error("Review and approval require separate requests");
  return authority as components["schemas"]["LocalModelsAuthority"];
}
export function validateInput(value: unknown): Input {
  const input = object(value);
  fields(input, [
    "localModelsApproval",
    "localModelsReplan",
    "setupChoice",
    "shareGpu",
    "instance",
    "port",
    "email",
    "password",
    "computerName",
    "model",
    "runtimeModel",
    "preparation",
  ]);
  instanceName(input.instance);
  if (input.shareGpu !== undefined && typeof input.shareGpu !== "boolean")
    throw new Error("Invalid GPU sharing consent");
  if (
    input.setupChoice !== undefined &&
    !["local-models", "codex", "claude", "pi"].includes(
      String(input.setupChoice),
    )
  )
    throw new Error("Invalid setup choice");
  if (
    input.setupChoice &&
    input.setupChoice !== "local-models" &&
    (input.localModelsApproval || input.localModelsReplan)
  )
    throw new Error("Local model approval requires local models");
  if (
    input.localModelsApproval !== undefined &&
    (typeof input.localModelsApproval !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.localModelsApproval))
  )
    throw new Error("Invalid local model approval");
  if (
    input.localModelsReplan !== undefined &&
    typeof input.localModelsReplan !== "boolean"
  )
    throw new Error("Invalid local model review");
  if (input.localModelsApproval && input.localModelsReplan)
    throw new Error("Review and approval require separate requests");
  if (
    input.preparation !== undefined &&
    !["codex", "claude", "pi"].includes(String(input.preparation))
  )
    throw new Error("Invalid dependency");
  if (
    input.preparation &&
    Object.keys(input).some(
      (key) => !["instance", "preparation", "setupChoice"].includes(key),
    )
  )
    throw new Error("Dependency jobs cannot change instance configuration");
  if (
    input.port !== undefined &&
    (!Number.isSafeInteger(input.port) ||
      Number(input.port) < 1024 ||
      Number(input.port) > 65535)
  )
    throw new Error("Invalid port");
  if (
    input.email !== undefined &&
    (typeof input.email !== "string" ||
      input.email.length > 320 ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(input.email))
  )
    throw new Error("Invalid email");
  if (
    input.password !== undefined &&
    (typeof input.password !== "string" ||
      input.password.length < 8 ||
      input.password.length > 256 ||
      /\p{Cc}/u.test(input.password))
  )
    throw new Error("Invalid password");
  if (
    input.computerName !== undefined &&
    (typeof input.computerName !== "string" ||
      !input.computerName.trim() ||
      input.computerName.length > 120 ||
      /[\r\n\0]/.test(input.computerName))
  )
    throw new Error("Invalid computer name");
  if (input.model !== undefined) validateModel(input.model);
  if (input.runtimeModel !== undefined) validateModel(input.runtimeModel);
  return input as Input;
}
