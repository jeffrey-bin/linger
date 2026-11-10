import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import { contributeInboxNotificationContext } from "./notification-context.js";

export const NOTIFICATION_CONTEXT_FEATURE_ID = "notification-context";

/**
 * Contributes the notification collaboration reminder. No external dependencies; first render and canonical rebuild
 * receive the composed contributeNotificationContext injected into the renderer by the host, so both see
 * the same input facts.
 */
export const createNotificationContextFeature = (): FeatureDeclaration =>
  defineFeature({
    id: NOTIFICATION_CONTEXT_FEATURE_ID,
    context: {
      ports: { contributeNotificationContext: {} },
      create: () => ({
        contributeNotificationContext: (_view, input) =>
          contributeInboxNotificationContext(input),
      }),
    },
  });
