export class TwinpodError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TwinpodError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown, fallback = "unknown_error"): string {
  if (error instanceof TwinpodError) return error.code;
  return fallback;
}
