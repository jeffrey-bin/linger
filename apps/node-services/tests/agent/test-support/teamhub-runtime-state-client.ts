import type {
  RuntimeConfigSnapshot,
  RuntimeContext,
  RuntimeSession,
  TeamHubRuntimeStateClient,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";

export const createTeamHubRuntimeStateClientFake = (
  overrides: Partial<TeamHubRuntimeStateClient> = {},
): TeamHubRuntimeStateClient => {
  const target = {
    epoch: "agent-epoch-test",
    startEpoch: async () => ({
      interrupted_run_ids: [],
      waiting_context_keys: [],
    }),
    ...overrides,
  } satisfies Partial<TeamHubRuntimeStateClient> as TeamHubRuntimeStateClient;
  return new Proxy(target, {
    get: (client, property, receiver) => {
      if (Reflect.has(client, property)) {
        return Reflect.get(client, property, receiver) as unknown;
      }
      return () => {
        throw Object.assign(
          new Error(
            `Unexpected TeamHub Runtime State call: ${String(property)}`,
          ),
          { code: "unexpected_runtime_state_call" },
        );
      };
    },
  });
};

export interface InMemoryTeamHubRuntimeState {
  readonly client: TeamHubRuntimeStateClient;
  putConfig(snapshot: RuntimeConfigSnapshot): void;
  putWorkState(
    ref: RuntimeContext["ref"],
    state: Awaited<ReturnType<TeamHubRuntimeStateClient["getWorkState"]>>,
  ): void;
}

export const createInMemoryTeamHubRuntimeState = (
  options: {
    readonly epoch?: string;
  } = {},
): InMemoryTeamHubRuntimeState => {
  const epoch = options.epoch ?? "agent-epoch-test";
  const currentConfigs = new Map<string, RuntimeConfigSnapshot>();
  const configRevisions = new Map<string, RuntimeConfigSnapshot>();
  const contexts = new Map<string, RuntimeContext>();
  const sessions = new Map<string, RuntimeSession>();
  const workStates = new Map<
    string,
    Awaited<ReturnType<TeamHubRuntimeStateClient["getWorkState"]>>
  >();

  const putConfig = (snapshot: RuntimeConfigSnapshot): void => {
    const owned = structuredClone(snapshot);
    currentConfigs.set(owned.agent_id, owned);
    configRevisions.set(configRevisionKey(owned), owned);
  };

  const client = createTeamHubRuntimeStateClientFake({
    epoch,
    async startEpoch() {
      return {
        interrupted_run_ids: [],
        waiting_context_keys: [...workStates.entries()]
          .filter(([, state]) => state.has_queued_runs)
          .map(([contextKey]) => contextKey),
      };
    },
    async getConfig(agentId, revision) {
      const snapshot = revision
        ? configRevisions.get(`${agentId}:${revision}`)
        : currentConfigs.get(agentId);
      if (!snapshot) throw notFound(`Runtime config ${agentId} was not found`);
      return structuredClone(snapshot);
    },
    async listContexts(agentId) {
      return [...contexts.values()]
        .filter((context) => !agentId || context.ref.agent_id === agentId)
        .map((context) => structuredClone(context));
    },
    async reconcileContexts() {
      return {
        examined_count: 0,
        existing_count: 0,
        created_count: 0,
        created_context_keys: [],
      };
    },
    async getContext(contextKey) {
      return structuredClone(requireContext(contexts, contextKey));
    },
    async ensureContext(body) {
      const contextKey = encodeWireContextRef(body.ref);
      const existing = contexts.get(contextKey);
      if (existing) {
        return { created: false, context: structuredClone(existing) };
      }
      const config = currentConfigs.get(body.ref.agent_id);
      if (!config) {
        throw notFound(`Runtime config ${body.ref.agent_id} was not found`);
      }
      const context: RuntimeContext = {
        ref: structuredClone(body.ref),
        context_key: contextKey,
        tenant_id: config.tenant_id,
        agent_actor_id: config.actor_id,
        ...(body.ref.kind === "meta"
          ? { room_kind: "collaboration" as const }
          : {}),
        target_residency: body.target_residency,
        state_revision: "1",
        next_input_sequence: "0",
      };
      contexts.set(contextKey, context);
      return { created: true, context: structuredClone(context) };
    },
    async setContextResidency(body) {
      const current = requireContext(contexts, body.context_key);
      requireRevision(current, body.expected_revision);
      const updated: RuntimeContext = {
        ...current,
        target_residency: body.target_residency,
        state_revision: increment(current.state_revision),
      };
      contexts.set(body.context_key, updated);
      return structuredClone(updated);
    },
    async deleteContext(body) {
      const current = requireContext(contexts, body.context_key);
      requireRevision(current, body.expected_revision);
      contexts.delete(body.context_key);
      sessions.delete(body.context_key);
      return { deleted: true };
    },
    async getSession(contextKey) {
      const session = sessions.get(contextKey);
      return session
        ? { available: true, session: structuredClone(session) }
        : { available: false };
    },
    async checkpointSession(body) {
      requireContext(contexts, body.context_key);
      const current = sessions.get(body.context_key);
      const expectedRevision = current?.revision ?? "0";
      if (body.checkpoint.expected_revision !== expectedRevision) {
        throw conflict("Runtime session revision conflict");
      }
      const stored: RuntimeSession = {
        ...structuredClone(body.checkpoint),
        revision: increment(expectedRevision),
        updated_at: new Date().toISOString(),
      };
      sessions.set(body.context_key, stored);
      return structuredClone(stored);
    },
    async getWorkState(contextKey) {
      requireContext(contexts, contextKey);
      return structuredClone(
        workStates.get(contextKey) ?? {
          has_queued_runs: false,
          has_pending_work: false,
        },
      );
    },
  });

  return {
    client,
    putConfig,
    putWorkState: (ref, state) => {
      workStates.set(encodeWireContextRef(ref), structuredClone(state));
    },
  };
};

const configRevisionKey = (snapshot: RuntimeConfigSnapshot): string =>
  `${snapshot.agent_id}:${snapshot.configuration_revision}`;

const encodeWireContextRef = (
  ref: RuntimeContext["ref"],
): RuntimeContext["context_key"] =>
  JSON.stringify(
    ref.kind === "meta"
      ? ["meta", ref.agent_id, "room", ref.room_id]
      : ref.kind === "alter_ego"
        ? ["alter_ego", ref.agent_id, ref.task_id]
        : ["document", ref.agent_id, ref.document_id],
  );

const requireContext = (
  contexts: ReadonlyMap<string, RuntimeContext>,
  contextKey: string,
): RuntimeContext => {
  const context = contexts.get(contextKey);
  if (!context) throw notFound(`Execution Context ${contextKey} was not found`);
  return context;
};

const requireRevision = (
  context: RuntimeContext,
  expectedRevision: string,
): void => {
  if (context.state_revision !== expectedRevision) {
    throw conflict("Execution Context revision conflict");
  }
};

const increment = (value: string): string => (BigInt(value) + 1n).toString();

const notFound = (message: string): Error & { readonly status: 404 } =>
  Object.assign(new Error(message), { status: 404 as const });

const conflict = (message: string): Error & { readonly status: 409 } =>
  Object.assign(new Error(message), { status: 409 as const });
