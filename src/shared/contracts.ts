export type ApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
export type IfBusy = "queue" | "steer" | "replace";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  remediation: string;
}

export interface Diagnostics {
  mortiphiVersion: string;
  museVersion: string;
  sdkVersion: string;
  schemaVersion: number;
  schemaFingerprint: string;
  expectedFingerprint: string;
  fingerprintDrift: boolean;
  durability: string;
  platform: string;
  connected: boolean;
  grantedCapabilities: string[];
  unsupported: string[];
}

export interface BootstrapResponse {
  csrfToken: string;
  diagnostics: Diagnostics;
  actions: ActionDefinition[];
  defaults: { modelId: string | null; effort: ReasoningEffort; approvalMode: ApprovalMode };
}

export interface ActionDefinition {
  id: string;
  command: `/${string}`;
  label: string;
  description: string;
  source: "Muse" | "mortiφ";
  gui: string;
  availableWhen: "always" | "session" | "activeTurn" | "queuedTurn";
}

export interface SessionSummary {
  sessionId: string;
  workspaceRoot: string;
  title: string;
  titleSource?: "prompt" | "mortiphi";
  status: "running" | "queued" | "waiting" | "failed" | "idle";
  activeTurnId?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  approvalMode?: ApprovalMode | null;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  forkedFrom?: string | null;
  available: boolean;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  nextCursor: string | null;
}

export interface ProjectSummary {
  workspaceRoot: string;
  name: string;
  available: boolean;
  sessions: SessionSummary[];
}

export interface ProjectionEvent {
  revision: number;
  method: string;
  params: Record<string, unknown>;
  emittedAtMs?: number;
}

export interface SessionProjectionSnapshot {
  revision: number;
  session: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
  state: {
    activeTurnId: string | null;
    stoppingTurnId?: string | null;
    queuedTurns: Array<Record<string, unknown>>;
    model: Record<string, unknown> | null;
    approvalMode: Record<string, unknown> | null;
    branch: Record<string, unknown> | null;
    goal: Record<string, unknown> | null;
    todos: Record<string, unknown> | null;
    tokenUsage: Record<string, unknown> | null;
    contextUsage: Record<string, unknown> | null;
    connection: "connected" | "disconnected" | "failed";
    unknownEvents: Array<{ method: string; viewCursor?: string }>;
  };
  pending: {
    approvals: Array<Record<string, unknown>>;
    userInputs: Array<Record<string, unknown>>;
  };
}

export type TurnInputPart =
  | { type: "text"; text: string }
  | { type: "image"; base64Data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; width?: number; height?: number };

export interface TurnStartBody {
  parts: TurnInputPart[];
  effort: ReasoningEffort;
  ifBusy: IfBusy;
}

export interface CommandAck {
  commandId: string;
  status: string;
  turnId?: string;
  terminal?: boolean;
}

export interface WorkspaceValidation {
  path: string;
  canonicalPath: string;
  name: string;
  valid: boolean;
}

export interface WorkspaceChanges {
  workspaceRoot: string;
  branch: string | null;
  files: Array<{ path: string; status: string }>;
  attribution: "working-tree";
}
