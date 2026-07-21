export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "http" | "protocol" | "server" | "session-expired" | "second-factor",
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SessionExpiredError extends ApiError {
  constructor() {
    super("Your session has expired. Please sign in again.", "session-expired");
  }
}

export class SecondFactorUnsupportedError extends ApiError {
  constructor() {
    super("This account requires two-factor authentication, which the v2 API cannot complete.", "second-factor");
  }
}

