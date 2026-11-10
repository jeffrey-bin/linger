import type { ModelCall } from "../src/runtime-model-call.js";

const unused = () => Promise.reject(new Error("unused model call"));

/** A ModelCall whose methods fail unless the test overrides them. */
export const stubModelCall = (
  overrides: Partial<ModelCall> = {},
): ModelCall => ({
  call: unused,
  text: unused,
  workspace: unused,
  chain: unused,
  ...overrides,
});
