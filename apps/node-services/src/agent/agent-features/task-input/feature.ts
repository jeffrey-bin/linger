import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import type { ContextRuntimeBackendActivation } from "../../executor/activation.js";

export const TASK_INPUT_FEATURE_ID = "task-input";

/**
 * Narrow assembly dependency bound once by the composition root: the existing
 * CLI capability on the active Runtime backend activation. Pass the backend's
 * `prepareRunInput` already bound to its receiver; a backend without the
 * capability does not contribute this feature instead of falling back.
 */
export interface TaskInputFeatureDeps {
  readonly prepareRunInput: NonNullable<
    ContextRuntimeBackendActivation["prepareRunInput"]
  >;
}

/**
 * Before a new Run starts, the backend's CLI configuration capability during activation ensures the Agent CLI credentials
 * are installed and attaches this Run's CLI context (run_id and scope) to the input; this port binds that
 * existing interface into the composition chain. Credential refresh is still owned by the backend implementation and does not move with this feature
 * migration. When the backend does not provide the capability, the composition root explicitly leaves it disabled.
 */
export const createTaskInputFeature = (
  deps: TaskInputFeatureDeps,
): FeatureDeclaration => {
  if (typeof deps?.prepareRunInput !== "function")
    throw new Error("task-input feature requires prepareRunInput");
  const prepare = deps.prepareRunInput;
  return defineFeature({
    id: TASK_INPUT_FEATURE_ID,
    run: {
      ports: { prepareRunInput: {} },
      create: () => ({
        prepareRunInput: (_view, input, signal) => prepare(input, signal),
      }),
    },
  });
};
