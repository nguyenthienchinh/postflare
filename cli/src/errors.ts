/** Wrong usage (unknown flag, missing argument...): exit code 2. */
export class UsageError extends Error {
  constructor(message: string, readonly command?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** An error answered by the Postflare API (the message is the API's `error`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Any other failure the user can act on (exit code 1, message printed as is). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
