import { ErrorCodes, type Ack, type ErrorCode } from "@tempo/shared";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function fail(code: ErrorCode, message: string, meta?: Record<string, unknown>): never {
  throw new AppError(code, message, meta);
}

export function toAck(err: unknown): Ack<never> {
  if (err instanceof AppError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: ErrorCodes.INTERNAL, message: "Something went wrong" } };
}
