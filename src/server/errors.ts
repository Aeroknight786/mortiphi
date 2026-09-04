import type { NextFunction, Request, Response } from "express";
import type { ApiErrorBody } from "../shared/contracts.js";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
    public remediation = "Review the request and try again.",
  ) {
    super(message);
  }
}

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const known = error instanceof AppError;
  const body: ApiErrorBody = known
    ? { code: error.code, message: error.message, retryable: error.retryable, remediation: error.remediation }
    : {
        code: "internal_error",
        message: "mortiφ could not complete that operation.",
        retryable: true,
        remediation: "Retry once. If it persists, open About & Diagnostics and inspect the server log.",
      };
  if (!res.headersSent) res.status(known ? error.status : 500).json(body);
}

export function assertRecord(value: unknown, code = "invalid_request"): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(code, "Expected a JSON object.", 400, false, "Correct the request body and try again.");
  }
}

export function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
