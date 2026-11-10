import { expect, test } from "vitest";
import { validateInput } from "./validation.js";
test("accepts separate local model approval and explicit replan inputs", () => {
  const localModelsApproval = "a".repeat(64);
  expect(
    validateInput({ instance: "default", localModelsApproval }),
  ).toMatchObject({ localModelsApproval });
  expect(
    validateInput({ instance: "default", localModelsReplan: true }),
  ).toMatchObject({ localModelsReplan: true });
});
test.each([
  { localModelsApproval: "wrong" },
  { localModelsReplan: "yes" },
  { localModelsApproval: "a".repeat(64), localModelsReplan: true },
])("rejects invalid or combined local model authority %#", (options) => {
  expect(() => validateInput({ instance: "default", ...options })).toThrow();
});
test.each(["local-models", "codex", "claude", "pi"])(
  "accepts explicit setup choice %s",
  (setupChoice) => {
    expect(validateInput({ instance: "default", setupChoice })).toMatchObject({
      setupChoice,
    });
  },
);
test("rejects unknown choices and model approval for cloud runtime", () => {
  expect(() =>
    validateInput({ instance: "default", setupChoice: "auto" }),
  ).toThrow();
  expect(() =>
    validateInput({
      instance: "default",
      setupChoice: "claude",
      localModelsApproval: "a".repeat(64),
    }),
  ).toThrow();
});

test("accepts explicit GPU consent and revocation without adding defaults", () => {
  expect(validateInput({ instance: "default" })).not.toHaveProperty("shareGpu");
  expect(validateInput({ instance: "default", shareGpu: false })).toMatchObject(
    { shareGpu: false },
  );
  expect(validateInput({ instance: "default", shareGpu: true })).toMatchObject({
    shareGpu: true,
  });
});
test.each([
  { foundationModels: [] },
  { shareGpu: "yes" },
  { shareGpu: 1 },
  { shareGpu: true, preparation: "docker" },
])("rejects malformed selection or consent %#", (options) => {
  expect(() => validateInput({ instance: "default", ...options })).toThrow();
});
