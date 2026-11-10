import postgres from "postgres";

let pool: postgres.Sql | undefined;

/**
 * Memory's one connection pool on TeamHub's database, created on first use.
 * Indexes, collectors and queries all share it; the role's stop(), or a CLI
 * when it finishes, ends it with closeMemoryDatabase().
 */
export function memoryDatabase(
  environment: NodeJS.ProcessEnv = process.env,
): postgres.Sql {
  if (pool) return pool;
  const databaseUrl = environment.TEAMHUB_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("TEAMHUB_DATABASE_URL is required");
  pool = postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 10,
  });
  return pool;
}

/** Standalone CLIs that can run without the database check this first. */
export function memoryDatabaseConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(environment.TEAMHUB_DATABASE_URL?.trim());
}

export async function closeMemoryDatabase(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end({ timeout: 5 });
}
