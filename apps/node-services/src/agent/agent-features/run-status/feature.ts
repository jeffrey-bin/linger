import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import { projectRunEventToRuntimeStatus } from "./runtime-status-projection.js";

export const RUN_STATUS_FEATURE_ID = "run-status";

/**
 * Projects provider Run events to RuntimeStatusUpdate execution and status. A pure mapping,
 * no external dependencies; composed with the Context feature and invoked per event by the Shell execution loop.
 */
export const createRunStatusFeature = (): FeatureDeclaration =>
  defineFeature({
    id: RUN_STATUS_FEATURE_ID,
    context: {
      ports: { onRunEvent: {} },
      create: () => ({
        onRunEvent: (_view, event) => projectRunEventToRuntimeStatus(event),
      }),
    },
  });
