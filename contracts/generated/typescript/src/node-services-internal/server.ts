/**
 * Route ownership for the Node Services internal contract: Agent management
 * on the shared Node Services port and the Document Runtime on its own port.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

export const AGENT_MANAGEMENT_ROUTE_CAPABILITIES = {
  localComputers: true,
} as const;

export interface AgentManagementHandlers {
  readAgentDebugContextHistory(context: Context): Promise<Response> | Response;
  judgeProactiveEvent(context: Context): Promise<Response> | Response;
  callModel(context: Context): Promise<Response> | Response;
  removeLocalComputer(context: Context): Promise<Response> | Response;
  scanLocalComputerSkills(context: Context): Promise<Response> | Response;
  getLocalComputerBrowserConnection(
    context: Context,
  ): Promise<Response> | Response;
  configureLocalComputerBrowserConnection(
    context: Context,
  ): Promise<Response> | Response;
  disconnectLocalComputerBrowserConnection(
    context: Context,
  ): Promise<Response> | Response;
  notifyAgentRegistrationChanged(
    context: Context,
  ): Promise<Response> | Response;
  cancelAgentRun?(context: Context): Promise<Response> | Response;
  methodNotAllowed?(
    context: Context,
    allow: "DELETE" | "GET" | "GET, PUT" | "GET, PUT, DELETE" | "POST",
  ): Response;
}

export function registerAgentManagementRoutes(
  app: Hono,
  handlers: AgentManagementHandlers,
): void {
  const readAgentDebugContextHistoryPath = "/v1/agent-debug/history:read";
  const proactiveEventJudgePath = "/v1/proactive-events:judge";
  const modelCallsPath = "/v1/model-calls";
  const localComputersPath =
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers";
  const localComputerPath = `${localComputersPath}/:computerId`;
  const localSkillScansPath = `${localComputerPath}/skill-scans`;
  const localBrowserConnectionPath = `${localComputerPath}/browser-connection`;
  const registrationChangesPath = "/v1/agents/:agentId/registration-changes";
  const cancelRunPath = "/v1/agent-runs/:runId/cancel";

  app.post(
    readAgentDebugContextHistoryPath,
    handlers.readAgentDebugContextHistory,
  );
  app.post(proactiveEventJudgePath, handlers.judgeProactiveEvent);
  app.post(modelCallsPath, handlers.callModel);
  app.delete(localComputerPath, handlers.removeLocalComputer);
  app.post(localSkillScansPath, handlers.scanLocalComputerSkills);
  app.get(
    localBrowserConnectionPath,
    handlers.getLocalComputerBrowserConnection,
  );
  app.put(
    localBrowserConnectionPath,
    handlers.configureLocalComputerBrowserConnection,
  );
  app.delete(
    localBrowserConnectionPath,
    handlers.disconnectLocalComputerBrowserConnection,
  );
  app.post(registrationChangesPath, handlers.notifyAgentRegistrationChanged);
  if (handlers.cancelAgentRun) {
    app.post(cancelRunPath, handlers.cancelAgentRun);
  }

  if (handlers.methodNotAllowed) {
    app.all(readAgentDebugContextHistoryPath, (context) =>
      handlers.methodNotAllowed!(context, "POST"),
    );
    app.all(proactiveEventJudgePath, (context) =>
      handlers.methodNotAllowed!(context, "POST"),
    );
    app.all(modelCallsPath, (context) =>
      handlers.methodNotAllowed!(context, "POST"),
    );
    app.all(localComputerPath, (context) =>
      handlers.methodNotAllowed!(context, "DELETE"),
    );
    app.all(localSkillScansPath, (context) =>
      handlers.methodNotAllowed!(context, "POST"),
    );
    app.all(localBrowserConnectionPath, (context) =>
      handlers.methodNotAllowed!(context, "GET, PUT, DELETE"),
    );
    app.all(registrationChangesPath, (context) =>
      handlers.methodNotAllowed!(context, "POST"),
    );
    if (handlers.cancelAgentRun) {
      app.all(cancelRunPath, (context) =>
        handlers.methodNotAllowed!(context, "POST"),
      );
    }
  }
}

export const DOCUMENT_RUNTIME_AUDIENCE = "document-runtime" as const;
export const INTERNAL_HTTP_BODY_LIMIT_BYTES = 48 * 1024 * 1024;

export interface DocumentRuntimeServicePrincipal {
  subject: string;
}

export type DocumentRuntimeAuthenticator = (input: {
  audience: typeof DOCUMENT_RUNTIME_AUDIENCE;
  token: string;
}) =>
  | DocumentRuntimeServicePrincipal
  | null
  | Promise<DocumentRuntimeServicePrincipal | null>;

export interface DocumentRuntimeHandlers {
  importDocument(context: Context): Promise<Response> | Response;
  exportDocument(context: Context): Promise<Response> | Response;
  applyDocumentChange(context: Context): Promise<Response> | Response;
  disconnectDocumentConnections(context: Context): Promise<Response> | Response;
  methodNotAllowed?(context: Context): Promise<Response> | Response;
}

export interface DocumentRuntimeRouteOptions {
  authenticate: DocumentRuntimeAuthenticator;
}

type Handler = (context: Context) => Promise<Response> | Response;

function errorResponse(
  context: Context,
  status: 401 | 413,
  code: "payload_too_large" | "unauthenticated",
  message: string,
): Response {
  return context.json({ code, message, retryable: false }, status);
}

function readBearerToken(context: Context): string | null {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function authenticateInternalRequest(
  options: DocumentRuntimeRouteOptions,
): MiddlewareHandler {
  return async (context, next) => {
    const token = readBearerToken(context);
    if (!token) {
      return errorResponse(
        context,
        401,
        "unauthenticated",
        "missing service bearer credential",
      );
    }
    const principal = await options.authenticate({
      audience: DOCUMENT_RUNTIME_AUDIENCE,
      token,
    });
    if (!principal) {
      return errorResponse(
        context,
        401,
        "unauthenticated",
        "invalid service bearer credential or audience",
      );
    }
    await next();
  };
}

const internalBodyLimit = bodyLimit({
  maxSize: INTERNAL_HTTP_BODY_LIMIT_BYTES,
  onError: (context) =>
    errorResponse(
      context,
      413,
      "payload_too_large",
      "internal request body exceeds 48 MiB",
    ),
});

export function registerDocumentRuntimeRoutes(
  app: Hono,
  handlers: DocumentRuntimeHandlers,
  options: DocumentRuntimeRouteOptions,
): void {
  const routes: Array<[string, Handler]> = [
    ["/internal/v1/documents/import", handlers.importDocument],
    ["/internal/v1/documents/export", handlers.exportDocument],
    ["/internal/v1/documents/:documentId/apply", handlers.applyDocumentChange],
    [
      "/internal/v1/documents/:documentId/disconnect",
      handlers.disconnectDocumentConnections,
    ],
  ];

  const authenticate = authenticateInternalRequest(options);

  for (const [path, handler] of routes) {
    app.post(path, authenticate, internalBodyLimit, handler);
    if (handlers.methodNotAllowed) {
      app.all(path, handlers.methodNotAllowed);
    }
  }
}

export function createDocumentRuntimeContractApp(
  handlers: DocumentRuntimeHandlers,
  options: DocumentRuntimeRouteOptions,
): Hono {
  const app = new Hono();
  registerDocumentRuntimeRoutes(app, handlers, options);
  return app;
}
