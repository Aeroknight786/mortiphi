import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import { ACTIONS } from "../shared/actions.js";
import type { ApprovalMode, ReasoningEffort, TurnInputPart } from "../shared/contracts.js";
import { AppError, assertRecord, errorMiddleware } from "./errors.js";
import { MuseBridge } from "./muse-bridge.js";
import { WorkspaceRegistry } from "./workspaces.js";

const COOKIE = "mortiphi_session";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
const MODES = new Set(["allowAll", "promptUnmatched", "onRequest", "denyUnmatched"]);

export function createHttpApp(bridge: MuseBridge, workspaces = new WorkspaceRegistry(), port: number | (() => number) = 3000) {
  const app = express();
  const sessionSecret = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const currentPort = () => typeof port === "function" ? port() : port;

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const host = req.headers.host ?? "";
    const allowedHosts = new Set([`127.0.0.1:${currentPort()}`, `localhost:${currentPort()}`]);
    if (!allowedHosts.has(host)) return next(new AppError("invalid_host", "Request Host is not allowed.", 403, false, "Open mortiφ through its displayed localhost URL."));
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return next(new AppError("invalid_origin", "Request Origin is not allowed.", 403, false, "Use the mortiφ window opened by the local server."));
    next();
  });
  app.use(express.json({ limit: "14mb", strict: true }));

  app.get("/api/bootstrap", async (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`);
    res.json({
      csrfToken,
      diagnostics: await bridge.diagnostics(),
      actions: ACTIONS,
      defaults: { modelId: null, effort: "high", approvalMode: "promptUnmatched" },
    });
  });

  app.use("/api", (req, _res, next) => {
    if (cookie(req, COOKIE) !== sessionSecret) return next(new AppError("session_required", "This browser session is not authorized.", 401, true, "Reload mortiφ to establish a fresh local session."));
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.header("x-csrf-token") !== csrfToken) {
      return next(new AppError("csrf_failed", "The request could not be verified.", 403, true, "Reload mortiφ and retry the action."));
    }
    next();
  });

  app.get("/api/sessions", asyncHandler(async (req, res) => {
    res.json(await bridge.listSessions(query(req, "cursor"), query(req, "workspaceRoot")));
  }));
  app.post("/api/workspaces/open", asyncHandler(async (req, res) => {
    assertRecord(req.body); res.json(await workspaces.open(requireString(req.body.path, "path")));
  }));
  app.post("/api/sessions", asyncHandler(async (req, res) => {
    assertRecord(req.body);
    const opened = await workspaces.open(requireString(req.body.workspaceRoot, "workspaceRoot"));
    res.status(201).json(await bridge.startSession(opened.canonicalPath, optionalString(req.body.modelId), approvalMode(req.body.approvalMode)));
  }));
  app.post("/api/sessions/:id/resume", asyncHandler(async (req, res) => {
    const existing = await bridge.readSession(param(req, "id"));
    if (existing.session.workspaceRoot) await workspaces.authorizeExisting(existing.session.workspaceRoot);
    const projection = await bridge.attach(param(req, "id"));
    res.json(projection.snapshot());
  }));
  app.get("/api/sessions/:id/snapshot", asyncHandler(async (req, res) => {
    const existing = bridge.getProjection(param(req, "id"));
    const projection = existing && !bridge.isConnected() ? existing : await bridge.attach(param(req, "id"));
    res.json(projection.snapshot());
  }));
  app.post("/api/sessions/:id/resync", asyncHandler(async (req, res) => {
    const projection = await bridge.resync(param(req, "id"));
    res.json(projection.snapshot());
  }));
  app.get("/api/health", asyncHandler(async (_req, res) => {
    res.json({ ...bridge.health(), museBin: process.env.MUSE_BIN ?? "muse" });
  }));
  app.get("/api/sessions/:id/events", asyncHandler(async (req, res) => {
    const existing = bridge.getProjection(param(req, "id"));
    const projection = existing && !bridge.isConnected() ? existing : await bridge.attach(param(req, "id"));
    bridge.retain(param(req, "id"));
    const after = Number(req.get("Last-Event-ID") ?? query(req, "afterRevision") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_revision", "afterRevision must be a non-negative integer.");
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const replay = projection.eventsAfter(after);
    if (replay === null) sendSse(res, "resyncRequired", { reason: "journal_evicted" });
    else for (const event of replay) sendSse(res, "projection", event, event.revision);
    const unsubscribe = projection.subscribe((event) => {
      if ("type" in event) sendSse(res, "resyncRequired", { reason: "view_gap" });
      else sendSse(res, "projection", event, event.revision);
    });
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
    req.on("close", () => { clearInterval(heartbeat); unsubscribe(); bridge.release(param(req, "id")); });
  }));

  app.post("/api/sessions/:id/fork", asyncHandler(async (req, res) => res.status(201).json(await bridge.fork(param(req, "id")))));
  app.patch("/api/sessions/:id/label", asyncHandler(async (req, res) => {
    assertRecord(req.body); res.json(await bridge.renameTask(param(req, "id"), requireString(req.body.title, "title")));
  }));
  app.delete("/api/sessions/:id", asyncHandler(async (req, res) => res.json(await bridge.removeLocal(param(req, "id")))));
  app.post("/api/sessions/:id/compact", asyncHandler(async (req, res) => res.status(202).json(await bridge.compact(param(req, "id"), optionalString(req.body?.turnId)))));
  app.get("/api/models", asyncHandler(async (req, res) => res.json(await bridge.models(query(req, "sessionId")))));
  app.post("/api/sessions/:id/model", asyncHandler(async (req, res) => {
    assertRecord(req.body); assertRecord(req.body.model); res.status(202).json(await bridge.setModel(param(req, "id"), req.body.model));
  }));
  app.post("/api/sessions/:id/approval-mode", asyncHandler(async (req, res) => {
    assertRecord(req.body); res.status(202).json(await bridge.setApprovalMode(param(req, "id"), approvalMode(req.body.mode)!));
  }));

  app.post("/api/sessions/:id/turns", asyncHandler(async (req, res) => {
    assertRecord(req.body);
    const parts = turnParts(req.body.parts);
    const effort = reasoningEffort(req.body.effort);
    const ifBusy = ["queue", "steer", "replace"].includes(String(req.body.ifBusy)) ? String(req.body.ifBusy) : "queue";
    res.status(202).json(await bridge.startTurn(param(req, "id"), parts, effort, ifBusy));
  }));
  app.post("/api/sessions/:id/turns/:turnId/steer", asyncHandler(async (req, res) => {
    assertRecord(req.body); res.status(202).json(await bridge.steer(param(req, "id"), param(req, "turnId"), turnParts(req.body.parts), req.body.effort ? reasoningEffort(req.body.effort) : undefined));
  }));
  app.post("/api/sessions/:id/turns/:turnId/interrupt", asyncHandler(async (req, res) => res.status(202).json(await bridge.interrupt(param(req, "id"), param(req, "turnId")))));
  app.post("/api/sessions/:id/turns/:turnId/cancel", asyncHandler(async (req, res) => res.status(202).json(await bridge.cancel(param(req, "id"), param(req, "turnId")))));
  app.post("/api/sessions/:id/turns/:turnId/unqueue", asyncHandler(async (req, res) => res.status(202).json(await bridge.unqueue(param(req, "id"), param(req, "turnId")))));

  app.post("/api/sessions/:id/approvals/:approvalId/decide", asyncHandler(async (req, res) => {
    assertRecord(req.body); assertRecord(req.body.requirementId);
    res.status(202).json(await bridge.decideApproval(param(req, "id"), param(req, "approvalId"), req.body.requirementId, requireString(req.body.choiceId, "choiceId"), optionalString(req.body.feedback)));
  }));
  app.post("/api/sessions/:id/questions/:userInputId/answer", asyncHandler(async (req, res) => {
    assertRecord(req.body); if (!Array.isArray(req.body.answers)) throw new AppError("invalid_answers", "answers must be an array.");
    res.status(202).json(await bridge.answerInput(param(req, "id"), param(req, "userInputId"), req.body.answers));
  }));
  app.post("/api/sessions/:id/questions/:userInputId/clarify", asyncHandler(async (req, res) => {
    assertRecord(req.body); res.status(202).json(await bridge.clarifyInput(param(req, "id"), param(req, "userInputId"), requireString(req.body.content, "content")));
  }));
  app.post("/api/sessions/:id/questions/:userInputId/cancel", asyncHandler(async (req, res) => {
    res.status(202).json(await bridge.cancelInput(param(req, "id"), param(req, "userInputId"), optionalString(req.body?.reason)));
  }));

  app.get("/api/sessions/:id/workspace/changes", asyncHandler(async (req, res) => {
    const root = await sessionRoot(bridge, workspaces, param(req, "id")); res.json(await workspaces.changes(root));
  }));
  app.get("/api/sessions/:id/workspace/diff", asyncHandler(async (req, res) => {
    const root = await sessionRoot(bridge, workspaces, param(req, "id")); res.json(await workspaces.diff(root, requireQuery(req, "path")));
  }));
  app.get("/api/sessions/:id/workspace/files", asyncHandler(async (req, res) => {
    const root = await sessionRoot(bridge, workspaces, param(req, "id")); res.json({ files: await workspaces.search(root, query(req, "q") ?? "") });
  }));

  app.use(errorMiddleware);
  return app;
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => void Promise.resolve(fn(req, res, next)).catch(next);
}
function cookie(req: Request, name: string) { return req.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1); }
function query(req: Request, name: string) { const value = req.query[name]; return typeof value === "string" ? value : undefined; }
function requireQuery(req: Request, name: string) { const value = query(req, name); if (!value) throw new AppError("missing_parameter", `${name} is required.`); return value; }
function param(req: Request, name: string): string { const raw = req.params[name]; const value = Array.isArray(raw) ? raw[0] : raw; if (typeof value !== "string" || !value) throw new AppError("missing_parameter", `${name} is required.`); return value; }
function requireString(value: unknown, name: string) { if (typeof value !== "string" || !value.trim()) throw new AppError("invalid_request", `${name} must be a non-empty string.`); return value; }
function optionalString(value: unknown) { return typeof value === "string" && value ? value : undefined; }
function approvalMode(value: unknown): ApprovalMode | undefined { if (value === undefined || value === null || value === "") return undefined; if (!MODES.has(String(value))) throw new AppError("invalid_approval_mode", "That approval mode is not exposed by Muse."); return value as ApprovalMode; }
function reasoningEffort(value: unknown): ReasoningEffort { if (!EFFORTS.has(String(value))) throw new AppError("invalid_effort", "That reasoning effort is not exposed by Muse."); return value as ReasoningEffort; }
function turnParts(value: unknown): TurnInputPart[] {
  if (!Array.isArray(value) || value.length === 0) throw new AppError("invalid_input", "A turn needs at least one text or image part.");
  let images = 0; let bytes = 0;
  const parts = value.map((raw) => {
    assertRecord(raw, "invalid_input");
    if (raw.type === "text") return { type: "text", text: requireString(raw.text, "text") } as TurnInputPart;
    if (raw.type !== "image" || !IMAGE_TYPES.has(String(raw.mediaType)) || typeof raw.base64Data !== "string") throw new AppError("invalid_image", "Only PNG, JPEG, WebP, and GIF images are supported.");
    images += 1; bytes += Math.floor(raw.base64Data.length * 0.75);
    return { type: "image", mediaType: raw.mediaType, base64Data: raw.base64Data, ...(Number.isInteger(raw.width) && Number.isInteger(raw.height) ? { width: raw.width, height: raw.height } : {}) } as TurnInputPart;
  });
  if (images > 4) throw new AppError("too_many_images", "A turn can include at most four images.");
  if (bytes > 10 * 1024 * 1024) throw new AppError("images_too_large", "Images exceed the 10 MiB total limit.");
  return parts;
}
function sendSse(res: Response, event: string, data: unknown, id?: number) { if (id !== undefined) res.write(`id: ${id}\n`); res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
async function sessionRoot(bridge: MuseBridge, workspaces: WorkspaceRegistry, id: string) { const read = await bridge.readSession(id); if (!read.session.workspaceRoot) throw new AppError("workspace_unavailable", "This session has no workspace root.", 409, false, "Open a task whose workspace is still available."); return workspaces.authorizeExisting(read.session.workspaceRoot); }
