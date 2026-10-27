export class AppError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human readable, safe to render
   * @param {number} status HTTP status
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super("invalid_input", message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Run not found.") {
    super("not_found", message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message, details) {
    super("conflict", message, 409, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many runs. Try again later.") {
    super("rate_limited", message, 429);
  }
}

export class ConfigError extends AppError {
  constructor(message) {
    super("not_configured", message, 503);
  }
}

export function errorBody(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details ?? null } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "The run failed unexpectedly.", details: null } },
  };
}
