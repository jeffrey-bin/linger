export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly trustedMessage = false,
  ) {
    super(message);
  }
}

/** Constant, authored Connector explanations; never wrap provider prose here. */
export class ConnectorError extends CliError {
  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, details, true);
  }
}
