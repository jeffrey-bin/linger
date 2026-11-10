import postgres, { type Sql } from "postgres";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import {
  cleanupPartialRoomDocumentE2ERoom,
  cleanupRoomDocumentE2EFixture,
} from "./realtime-e2e-cleanup.js";

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- needs an implicit index signature
export type RoomDocumentE2EFixture = {
  document_id: string;
  room_id: string;
  tenant_id: string;
};

interface LoginIdentity {
  email: string;
  password: string;
}

// The deployment's only Human; browser sessions all sign in as this Account.
const alice: LoginIdentity = {
  email: "alice@example.com",
  password: "teamhub-dev-alice",
};

export class RealTeamHubFixtureManager {
  readonly #artifactRoot: string;
  readonly #baseUrl: string;
  readonly #sql: Sql;
  #counter = 0;

  constructor(input: {
    artifactRoot: string;
    baseUrl: string;
    databaseUrl: string;
  }) {
    this.#artifactRoot = input.artifactRoot;
    this.#baseUrl = input.baseUrl;
    this.#sql = postgres(input.databaseUrl, { max: 1 });
  }

  async create(): Promise<RoomDocumentE2EFixture> {
    const suffix = this.#nextSuffix();
    const cookie = await this.#login(alice);
    const room = await this.#createRoom(cookie, suffix);
    try {
      const document = await this.#json<{ id: string }>(
        `/v0/rooms/${room.id}/documents`,
        {
          body: {},
          cookie,
          idempotencyKey: `e2e-document-${suffix}`,
          method: "POST",
          status: 201,
        },
      );
      if (process.env.VERIFY_CONNECTOR_CLI === "1") {
        await this.#prepareConnectorCLI(cookie, room.id);
      }
      return {
        document_id: document.id,
        room_id: room.id,
        tenant_id: "tenant_acme",
      };
    } catch (error) {
      try {
        await cleanupPartialRoomDocumentE2ERoom(
          { artifactRoot: this.#artifactRoot, sql: this.#sql },
          room.id,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Room Document E2E fixture creation and rollback both failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  async seedStartupDirectory(): Promise<void> {
    // Reuse TeamHub's owned SQL regression data: 7 visible Agents, 61 bindings.
    // This prepares only the disposable database; browser reads remain real.
    const sql = await readFile(
      new URL(
        "../../../teamhub/tests/integration/testdata/agent_skill_directory.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await this.#sql.unsafe(sql).simple();
  }

  async #prepareConnectorCLI(cookie: string, roomID: string): Promise<void> {
    const filename = process.env.CONNECTOR_CLI_PROOF_CONFIG;
    if (!filename)
      throw new Error("Connector CLI proof needs a private configuration path");
    const rows = await this.#sql<
      { agent_management_id: string }[]
    >`SELECT agent_management_id FROM agent_registrations WHERE actor_id='actor_acme_official' AND tenant_id='tenant_acme' AND status='active'`;
    const agentID = rows[0]?.agent_management_id;
    if (!agentID) throw new Error("Disposable Agent fixture is missing");
    await this.#json(`/v0/rooms/${roomID}/members/actor_acme_official`, {
      body: { role: "member" },
      cookie,
      method: "PUT",
      status: 200,
    });
    const token = `th_agent_${randomBytes(32).toString("base64url")}`;
    const id = `credential_connector_${randomBytes(12).toString("hex")}`;
    const hash = createHash("sha256").update(token).digest();
    await this
      .#sql`INSERT INTO agent_access_credentials(id,token_hash,tenant_id,agent_actor_id,agent_management_id,label,expires_at) VALUES(${id},${hash},'tenant_acme','actor_acme_official',${agentID},'Disposable connector browser proof',clock_timestamp()+interval '1 hour')`;
    await writeFile(filename + ".token", token, { mode: 0o600, flag: "wx" });
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        default_profile: "proof",
        profiles: {
          proof: {
            url: this.#baseUrl,
            token_file: filename + ".token",
            tenant_id: "tenant_acme",
            agent_id: agentID,
            scope: { kind: "room", id: roomID },
          },
        },
      }),
      { mode: 0o600, flag: "wx" },
    );
  }

  // Make a Routine's current occurrence job due now, as TeamHub's reminder
  // integration tests do, instead of waiting for its wall-clock minute. The
  // worker still locks next_run_at and advances the schedule itself.
  async fireRoutineOccurrence(routineId: string): Promise<void> {
    const released = await this.#sql`
      UPDATE river_job job
      SET state='available', scheduled_at=clock_timestamp()
      FROM room_reminders reminder
      WHERE job.kind='reminder.fire' AND job.state='scheduled'
        AND job.args->>'reminder_id'=${routineId}
        AND reminder.id=${routineId}
        AND (job.args->>'due_at')::timestamptz=reminder.next_run_at
      RETURNING job.id`;
    if (released.length !== 1) {
      throw new Error(
        `Expected one scheduled occurrence for Routine ${routineId}, found ${released.length}`,
      );
    }
  }

  // Report Alice's Computer online with a ready Codex Runtime, so her local
  // Agents, @official among them, can join a Room. Only an Agent can be added
  // to a Room in the one-Human Space, and the harness runs no Daemon.
  async connectOwnerComputer(): Promise<void> {
    await this.#sql`
      INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,
        runtime_inventory,workspace_grants,runtime_diagnostics,last_seen_at)
      SELECT r.computer_id,'E2E Computer','online',r.tenant_id,r.created_by_actor_id,'["codex"]',
        jsonb_build_array(jsonb_build_object('grant_id',r.workspace_grant_id,'tenant_id',r.tenant_id,
          'scope','owner','label','Workspace','mode','workspace-write')),
        jsonb_build_array(jsonb_build_object('type','codex','status','ready','protocol','app-server',
          'checked_at',to_jsonb(now()),'models',jsonb_build_array(jsonb_build_object('id',r.runtime_model,
          'label','Model','allowed_reasoning_effort',jsonb_build_array('low','medium','high','xhigh'),
          'default_reasoning_effort','high')))),
        now()
      FROM agent_registrations r WHERE r.actor_id='actor_acme_official'
      ON CONFLICT (computer_id) DO UPDATE SET status='online',last_seen_at=now()`;
  }

  async cleanup(fixture: RoomDocumentE2EFixture): Promise<void> {
    await this.#sql`DELETE FROM local_computers WHERE computer_id=(
      SELECT computer_id FROM agent_registrations WHERE actor_id='actor_acme_official')`;
    await cleanupRoomDocumentE2EFixture(
      { artifactRoot: this.#artifactRoot, sql: this.#sql },
      fixture,
    );
  }

  async probePartialCleanup(): Promise<void> {
    const suffix = this.#nextSuffix();
    const cookie = await this.#login(alice);
    const room = await this.#createRoom(cookie, suffix);
    await cleanupPartialRoomDocumentE2ERoom(
      { artifactRoot: this.#artifactRoot, sql: this.#sql },
      room.id,
    );
  }

  close(): Promise<void> {
    return this.#sql.end();
  }

  #createRoom(cookie: string, suffix: string): Promise<{ id: string }> {
    return this.#json("/v0/tenants/tenant_acme/rooms", {
      body: {
        description: "Room Document browser acceptance",
        name: `E2E Room ${suffix}`,
      },
      cookie,
      idempotencyKey: `e2e-room-${suffix}`,
      method: "POST",
      status: 201,
    });
  }

  #nextSuffix(): string {
    this.#counter += 1;
    return `${Date.now().toString(36)}-${this.#counter}`;
  }

  async #login(identity: LoginIdentity): Promise<string> {
    const response = await fetchTeamHub(
      `${this.#baseUrl}/v0/auth/login`,
      {
        body: JSON.stringify({
          identifier: identity.email,
          password: identity.password,
        }),
        headers: {
          connection: "close",
          "content-type": "application/json",
        },
        method: "POST",
      },
      "POST /v0/auth/login",
    );
    await assertStatus(response, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    if (cookie === "") {
      throw new Error("Real TeamHub login did not return a session cookie");
    }
    return cookie;
  }

  #json<T = Record<string, unknown>>(
    path: string,
    options: Omit<RequestOptions, "body"> & { body?: unknown },
  ): Promise<T> {
    const { body, ...requestOptions } = options;
    return this.#request<T>(path, {
      ...requestOptions,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      contentType: "application/json",
    });
  }

  async #request<T>(path: string, options: RequestOptions): Promise<T> {
    const headers = new Headers();
    headers.set("connection", "close");
    headers.set("cookie", options.cookie);
    if (options.contentType !== undefined) {
      headers.set("content-type", options.contentType);
    }
    if (options.idempotencyKey !== undefined) {
      headers.set("idempotency-key", options.idempotencyKey);
    }
    const response = await fetchTeamHub(
      `${this.#baseUrl}${path}`,
      {
        ...(options.body === undefined ? {} : { body: options.body }),
        headers,
        method: options.method,
      },
      `${options.method} ${path}`,
    );
    await assertStatus(response, options.status);
    return response.json() as Promise<T>;
  }
}

interface RequestOptions {
  body?: BodyInit;
  contentType?: string;
  cookie: string;
  idempotencyKey?: string;
  method: "POST" | "PUT";
  status: number;
}

async function assertStatus(response: Response, expected: number) {
  if (response.status === expected) {
    return;
  }
  const body = await response.text();
  throw new Error(
    `${response.url} returned ${response.status}, expected ${expected}: ${body.slice(0, 2_048)}`,
  );
}

async function fetchTeamHub(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(`${operation} transport failed`, { cause: error });
  }
}
