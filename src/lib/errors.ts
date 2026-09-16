/** Errors safe to return to a client. Internal exceptions use a generic response. */
export class HarnessError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "HarnessError";
  }
}

export function publicError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new HarnessError("CANCELLED", "The run was stopped.", 409);
  }
  return new HarnessError("INTERNAL_ERROR", "Something went wrong. Check the server logs and try again.", 500);
}
