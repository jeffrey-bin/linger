export async function validateAll(
  checks: ReadonlyArray<() => void | Promise<unknown>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const check of checks) {
    try {
      await check();
    } catch (error) {
      errors.push(
        ...(error instanceof AggregateError ? error.errors : [error]),
      );
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      [
        ...new Set(
          errors.map((error) =>
            error instanceof Error ? error.message : String(error),
          ),
        ),
      ].join("\n"),
    );
  }
}
