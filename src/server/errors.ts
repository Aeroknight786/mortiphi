import type { NextFunction, Request, Response } from "express";
import type { ApiErrorBody } from "../shared/contracts.js";

export type FailureCategory = "transient" | "readable" | "gone";

export class AppError extends Error {
  museCode?: number;
  museKind?: string;
  category?: FailureCategory;
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

const TRANSIENT_KINDS = new Set(["overloaded", "backpressured", "internal", "sessionInUse"]);
const GONE_KINDS = new Set(["sessionNotFound"]);

export function museIdentity(error: unknown): { code?: number; kind?: string; retryable?: boolean } {
  const code = typeof (error as { code?: unknown })?.code === "number" ? (error as { code: number }).code : undefined;
  const dataKind = asJsonKind((error as { data?: unknown })?.data);
  const directKind = typeof (error as { kind?: unknown })?.kind === "string" ? (error as { kind: string }).kind : undefined;
  const retryable = typeof (error as { retryable?: unknown })?.retryable === "boolean" ? (error as { retryable: boolean }).retryable : undefined;
  return { code, kind: dataKind ?? directKind, retryable };
}

export function classifyMuseError(error: unknown): { category: FailureCategory; retryable: boolean; kind?: string; code?: number } {
  const { code, kind, retryable } = museIdentity(error);
  if (typeof retryable === "boolean") return { category: retryable ? "transient" : "readable", retryable, kind, code };
  if (kind && TRANSIENT_KINDS.has(kind)) return { category: "transient", retryable: true, kind, code };
  if (kind && GONE_KINDS.has(kind)) return { category: "gone", retryable: false, kind, code };
  if (kind === "sessionNotLoaded") return { category: "readable", retryable: true, kind, code };
  const message = messageFrom(error);
  if (/timeout|closed|transport|ECONNRESET|EPIPE|not connected|not initialized/i.test(message)) {
    return { category: "transient", retryable: true, kind, code };
  }
  return { category: "readable", retryable: false, kind, code };
}

export function friendlyMuseMessage(kind: string | undefined, method: string, raw: string): { message: string; remediation: string } {
  switch (kind) {
    case "overloaded":
    case "backpressured":
      return { message: "Muse is overloaded right now.", remediation: "Wait a few seconds and retry. Nothing was lost." };
    case "sessionNotFound":
      return { message: "This task no longer exists in Muse.", remediation: "It may have been deleted outside mortiφ. Start a new task if needed." };
    case "sessionNotLoaded":
      return { message: "Muse unloaded this task from memory.", remediation: "Retry — mortiφ re-attaches automatically." };
    case "sessionInUse":
      return { message: "Muse reports this task is busy elsewhere.", remediation: "Wait for the other holder to finish, then retry." };
    case "commandRejected":
      return { message: "Muse rejected this command for the task's current state.", remediation: "Resync the task and retry with its latest state." };
    case "viewTruncated":
    case "boundaryPruned":
    case "boundaryUnusable":
    case "noBoundary":
      return { message: "Muse pruned the view this task was reading.", remediation: "Resync the task to rebuild its view, then retry." };
    case "internal":
      return { message: "Muse hit an internal error.", remediation: "Retry once. If it persists, restart mortiφ." };
    default:
      return {
        message: `Muse could not complete ${method}.`,
        remediation: raw.length > 0 && raw.length < 200 ? raw : "Retry. If it persists, open About & Diagnostics and inspect the server log.",
      };
  }
}

function asJsonKind(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}
