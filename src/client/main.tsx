import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/600.css";
import { render } from "preact";
import { useEffect, useErrorBoundary, useMemo, useRef, useState } from "preact/hooks";
import type { ActionDefinition, BootstrapResponse, HealthStatus, ProjectSummary, ReasoningEffort, SessionProjectionSnapshot, SessionSummary, TurnInputPart, WorkspaceChanges } from "../shared/contracts";
import { api, ApiError, bootstrap } from "./api";
import { Dialog } from "./components/Dialog";
import { DiffViewer, type DiffResult } from "./components/DiffViewer";
import { ProjectChangesCard } from "./components/ProjectChangesCard";
import { extractEditedPaths } from "./diff";
import { useDismissableLayer } from "./hooks/useDismissableLayer";
import { handleMarkdownClick, markdown } from "./markdown";
import { connectionLabel, readTabDraft, scrollAnchorKey, statusLabel, tabDraftId, taskSubtitle } from "./ui-state";
import "./styles.css";

type Json = Record<string, any>;
type DetailTab = "overview" | "changes" | "activity";
type TranscriptBlock = { key: string; turnId: string | null; items: Json[] };
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"];
const FAILED_TURN_STATES = new Set(["failed", "error", "cancelled", "canceled", "aborted", "timedOut", "timed_out", "stale"]);
const MODES = [
  { value: "promptUnmatched", label: "Untrusted", detail: "Ask when no rule matches" },
  { value: "onRequest", label: "On request", detail: "Ask when an action requests approval" },
  { value: "denyUnmatched", label: "Never ask", detail: "Deny unmatched actions" },
  { value: "allowAll", label: "Advanced broad access", detail: "Allow all actions without asking" },
];

function App() {
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionProjectionSnapshot | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  const [detailWidth, setDetailWidth] = useState(() => Number(localStorage.getItem("mortiphi:detail-width") ?? 384));
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [dialog, setDialog] = useState<"new" | "settings" | "models" | "permissions" | "effort" | "help" | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<SessionSummary | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refreshTimer = useRef<number>();

  const loadSessions = async (cursor?: string) => {
    const result = await api.sessions(cursor);
    setSessions((current) => cursor ? [...current, ...result.sessions] : result.sessions);
    setNextCursor(result.nextCursor);
    return result;
  };
  useEffect(() => {
    void (async () => {
      try {
        const value = await bootstrap(); (window as any).__mortiphiActions = value.actions; setBoot(value);
        const result = await loadSessions();
        const lastId = localStorage.getItem("mortiphi:last-session");
        const last = result.sessions.find((session) => session.sessionId === lastId && session.available);
        if (last) { setSnapshot(await api.resume(last.sessionId)); setActiveId(last.sessionId); }
      }
      catch (e) { setError(normalize(e)); }
      finally { setLoading(false); }
    })();
  }, []);
  const refreshHealth = async () => {
    try { setHealth(await api.health()); }
    catch { setHealth({ connected: false, reconnectAttempt: 0, reconnectScheduled: true, subscriptions: 0, inFlightCommands: [], pendingReattach: [] }); }
  };
  useEffect(() => {
    if (!boot) return;
    void refreshHealth();
    const timer = window.setInterval(() => void refreshHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [boot]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); setDialog("new"); } };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const update = () => { setCompactLayout(query.matches); if (query.matches) setDetailOpen(false); };
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!activeId || !snapshot) return;
    setSessions((all) => all.map((session) => session.sessionId === activeId ? { ...session, title: session.titleSource === "mortiphi" ? session.title : titleFrom(snapshot.items), status: sessionState(snapshot) as SessionSummary["status"], activeTurnId: snapshot.state.activeTurnId, updatedAt: String(snapshot.session.updatedAt ?? session.updatedAt) } : session));
  }, [activeId, snapshot]);

  const snapshotRef = useRef<SessionProjectionSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  useEffect(() => { setError(null); }, [activeId]);
  const refreshSnapshot = async (id = activeIdRef.current) => {
    if (!id) return;
    try { const next = await api.snapshot(id); if (activeIdRef.current === id) setSnapshot(next); }
    catch (e) { if (activeIdRef.current === id) setError(normalize(e)); }
  };
  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    const after = snapshotRef.current?.revision ?? 0;
    const source = new EventSource(`/api/sessions/${id}/events?afterRevision=${after}`);
    const schedule = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refreshSnapshot(id), 45);
    };
    source.addEventListener("projection", (event) => {
      const parsed = JSON.parse((event as MessageEvent).data);
      if (["turn/completed", "turn/retracted", "approval/requested", "userInput/requested"].includes(parsed.method)) setAnnouncement(eventAnnouncement(parsed));
      applyIncrementalEvent(parsed, setSnapshot);
      schedule();
    });
    source.addEventListener("resyncRequired", () => {
      void (async () => {
        try { const next = await api.resync(id); if (activeIdRef.current === id) setSnapshot(next); }
        catch (e) { if (activeIdRef.current === id) setError(normalize(e)); }
      })();
    });
    source.onerror = () => { setAnnouncement("Muse connection interrupted. Reconnecting."); void refreshHealth(); };
    return () => { source.close(); window.clearTimeout(refreshTimer.current); };
  }, [activeId]);

  const projects = useMemo(() => groupProjects(sessions), [sessions]);
  const current = sessions.find((session) => session.sessionId === activeId);

  const chooseTask = async (session: SessionSummary) => {
    if (!session.available) return setError(new ApiError("workspace_unavailable", "This task's workspace is unavailable.", false, "Restore or reconnect the workspace folder before resuming this task."));
    if (session.sessionId === activeId) return;
    setError(null); setOpening(session);
    try {
      setSnapshot(await api.resume(session.sessionId)); setActiveId(session.sessionId);
      localStorage.setItem("mortiphi:last-session", session.sessionId);
    }
    catch (e) { setError(normalize(e)); }
    finally { setOpening(null); }
  };
  const openCreated = async (result: any) => {
    const id = result.session.sessionId;
    setSessions((all) => [result.session, ...all.filter((s) => s.sessionId !== id)]);
    setSnapshot(result.snapshot); setActiveId(id); setDialog(null);
    localStorage.setItem("mortiphi:last-session", id);
  };
  const taskAction = async (action: string, session: SessionSummary) => {
    try {
      if (action === "rename") { setRenameTarget(session); return; }
      if (action === "delete") { setRemoveTarget(session); return; }
      if (action === "fork") return openCreated(await api.fork(session.sessionId));
      if (action === "compact") { await api.compact(session.sessionId); setAnnouncement("Compaction admitted for the selected task."); return; }
      if (action === "copy-id") { await navigator.clipboard.writeText(session.sessionId); return; }
      if (action === "new") return openCreated(await api.newSession(session.workspaceRoot, null, session.approvalMode ?? "promptUnmatched"));
    } catch (e) { setError(normalize(e)); }
  };
  const command = async (id: string, args = "") => {
    try {
      if (id === "new") return setDialog("new");
      if (id === "resume" || id === "tasks") return document.querySelector<HTMLElement>(".sidebar")?.focus();
      if (id === "settings") return setDialog("settings");
      if (id === "help") return setDialog("help");
      if (id === "rename") {
        if (current) setRenameTarget(current); return;
      }
      if (id === "delete") { if (current) setRemoveTarget(current); return; }
      if (id === "details" || id === "changes" || id === "activity") { setDetailOpen(true); setDetailTab(id === "details" ? "overview" : id); return; }
      if (id === "model") return setDialog("models");
      if (id === "effort") return setDialog("effort");
      if (id === "permissions") return setDialog("permissions");
      if (!activeId) return setError(new ApiError("session_required", "Open a task first.", false, "Choose a task from the sidebar."));
      if (id === "fork") return openCreated(await api.fork(activeId));
      if (id === "clear") {
        const root = current?.workspaceRoot || String(snapshot?.session.workspaceRoot ?? "");
        if (!root) return setDialog("new");
        return openCreated(await api.newSession(root, null, effectiveMode(snapshot)));
      }
      if (id === "compact") { await api.compact(activeId); setAnnouncement("Compaction admitted. Muse will report its result in the transcript."); return; }
      if (id === "resync") { setSnapshot(await api.resync(activeId)); setAnnouncement("Task resynced from Muse."); return; }
      if (id === "stop" && snapshot?.state.activeTurnId) { await api.stop(activeId, snapshot.state.activeTurnId); setAnnouncement("Stopping. Waiting for Muse to confirm."); return; }
      if (id === "copy") {
        const last = [...(snapshot?.items ?? [])].reverse().find((item) => item.kind === "agentMessage");
        if (last?.text) await navigator.clipboard.writeText(String(last.text));
        return;
      }
      if (id === "unqueue") {
        const turn = snapshot?.state.queuedTurns[0]; if (turn?.turnId) await api.unqueue(activeId, String(turn.turnId));
        return;
      }
      if (["queue", "steer", "replace"].includes(id) && args) document.dispatchEvent(new CustomEvent("mortiphi:command-submit", { detail: { mode: id, text: args } }));
    } catch (e) { setError(normalize(e)); }
  };

  if (loading && !boot) return <div class="boot"><div class="brand-mark">mortiφ</div><p>Connecting to Muse…</p></div>;
  return <div class="app-shell">
    <aside class="sidebar" tabIndex={-1} aria-label="Projects and tasks">
      <div class="brand-row"><span class="brand-mark">mortiφ</span></div>
      <button class="new-task" onClick={() => setDialog("new")}><span>＋</span> New task <kbd>⌘N</kbd></button>
      <div class="sidebar-label">Projects</div>
      <nav class="projects">{projects.map((project) => <Project key={project.workspaceRoot} project={project} activeId={activeId} onChoose={chooseTask} onTaskAction={taskAction} />)}</nav>
      {nextCursor && <button class="quiet-button load-more" onClick={() => void loadSessions(nextCursor)}>Show more tasks</button>}
      <button class="profile-button" onClick={() => setDialog("settings")}><span><strong>Settings</strong><small>{connectionLabel(health, boot?.diagnostics.connected ?? false)}</small></span><span>⌄</span></button>
    </aside>
    <main class="workspace">
      {snapshot && activeId ? <>
        <TaskHeader session={current} snapshot={snapshot} detailOpen={detailOpen} setDetailOpen={setDetailOpen} onCommand={command} />
        {snapshot.readOnly && <div class="warning-note" role="status">Muse can't resume this task, so it's read-only. <button class="quiet-button" onClick={() => void command("resync")}>Resync</button> <button class="quiet-button" onClick={() => void command("fork")}>Fork to continue</button></div>}
        <div class={`work-grid ${compactLayout ? "compact-layout" : ""}`} style={{ gridTemplateColumns: detailOpen && !compactLayout ? `minmax(0, 1fr) ${detailWidth}px` : "1fr" }}>
          <section class="conversation"><Transcript snapshot={snapshot} sessionId={activeId} onRefresh={() => void refreshSnapshot()} setError={setError} /><Composer key={activeId} sessionId={activeId} snapshot={snapshot} readOnly={snapshot.readOnly} onCommand={command} onSnapshot={() => void refreshSnapshot()} setError={setError} /></section>
          {detailOpen && <Details sessionId={activeId} snapshot={snapshot} tab={detailTab} setTab={setDetailTab} setError={setError} onResize={(width) => { setDetailWidth(width); localStorage.setItem("mortiphi:detail-width", String(width)); }} />}
        </div>
      </> : <Welcome onNew={() => setDialog("new")} sessions={sessions} onChoose={chooseTask} />}
      {opening && <TaskOpening session={opening}/>}
    </main>
    {error && <div class="error-toast" role="alert"><div><strong>{error.message}</strong><small>{error.remediation}</small></div><button onClick={() => setError(null)}>×</button></div>}
    <div class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    {dialog === "new" && <NewTask projects={projects} currentRoot={current?.workspaceRoot} onClose={() => setDialog(null)} onCreate={openCreated} setError={setError} />}
    {dialog === "settings" && <Settings onClose={() => setDialog(null)} />}
    {dialog === "models" && <ModelPicker sessionId={activeId} onClose={() => setDialog(null)} onSelect={() => void refreshSnapshot()} setError={setError} />}
    {dialog === "permissions" && <PermissionPicker sessionId={activeId} value={effectiveMode(snapshot)} onClose={() => setDialog(null)} onSelect={() => void refreshSnapshot()} setError={setError} />}
    {dialog === "effort" && <EffortPicker onClose={() => setDialog(null)} />}
    {dialog === "help" && boot && <Help actions={boot.actions} onClose={() => setDialog(null)} onCommand={command} />}
    {renameTarget && <RenameTask session={renameTarget} onClose={() => setRenameTarget(null)} onRenamed={(renamed) => { setSessions((all) => all.map((session) => session.sessionId === renamed.sessionId ? { ...session, title: renamed.title, titleSource: "mortiphi" } : session)); setRenameTarget(null); }} setError={setError}/>}
    {removeTarget && <RemoveTask session={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={(sessionId) => { setSessions((all) => all.filter((session) => session.sessionId !== sessionId)); if (activeId === sessionId) { setActiveId(null); setSnapshot(null); localStorage.removeItem("mortiphi:last-session"); } setRemoveTarget(null); }} setError={setError}/>}
  </div>;
}

function Project({ project, activeId, onChoose, onTaskAction }: { project: ProjectSummary; activeId: string | null; onChoose: (s: SessionSummary) => void; onTaskAction: (action: string, session: SessionSummary) => void }) {
  const key = `mortiphi:project:${project.workspaceRoot}`;
  const [open, setOpen] = useState(() => localStorage.getItem(key) !== "closed");
  const toggle = () => { const next = !open; setOpen(next); localStorage.setItem(key, next ? "open" : "closed"); };
  const [taskMenu, setTaskMenu] = useState<string | null>(null);
  const menuRef = useDismissableLayer<HTMLDivElement>(Boolean(taskMenu), () => setTaskMenu(null));
  return <section class="project-group"><button class="project-row" onClick={toggle} aria-expanded={open}><span class="chevron">{open ? "⌄" : "›"}</span><span title={project.workspaceRoot}>{project.name}</span><small>{project.sessions.length}</small></button>
    {open && <div class="task-list">{project.sessions.map((session) => { const actions = [["fork","Fork task"],["rename","Rename task"],["compact","Compact context"],["copy-id","Copy task ID"],["new","New task in this project"],["delete","Remove task"]]; const active = activeId === session.sessionId; return <div ref={taskMenu === session.sessionId ? menuRef : undefined} class={`task-row-wrap ${active ? "active" : ""}`} key={session.sessionId}><button class="task-row" aria-current={active ? "page" : undefined} onClick={() => onChoose(session)}><span class={`status-dot ${session.status}`} aria-hidden="true"/><span class="task-copy"><strong>{session.title}</strong><small>{taskSubtitle(session)}</small></span></button><button class="task-more" aria-label={`Actions for ${session.title}`} onClick={() => setTaskMenu(taskMenu === session.sessionId ? null : session.sessionId)}>•••</button>{taskMenu === session.sessionId && <div class="task-popover" role="menu">{actions.map(([id,label]) => <button class={id === "delete" ? "danger-action" : ""} role="menuitem" disabled={!session.available && !["copy-id","delete"].includes(id!)} onClick={() => { setTaskMenu(null); void onTaskAction(id!, session); }}>{label}</button>)}</div>}</div>; })}</div>}
  </section>;
}

function Welcome({ onNew, sessions, onChoose }: { onNew: () => void; sessions: SessionSummary[]; onChoose: (s: SessionSummary) => void }) {
  return <div class="welcome"><div class="welcome-glyph">φ</div><h1>What are we building?</h1><p>Start a task or continue where you left off.</p><div class="welcome-actions"><button class="primary" onClick={onNew}>New task</button>{sessions[0] && <button onClick={() => onChoose(sessions[0]!)}>Resume recent</button>}</div></div>;
}

function TaskOpening({ session }: { session: SessionSummary }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const started = Date.now(); const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000); return () => window.clearInterval(timer); }, []);
  return <div class="task-opening" role="status" aria-live="polite"><div class="opening-card"><span class="opening-glyph">φ</span><div><strong>Opening {session.title}</strong><p>{seconds < 3 ? "Loading the task and reconnecting…" : seconds < 10 ? "Restoring its conversation and pending decisions…" : "This task has a long history. The task currently on screen remains available if recovery times out."}</p><small>{seconds > 0 ? `${seconds}s elapsed` : "Starting…"}</small></div></div></div>;
}

function TaskHeader({ session, snapshot, detailOpen, setDetailOpen, onCommand }: { session?: SessionSummary; snapshot: SessionProjectionSnapshot; detailOpen: boolean; setDetailOpen: (v: boolean) => void; onCommand: (id: string) => void }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useDismissableLayer<HTMLDivElement>(menu, () => setMenu(false));
  const state = sessionState(snapshot);
  const stage = transientStage(snapshot, state);
  const actions = [["fork","Fork task"],["rename","Rename task"],["clear","New task in this project"],["compact","Compact context"],["copy","Copy last response"],["delete","Remove task"]];
  return <header class="task-header"><div><span class="eyebrow">{folderName(String(snapshot.session.workspaceRoot ?? ""))}</span><h1>{session?.title ?? titleFrom(snapshot.items)}</h1></div><div class="header-actions">{state !== "idle" && <span class={`state-pill ${state}`}><span>{statusLabel(state)}</span>{stage && <small>· {stage}</small>}</span>}<button class={`details-button ${detailOpen ? "selected" : ""}`} onClick={() => setDetailOpen(!detailOpen)} aria-label="Toggle details">Details</button><div ref={menuRef} class="menu-wrap"><button class="icon-button" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>•••</button>{menu && <div class="popover menu" role="menu">{actions.map(([id,label]) => <button class={id === "delete" ? "danger-action" : ""} role="menuitem" onClick={() => { setMenu(false); void onCommand(id!); }}>{label}</button>)}</div>}</div></div></header>;
}

function Transcript({ snapshot, sessionId, onRefresh, setError }: { snapshot: SessionProjectionSnapshot; sessionId: string; onRefresh: () => void; setError: (e: ApiError) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const restoredRef = useRef<string | null>(null);
  const saveTimer = useRef<number>();
  const failedTurns = authoritativeFailedTurns(snapshot);
  const blocks = transcriptBlocks(snapshot.items);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const persist = () => {
      const nearBottom = isNearBottom(el);
      atBottomRef.current = nearBottom;
      if (nearBottom) { localStorage.removeItem(scrollAnchorKey(sessionId)); return; }
      const anchor = firstVisibleItemId(el);
      if (anchor) localStorage.setItem(scrollAnchorKey(sessionId), anchor);
    };
    // atBottomRef tracks synchronously so a streaming chunk landing between
    // scroll and the debounced write can't act on a stale true; only the
    // storage write is debounced.
    const onScroll = () => { atBottomRef.current = isNearBottom(el); window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 150); };
    atBottomRef.current = isNearBottom(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); window.clearTimeout(saveTimer.current); persist(); };
  }, [sessionId]);
  useEffect(() => {
    if (restoredRef.current === sessionId || snapshot.items.length === 0) return;
    restoredRef.current = sessionId;
    const anchor = localStorage.getItem(scrollAnchorKey(sessionId));
    const target = anchor ? findAnchorItem(scroller.current, anchor) : null;
    if (target) { atBottomRef.current = false; target.scrollIntoView({ block: "start" }); return; }
    // Anchor missing (compacted away or never rendered): drop it so it can't
    // shadow a future position, then bottom — the only place left to go.
    if (anchor) localStorage.removeItem(scrollAnchorKey(sessionId));
    atBottomRef.current = true;
    end.current?.scrollIntoView({ block: "end" });
  }, [sessionId, snapshot.items.length]);
  useEffect(() => {
    if (restoredRef.current !== sessionId || !atBottomRef.current) return;
    end.current?.scrollIntoView({ block: "end" });
  }, [sessionId, snapshot.items.length, snapshot.items.at(-1)?.text, snapshot.pending.approvals.length]);
  return <div ref={scroller} class="transcript" onClick={(e) => handleMarkdownClick(e as unknown as MouseEvent)}>{snapshot.items.length === 0 && <div class="empty-transcript"><span>φ</span><h2>What are we building?</h2><p>Describe the outcome. Add files with @ or images with the attachment button.</p></div>}
    {blocks.map((block) => <TranscriptBlockView key={block.key} block={block} sessionId={sessionId} activeTurnId={snapshot.state.activeTurnId} queuedTurnIds={snapshot.state.queuedTurns.map((turn) => String(turn.turnId))} setError={setError}/>)}
    {failedTurns.map((turn) => <TurnNotice key={String(turn.turnId)} title="Could not complete this prompt" detail={String(turn.reason ?? turn.message ?? `Turn ended as ${turn.state}.`)} />)}
    {snapshot.pending.approvals.map((approval) => <ApprovalCard key={String(approval.approvalId)} approval={approval} sessionId={sessionId} onRefresh={onRefresh} setError={setError} />)}
    {snapshot.pending.userInputs.map((request) => <QuestionCard key={String(request.userInputId)} request={request} sessionId={sessionId} onRefresh={onRefresh} setError={setError} />)}
    {snapshot.state.activeTurnId && <LiveTurnStatus snapshot={snapshot}/>}
    <div ref={end}/></div>;
}

function TranscriptBlockView({ block, sessionId, activeTurnId, queuedTurnIds, setError }: { block: TranscriptBlock; sessionId: string; activeTurnId: string | null; queuedTurnIds: string[]; setError: (error: ApiError) => void }) {
  const messages = block.items.filter((item) => item.kind === "userMessage" || item.kind === "agentMessage");
  const activity = block.items.filter((item) => item.kind !== "userMessage" && item.kind !== "agentMessage");
  const userMessages = messages.filter((item, index, all) => item.kind === "userMessage" && all.findIndex((candidate) => candidate.kind === "userMessage" && normalizedPrompt(candidate.text) === normalizedPrompt(item.text)) === index);
  const agentMessages = messages.filter((item) => item.kind === "agentMessage");
  const attempts = messages.filter((item) => item.kind === "userMessage").length;
  const changedPaths = extractEditedPaths(activity);
  const unanswered = userMessages.length > 0 && agentMessages.length === 0 && block.turnId !== activeTurnId && !queuedTurnIds.includes(String(block.turnId));
  const lastPrompt = userMessages.at(-1);
  return <section class="turn-block">{userMessages.map((item) => <SafeItemView key={String(item.itemId)} item={item}/>)}{activity.length > 0 && block.turnId !== activeTurnId && <ActivitySummary items={activity} attempts={attempts}/>} {agentMessages.map((item) => <SafeItemView key={String(item.itemId)} item={item}/>)}{changedPaths.length > 0 && block.turnId !== activeTurnId && <ProjectChangesCard sessionId={sessionId} refreshKey={block.key} active={false} paths={changedPaths} onError={setError}/>} {unanswered && <div class="unanswered-row"><span>No response recorded</span><button onClick={() => document.dispatchEvent(new CustomEvent("mortiphi:restore-draft", { detail: { text: String(lastPrompt?.text ?? "") } }))}>Retry</button></div>}</section>;
}

function ActivitySummary({ items, attempts }: { items: Json[]; attempts: number }) {
  const failures = items.filter((item) => item.status === "failed").length;
  return <details class={`turn-activity ${failures ? "attention" : ""}`}><summary><span>Activity</span><small>{items.length} {items.length === 1 ? "step" : "steps"}{attempts > 1 ? ` · ${attempts} attempts` : ""}{failures ? ` · ${failures} failed` : ""}</small></summary><div class="turn-activity-list">{items.map((item) => <div><span>{activityName(item)}</span><small>{item.status === "failed" ? "Failed" : item.status === "inProgress" ? "Running" : "Done"}</small></div>)}</div></details>;
}

function SafeItemView({ item }: { item: Json }) {
  const [error] = useErrorBoundary((cause) => console.error(`Could not render transcript item ${String(item.itemId ?? "unknown")}.`, cause));
  if (error) return <details class="activity-item unknown" open><summary><span>!</span> Item could not be displayed <small>preserved by Muse</small></summary><p>This transcript item is still in the session, but its presenter failed. Retry the view or restart mortiφ.</p></details>;
  return <ItemView item={item}/>;
}

function ItemView({ item }: { item: Json }) {
  if (item.kind === "userMessage") return <article class={`message user ${item.retracted ? "retracted" : ""}`} data-item-id={item.itemId ?? undefined}><div class="message-label">You {item.steered && <span>· steering</span>}{item.retracted && <span>· retracted</span>}</div><div class="message-body" dangerouslySetInnerHTML={markdown(String(item.text ?? ""))}/>{Array.isArray(item.attachments) && item.attachments.length > 0 && <small>{item.attachments.length} image attachment{item.attachments.length > 1 ? "s" : ""}</small>}</article>;
  if (item.kind === "agentMessage") return <article class="message agent" data-item-id={item.itemId ?? undefined}><div class="message-body" dangerouslySetInnerHTML={markdown(String(item.text ?? ""))}/>{item.truncated && <div class="warning-note">Earlier output is shortened in this view. The full output remains in the session.</div>}</article>;
  return <details class="activity-item unknown" data-item-id={item.itemId ?? undefined}><summary><span>?</span> {item.kind ?? "Unknown item"} <small>{item.status ?? "unknown"}</small></summary><p>{item.fallbackText ?? item.text ?? "This item kind is newer than mortiφ. It remains preserved in the session."}</p></details>;
}

function TurnNotice({ title, detail, prompt }: { title: string; detail: string; prompt?: string }) {
  return <article class="turn-notice" role="status"><div><strong>{title}</strong><p>{detail}</p></div>{prompt && <button onClick={() => document.dispatchEvent(new CustomEvent("mortiphi:restore-draft", { detail: { text: prompt } }))}>Retry prompt</button>}</article>;
}

function LiveTurnStatus({ snapshot }: { snapshot: SessionProjectionSnapshot }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const activeId = snapshot.state.activeTurnId;
  const latest = latestLiveItem(snapshot);
  const updated = new Date(String(snapshot.session.updatedAt ?? "")).getTime();
  const quietSeconds = Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 1000)) : 0;
  const label = snapshot.pending.approvals.length ? "Waiting for your permission" : snapshot.pending.userInputs.length ? "Waiting for your answer" : liveActivityLabel(latest);
  const detail = quietSeconds >= 10 ? `Still working · ${quietSeconds}s since the last update` : latest ? null : "Starting…";
  return <div class={`live-turn ${quietSeconds >= 10 ? "quiet" : ""}`} aria-label="Task in progress"><span class="live-pulse" aria-hidden="true"/><div><strong>{label}</strong>{detail && <small>{detail}</small>}</div></div>;
}

function Composer({ sessionId, snapshot, readOnly, onCommand, onSnapshot, setError }: { sessionId: string; snapshot: SessionProjectionSnapshot; readOnly?: boolean; onCommand: (id: string, args?: string) => void; onSnapshot: () => void; setError: (e: ApiError) => void }) {
  const [tabId] = useState(tabDraftId);
  const legacyDraftKey = `mortiphi:draft:${sessionId}`;
  const draftKey = `${legacyDraftKey}:${tabId}`;
  const [text, setText] = useState(() => readTabDraft(draftKey, legacyDraftKey));
  const [effort, setEffort] = useState<ReasoningEffort>(() => (localStorage.getItem("mortiphi:effort") as ReasoningEffort) || "high");
  const [mode, setMode] = useState<"queue" | "steer" | "replace">("queue");
  const [images, setImages] = useState<TurnInputPart[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [filePicker, setFilePicker] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [fileQuery, setFileQuery] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const active = snapshot.state.activeTurnId;
  const actions = (window as any).__mortiphiActions as ActionDefinition[] | undefined;
  const query = text.startsWith("/") && !text.includes("\n") ? text.slice(1).split(/\s/)[0]!.toLowerCase() : null;
  const matches = query !== null && !commandDismissed ? (actions ?? []).filter((a) => a.command.slice(1).includes(query) || a.label.toLowerCase().includes(query)).slice(0, 8) : [];
  const composerLayerRef = useDismissableLayer<HTMLDivElement>(filePicker || matches.length > 0, () => { setFilePicker(false); setCommandDismissed(true); });
  useEffect(() => { localStorage.setItem(draftKey, text); }, [text]);
  useEffect(() => {
    const listener = (event: Event) => { const detail = (event as CustomEvent).detail; setMode(detail.mode); setText(detail.text); window.setTimeout(() => void submit(detail.mode, detail.text), 0); };
    document.addEventListener("mortiphi:command-submit", listener); return () => document.removeEventListener("mortiphi:command-submit", listener);
  });
  useEffect(() => {
    const restore = (event: Event) => { setText(String((event as CustomEvent).detail?.text ?? "")); window.setTimeout(() => inputRef.current?.focus(), 0); };
    document.addEventListener("mortiphi:restore-draft", restore); return () => document.removeEventListener("mortiphi:restore-draft", restore);
  }, []);
  useEffect(() => { if (!active) setStopping(false); }, [active]);
  useEffect(() => {
    if (active && snapshot.state.stoppingTurnId === active) setStopping(true);
    else if (!snapshot.state.stoppingTurnId) setStopping(false);
    const retracted = [...snapshot.turns].reverse().find((turn) => turn.state === "retracted" || turn.state === "unqueued");
    if (!retracted?.turnId) return;
    const marker = `mortiphi:restored:${retracted.turnId}`;
    if (localStorage.getItem(marker)) return;
    const item = [...snapshot.items].reverse().find((candidate) => candidate.kind === "userMessage" && candidate.turnId === retracted.turnId && (retracted.state === "unqueued" || candidate.retracted));
    if (item?.text && !text) { setText(String(item.text)); localStorage.setItem(marker, "true"); }
    }, [active, snapshot.state.stoppingTurnId, snapshot.turns.length]);

  const submit = async (forcedMode = mode, forcedText = text) => {
    if (readOnly) { setError(new ApiError("session_readonly", "This task is read-only.", false, "Fork the task to keep working.")); return; }
    const trimmed = forcedText.trim(); if ((!trimmed && images.length === 0) || busy) return;
    const [token, ...rest] = trimmed.split(/\s+/);
    const action = (actions ?? []).find((a) => a.command === token);
    if (action) { setText(""); setCommandDismissed(true); localStorage.removeItem(draftKey); await onCommand(action.id, rest.join(" ")); return; }
    if (forcedMode === "replace" && active && !window.confirm("Replace the active turn? Muse will interrupt it before starting this prompt.")) return;
    const parts: TurnInputPart[] = [...(trimmed ? [{ type: "text", text: trimmed } as TurnInputPart] : []), ...images];
    setBusy(true);
    try {
      if (forcedMode === "steer" && active) await api.steer(sessionId, active, parts, effort);
      else await api.turn(sessionId, parts, effort, active ? forcedMode : "queue");
      setText(""); setImages([]); localStorage.removeItem(draftKey); onSnapshot();
    } catch (e) { setError(normalize(e)); }
    finally { setBusy(false); }
  };
  const keydown = (event: KeyboardEvent) => {
    if (matches.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setCmdIndex((i) => (i + 1) % matches.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setCmdIndex((i) => (i - 1 + matches.length) % matches.length); return; }
      if (event.key === "Tab") { event.preventDefault(); setText(`${matches[cmdIndex]?.command ?? text} `); return; }
      if (event.key === "Escape") { event.preventDefault(); setCommandDismissed(true); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); const selected = matches[cmdIndex]; if (selected) { setText(""); setCommandDismissed(true); void onCommand(selected.id); } return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
  };
  const addImages = async (list: FileList | null) => {
    if (!list) return; const selected = [...list].slice(0, 4 - images.length);
    let total = images.reduce((sum, image) => sum + (image.type === "image" ? image.base64Data.length * .75 : 0), 0);
    const next: TurnInputPart[] = [];
    for (const file of selected) {
      if (!file.type.match(/^image\/(png|jpeg|webp|gif)$/)) continue;
      total += file.size; if (total > 10 * 1024 * 1024) { setError(new ApiError("images_too_large", "Images exceed 10 MiB total.", false, "Remove one or more images.")); break; }
      next.push({ type: "image", mediaType: file.type as any, base64Data: await fileBase64(file) });
    }
    setImages((all) => [...all, ...next]);
  };
  const findFiles = async (q: string) => { setFileQuery(q); try { setFiles((await api.files(sessionId, q)).files); } catch (e) { setError(normalize(e)); } };
  const hasDraft = Boolean(text.trim() || images.length);
  const primaryIsStop = Boolean(active) && (stopping || !hasDraft);
  const primaryAction = async () => {
    if (!primaryIsStop) return submit();
    if (!active || stopping) return;
    setStopping(true);
    try { await api.stop(sessionId, active); }
    catch (e) { setStopping(false); setError(normalize(e)); }
  };
  return <div class="composer-wrap" ref={composerLayerRef}>
    {matches.length > 0 && <div class="command-palette" role="listbox">{matches.map((action, index) => <button role="option" aria-selected={index === cmdIndex} class={index === cmdIndex ? "selected" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(""); setCommandDismissed(true); void onCommand(action.id); }}><span><strong>{action.command}</strong> {action.label}</span><small>{action.source} · {action.gui}</small></button>)}</div>}
    {filePicker && <div class="file-palette"><input autoFocus value={fileQuery} onInput={(e) => void findFiles(e.currentTarget.value)} placeholder="Find a workspace file…" />{files.map((path) => <button onClick={() => { setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${path} `); setFilePicker(false); inputRef.current?.focus(); }}>{path}</button>)}</div>}
    {images.length > 0 && <div class="attachment-strip">{images.map((image, i) => image.type === "image" && <div class="attachment"><img src={`data:${image.mediaType};base64,${image.base64Data}`} alt={`Attachment ${i + 1}`} /><button onClick={() => setImages((all) => all.filter((_, n) => n !== i))} aria-label="Remove attachment">×</button></div>)}</div>}
    <div class="composer"><textarea ref={inputRef} value={text} disabled={readOnly} onInput={(e) => { setText(e.currentTarget.value); setCommandDismissed(false); setFilePicker(false); }} onKeyDown={keydown as any} placeholder={readOnly ? "Read-only task — fork to keep working" : active ? "Guide the running task, or type / for commands" : "Ask to build, fix, or explain…  / for commands"} rows={3}/>
      <div class="composer-tools"><div class="tool-left"><label class="attach-button" title="Attach up to four images"><span>＋</span><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void addImages(e.currentTarget.files)} /></label><button onClick={() => { setCommandDismissed(true); setFilePicker(!filePicker); if (!filePicker) void findFiles(""); }} title="Mention a workspace file">@</button><button class={`permissions-control ${effectiveMode(snapshot)==="allowAll"?"broad":""}`} onClick={() => { setFilePicker(false); setCommandDismissed(true); void onCommand("permissions"); }} title="Choose permissions"><span class="permission-symbol">!</span>{modeLabel(effectiveMode(snapshot))}</button></div><div class="tool-right"><div class="turn-configurator" aria-label="Model and reasoning effort"><button onClick={() => { setFilePicker(false); setCommandDismissed(true); void onCommand("model"); }} title="Choose model">{String(snapshot.state.model?.modelId ?? snapshot.session.modelId ?? "Muse default").replace(/^muse-/, "")}</button><select value={effort} onChange={(e) => { const value = e.currentTarget.value as ReasoningEffort; setEffort(value); localStorage.setItem("mortiphi:effort", value); }} aria-label="Reasoning effort">{EFFORTS.map((v) => <option value={v}>{effortLabel(v)}</option>)}</select></div>{active && <select value={mode} onChange={(e) => setMode(e.currentTarget.value as any)} aria-label="Active turn behavior"><option value="queue">Queue</option><option value="steer">Steer</option><option value="replace">Replace…</option></select>}<button class={`send-button ${primaryIsStop ? "is-stop" : ""}`} disabled={readOnly || (primaryIsStop ? stopping : busy || !hasDraft)} onClick={() => void primaryAction()} aria-label={primaryIsStop ? stopping ? "Stopping task" : "Stop task" : busy ? "Sending" : "Send"}>{primaryIsStop ? <span class="stop-glyph" aria-hidden="true"/> : busy ? "…" : "↑"}</button></div></div>
    </div></div>;
}

function ApprovalCard({ approval, sessionId, onRefresh, setError }: { approval: Json; sessionId: string; onRefresh: () => void; setError: (e: ApiError) => void }) {
  const [feedback, setFeedback] = useState(""); const [busy, setBusy] = useState(false);
  const subject = approval.subject ?? {};
  const target = String(subject.command ?? subject.path ?? subject.target ?? approval.rawArgs ?? "Action details unavailable");
  const targetPreview = target.length > 220 ? `${target.slice(0, 217)}…` : target;
  const currentStage = Array.isArray(subject.stages) ? subject.stages.find((stage: Json) => stage.requirementId?.sourceIndex === approval.currentRequirementId?.sourceIndex) : null;
  const decide = async (choice: Json) => { setBusy(true); try { await api.decide(sessionId, String(approval.approvalId), { choiceId: choice.choiceId, requirementId: approval.currentRequirementId, ...(choice.acceptsFeedback && feedback ? { feedback } : {}) }); onRefresh(); } catch (e) { setError(normalize(e)); } finally { setBusy(false); } };
  return <article class="decision-card approval-card"><div class="decision-icon">!</div><div><span class="eyebrow">Permission required{approval.judgeEscalated ? " · Judge escalated" : ""}</span><h3>{approval.toolName ?? subject.kind ?? "Requested action"}</h3><code class="approval-target">{targetPreview}</code>{target.length > targetPreview.length && <details class="approval-full"><summary>View full action</summary><pre>{target}</pre></details>}{subject.stages && <p>Stage {currentStage?.position ?? (Number(approval.currentRequirementId?.sourceIndex ?? 0) + 1)} of {currentStage?.totalStages ?? subject.stages.length}</p>}<div class="choice-list">{(approval.availableChoices ?? []).map((choice: Json) => <button disabled={busy} onClick={() => void decide(choice)}><strong>{choice.label}</strong><small>{choice.scope}{choice.rulePreview ? ` · ${choice.rulePreview}` : ""}</small></button>)}</div>{(approval.availableChoices ?? []).some((c: Json) => c.acceptsFeedback) && <textarea value={feedback} onInput={(e) => setFeedback(e.currentTarget.value)} maxLength={500} placeholder="Optional feedback for a supported choice"/>}</div></article>;
}

function QuestionCard({ request, sessionId, onRefresh, setError }: { request: Json; sessionId: string; onRefresh: () => void; setError: (e: ApiError) => void }) {
  const [values, setValues] = useState<Record<string, string[]>>({}); const [free, setFree] = useState<Record<string, string>>({}); const [clarify, setClarify] = useState(""); const [busy, setBusy] = useState(false);
  const answer = async () => {
    const answers = (request.questions ?? []).map((q: Json) => free[q.id] ? { questionId: q.id, freeText: free[q.id] } : q.selection?.mode === "multiple" ? { questionId: q.id, selectedLabels: values[q.id] ?? [] } : { questionId: q.id, selectedLabel: values[q.id]?.[0] });
    for (let i = 0; i < request.questions.length; i++) { const q = request.questions[i], count = values[q.id]?.length ?? 0; if (!free[q.id] && q.selection?.mode === "multiple" && (count < (q.selection.min ?? q.selection.minSelections ?? 0) || count > (q.selection.max ?? q.selection.maxSelections ?? Infinity))) return setError(new ApiError("invalid_selection", `Choose the required number of options for “${q.header}”.`, false, "Adjust the selection and submit again.")); }
    setBusy(true); try { await api.answer(sessionId, request.userInputId, answers); onRefresh(); } catch (e) { setError(normalize(e)); } finally { setBusy(false); }
  };
  return <article class="decision-card question-card"><div class="decision-icon">?</div><div><span class="eyebrow">Input needed</span>{(request.questions ?? []).map((q: Json) => <fieldset><legend>{q.header}</legend><p>{q.question}</p><div class="options">{(q.options ?? []).map((option: Json) => { const checked = values[q.id]?.includes(option.label) ?? false; return <label><input type={q.selection?.mode === "multiple" ? "checkbox" : "radio"} name={q.id} checked={checked} onChange={() => setValues((all) => ({ ...all, [q.id]: q.selection?.mode === "multiple" ? checked ? (all[q.id] ?? []).filter((v) => v !== option.label) : [...(all[q.id] ?? []), option.label] : [option.label] }))}/><span><strong>{option.label}</strong><small>{option.description}{option.preview?.content ? ` · ${option.preview.content}` : ""}</small></span></label>})}</div><input class="free-answer" value={free[q.id] ?? ""} maxLength={500} onInput={(e) => setFree((all) => ({ ...all, [q.id]: e.currentTarget.value }))} placeholder="Or type an answer…"/></fieldset>)}<div class="question-actions"><button class="primary" disabled={busy} onClick={() => void answer()}>Submit answer</button><input value={clarify} maxLength={500} onInput={(e) => setClarify(e.currentTarget.value)} placeholder="Clarify instead…"/><button disabled={!clarify || busy} onClick={async () => { try { await api.clarify(sessionId, request.userInputId, clarify); onRefresh(); } catch (e) { setError(normalize(e)); } }}>Clarify</button><button disabled={busy} onClick={async () => { try { await api.cancelQuestion(sessionId, request.userInputId); onRefresh(); } catch (e) { setError(normalize(e)); } }}>Cancel</button></div></div></article>;
}

function Details({ sessionId, snapshot, tab, setTab, setError, onResize }: { sessionId: string; snapshot: SessionProjectionSnapshot; tab: DetailTab; setTab: (v: DetailTab) => void; setError: (e: ApiError) => void; onResize: (width: number) => void }) {
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null); const [diff, setDiff] = useState<DiffResult | null>(null); const [changesLoading, setChangesLoading] = useState(false); const [changesError, setChangesError] = useState(false);
  const loadChanges = async () => { setChangesLoading(true); setChangesError(false); try { setChanges(await api.changes(sessionId)); } catch (e) { setChanges(null); setChangesError(true); setError(normalize(e)); } finally { setChangesLoading(false); } };
  useEffect(() => { setChanges(null); setDiff(null); if (tab === "changes") void loadChanges(); }, [tab, sessionId]);
  const resize = (event: PointerEvent) => { event.preventDefault(); const move = (e: PointerEvent) => onResize(Math.max(290, Math.min(560, window.innerWidth - e.clientX))); const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); };
  return <aside class="details-pane"><div class="resize-handle" onPointerDown={resize as any} role="separator" aria-orientation="vertical" aria-label="Resize details pane" tabIndex={0}/><div class="detail-tabs" role="tablist">{(["overview","changes","activity"] as DetailTab[]).map((name) => <button role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name === "changes" ? "Changes" : capitalize(name)}</button>)}</div>{tab === "overview" && <Overview snapshot={snapshot}/>} {tab === "changes" && <div class="detail-content"><h3>Changes</h3><p class="truth-note">The complete list of files Git currently reports as staged, unstaged, untracked, renamed, or deleted. It includes changes made outside this task.</p><div class="change-summary" role="status"><span>{changesLoading ? "Checking project…" : changesError ? "Changes unavailable" : changes ? `${changes.files.length} changed ${changes.files.length === 1 ? "file" : "files"}` : "Not checked"}</span><button disabled={changesLoading} onClick={() => void loadChanges()}>Refresh</button></div>{changes?.branch && <Fact label="Branch" value={changes.branch}/>}<div class="change-list">{changes?.files.map((file) => <button onClick={async () => { try { setDiff(await api.diff(sessionId, file.path)); } catch (e) { setError(normalize(e)); } }}><span>{gitStatusLabel(file.status)}</span>{file.path}</button>)}</div>{changes && changes.files.length === 0 && <p class="muted">No uncommitted changes.</p>}{diff && <div class="diff-view"><DiffViewer result={diff} onClose={() => setDiff(null)}/></div>}</div>} {tab === "activity" && <Activity snapshot={snapshot}/>}</aside>;
}
function Overview({ snapshot }: { snapshot: SessionProjectionSnapshot }) {
  const session = snapshot.session, context = snapshot.state.contextUsage, usage = snapshot.state.tokenUsage;
  const branch = snapshot.state.branch?.branch;
  return <div class="detail-content"><section><h3>Task</h3><Fact label="Model" value={String(snapshot.state.model?.modelId ?? session.modelId ?? "Muse default")}/><Fact label="Permissions" value={modeLabel(effectiveMode(snapshot))}/>{branch && <Fact label="Branch" value={String(branch)}/>}</section>{snapshot.state.goal && <section><h3>Goal</h3><p>{String(snapshot.state.goal.objective ?? snapshot.state.goal.text ?? JSON.stringify(snapshot.state.goal))}</p></section>}{snapshot.state.todos && <section><h3>Todos</h3>{(snapshot.state.todos.items as Json[] ?? []).map((todo) => <div class="todo"><span>{todo.status === "completed" ? "✓" : "○"}</span>{todo.content ?? todo.text}</div>)}</section>}{(context || usage?.cumulative) && <section><h3>Usage</h3>{context && <><div class="usage-row"><span>Context</span><strong>{formatNumber(context.usedTokens)}{context.windowTokens ? ` / ${formatNumber(context.windowTokens)}` : ""}</strong></div>{context.windowTokens && <><div class="usage-bar"><span style={{ width: `${Math.min(100, Number(context.usedTokens) / Number(context.windowTokens) * 100)}%` }}/></div><small>{Math.round(Math.min(100, Number(context.usedTokens) / Number(context.windowTokens) * 100))}% used</small></>}</>}{usage?.cumulative && <Fact label="Total tokens" value={formatNumber(totalTokens(usage.cumulative as Json))}/>}</section>}{snapshot.state.queuedTurns.length > 0 && <section><h3>Queue</h3>{snapshot.state.queuedTurns.map((turn) => <div class="queue-row"><span>Queued task</span><button onClick={() => void api.unqueue(String(session.sessionId), String(turn.turnId))}>Unqueue</button></div>)}</section>}<details class="technical-details"><summary>Technical details</summary><div><Fact label="Provider" value={String(snapshot.state.model?.providerId ?? session.providerId ?? "Muse default")}/><Fact label="Workspace" value={String(session.workspaceRoot ?? "Unavailable")}/><Fact label="Created" value={formatDate(String(session.createdAt ?? ""))}/><Fact label="Updated" value={formatDate(String(session.updatedAt ?? ""))}/><Fact label="Lineage" value={String((session.forkedFrom as any)?.sessionId ?? session.forkedFrom ?? "Root session")}/><Fact label="Session ID" value={String(session.sessionId ?? "")}/></div></details></div>;
}
function Activity({ snapshot }: { snapshot: SessionProjectionSnapshot }) { const items = snapshot.items.filter((i) => ["toolCall","userShell","subagent","workflow","compaction"].includes(String(i.kind))); const groups = summarizeActivity(items); const retries = snapshot.turns.filter((t) => t.retry); const failures = authoritativeFailedTurns(snapshot); return <div class="detail-content"><h3>Activity</h3>{groups.map((group) => <div class={`audit-row ${group.failed ? "danger" : ""}`}><strong>{group.name}</strong><small>{group.count} {group.count === 1 ? "step" : "steps"}{group.failed ? ` · ${group.failed} failed` : ""}</small></div>)}{retries.map((turn) => <div class="audit-row attention"><strong>Retry {String((turn.retry as Json).nextAttempt)} / {String((turn.retry as Json).maxAttempts)}</strong><small>{String((turn.retry as Json).reason)}</small></div>)}{failures.map((turn) => <div class="audit-row danger"><strong>Turn {String(turn.state)}</strong><small>{String(turn.reason ?? "Muse did not provide a failure reason.")}</small></div>)}{!groups.length && !retries.length && !failures.length && <p class="muted">No activity yet.</p>}{snapshot.state.unknownEvents.length > 0 && <details class="technical-details"><summary>Unrecognized Muse events ({snapshot.state.unknownEvents.length})</summary><div>{snapshot.state.unknownEvents.map((event) => <div class="audit-row"><strong>{event.method}</strong><small>Preserved</small></div>)}</div></details>}</div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div class="fact"><span>{label}</span><strong title={value}>{value}</strong></div>; }

function NewTask({ projects, currentRoot, onClose, onCreate, setError }: { projects: ProjectSummary[]; currentRoot?: string; onClose: () => void; onCreate: (r: any) => void; setError: (e: ApiError) => void }) {
  const roots = [...new Set([currentRoot, ...projects.map((p) => p.workspaceRoot)].filter(Boolean))] as string[];
  const [root, setRoot] = useState(roots[0] ?? ""); const [advanced, setAdvanced] = useState(roots.length === 0); const [valid, setValid] = useState<any>(null); const [busy, setBusy] = useState(false);
  const validate = async () => { try { setValid(await api.openWorkspace(root)); } catch (e) { setValid(null); setError(normalize(e)); } };
  const create = async () => { setBusy(true); try { const opened = valid?.canonicalPath ? valid : await api.openWorkspace(root); onCreate(await api.newSession(opened.canonicalPath, null, "promptUnmatched")); } catch (e) { setError(normalize(e)); } finally { setBusy(false); } };
  return <Dialog title="Start a new task" onClose={onClose}><div class="dialog-body"><p class="dialog-intro">Choose a recent project, or open another folder by path.</p>{roots.length > 0 && <div class="project-choices">{roots.map((path) => <button class={root === path && !advanced ? "selected" : ""} onClick={() => { setRoot(path); setAdvanced(false); setValid({ canonicalPath: path }); }}><span><strong>{folderName(path)}</strong><small>{path}</small></span><span>→</span></button>)}</div>}<button class="disclosure" onClick={() => { setAdvanced(!advanced); setValid(null); }}>› Open another project</button>{advanced && <div class="advanced-path"><label>Absolute folder path<input value={root} onInput={(e) => { setRoot(e.currentTarget.value); setValid(null); }} placeholder="/Users/you/Projects/app"/></label><button onClick={() => void validate()}>Validate</button>{valid && <span class="valid">✓ {valid.name}</span>}<p>Enter the path to a folder on this computer.</p></div>}<div class="dialog-actions"><button onClick={onClose}>Cancel</button><button class="primary" disabled={!root || busy} onClick={() => void create()}>{busy ? "Starting…" : "Start task"}</button></div></div></Dialog>;
}
function RenameTask({ session, onClose, onRenamed, setError }: { session: SessionSummary; onClose: () => void; onRenamed: (result: { sessionId: string; title: string }) => void; setError: (e: ApiError) => void }) { const [title,setTitle]=useState(session.title);const [busy,setBusy]=useState(false);const save=async()=>{setBusy(true);try{onRenamed(await api.renameTask(session.sessionId,title));}catch(e){setError(normalize(e));}finally{setBusy(false);}};return <Dialog title="Rename task" onClose={onClose}><div class="dialog-body"><label class="rename-field">Task name<input autoFocus value={title} maxLength={100} onInput={(e)=>setTitle(e.currentTarget.value)} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.isComposing)void save();}}/></label><p class="muted">This is a mortiφ label. The Muse session, history, and ID stay unchanged.</p><div class="dialog-actions"><button onClick={onClose}>Cancel</button><button class="primary" disabled={!title.trim()||busy} onClick={()=>void save()}>{busy?"Saving…":"Save"}</button></div></div></Dialog>;}
function RemoveTask({ session, onClose, onRemoved, setError }: { session: SessionSummary; onClose: () => void; onRemoved: (sessionId: string) => void; setError: (e: ApiError) => void }) { const [busy,setBusy]=useState(false);const remove=async()=>{setBusy(true);try{await api.removeTask(session.sessionId);onRemoved(session.sessionId);}catch(e){setError(normalize(e));}finally{setBusy(false);}};return <Dialog title="Remove task?" onClose={onClose}><div class="dialog-body"><p><strong>{session.title}</strong> will disappear from mortiφ on this Mac.</p><p class="truth-note">Muse does not expose session deletion through MSP. Its underlying session history will not be erased.</p><div class="dialog-actions"><button onClick={onClose}>Cancel</button><button class="danger-button" disabled={busy||session.status!=="idle"} onClick={()=>void remove()}>{busy?"Removing…":"Remove task"}</button></div>{session.status!=="idle"&&<p class="muted">Stop or settle this task before removing it.</p>}</div></Dialog>;}
function Settings({ onClose }: { onClose: () => void }) { const [theme, setTheme] = useState(localStorage.getItem("mortiphi:theme") ?? "system"); const choose = (value: string) => { setTheme(value); localStorage.setItem("mortiphi:theme", value); document.documentElement.dataset.theme = value; }; return <Dialog title="Settings" onClose={onClose}><div class="dialog-body"><h3>Appearance</h3><div class="segmented">{["light","dark","system"].map((v) => <button class={theme === v ? "selected" : ""} onClick={() => choose(v)}>{capitalize(v)}</button>)}</div></div></Dialog>; }
function ModelPicker({ sessionId, onClose, onSelect, setError }: { sessionId: string | null; onClose: () => void; onSelect: () => void; setError: (e: ApiError) => void }) { const [models,setModels]=useState<Json[]>([]); const [q,setQ]=useState(""); useEffect(()=>{void api.models(sessionId ?? undefined).then((r)=>setModels(r.models ?? [])).catch((e)=>setError(normalize(e)));},[sessionId]); const visible=models.filter((m)=>`${m.displayLabel} ${m.modelId} ${m.providerId}`.toLowerCase().includes(q.toLowerCase())); return <Dialog title="Models" onClose={onClose} width="720px"><div class="dialog-body"><input autoFocus class="search" value={q} onInput={(e)=>setQ(e.currentTarget.value)} placeholder="Search models…"/><div class="model-list">{visible.map((model)=><button class={model.isActive?"selected":""} onClick={async()=>{if(!sessionId)return;try{await api.setModel(sessionId,{modelId:model.modelId,providerId:model.providerId,profileId:model.profileId,displayLabel:model.displayLabel});onSelect();onClose();}catch(e){setError(normalize(e));}}}><span><strong>{model.displayLabel}</strong><small>{model.providerId} · {model.contextLimit ? `${formatNumber(model.contextLimit)} context` : "context unknown"}</small></span><span>{model.isActive?"Active":model.isDefault?"Default":""}</span></button>)}</div></div></Dialog>; }
function PermissionPicker({ sessionId, value, onClose, onSelect, setError }: { sessionId: string | null; value: string; onClose: () => void; onSelect: () => void; setError: (e: ApiError) => void }) { return <Dialog title="Permissions" onClose={onClose}><div class="dialog-body"><p class="dialog-intro">These map one-to-one to Muse approval modes. They do not create or edit policy.</p><div class="picker-list">{MODES.map((mode)=><button class={mode.value===value?"selected":""} disabled={!sessionId} onClick={async()=>{if(!sessionId)return;try{await api.setMode(sessionId,mode.value);onSelect();onClose();}catch(e){setError(normalize(e));}}}><span><strong>{mode.label}</strong><small>{mode.detail}</small></span><code>{mode.value}</code></button>)}</div></div></Dialog>; }
function EffortPicker({ onClose }: { onClose: () => void }) { const [value,setValue]=useState(localStorage.getItem("mortiphi:effort")??"high"); return <Dialog title="Reasoning effort" onClose={onClose}><div class="dialog-body"><p class="dialog-intro">This controls how much reasoning Muse uses when you send a prompt.</p><div class="picker-list">{EFFORTS.map((effort)=><button class={effort===value?"selected":""} onClick={()=>{setValue(effort);localStorage.setItem("mortiphi:effort",effort);onClose();}}><strong>{effort}</strong><small>{effort==="none"?"Fastest, no reasoning budget":effort==="ultra"?"Largest Muse reasoning tier":"Exact Muse tier"}</small></button>)}</div></div></Dialog>; }
function Help({ actions, onClose, onCommand }: { actions: ActionDefinition[]; onClose: () => void; onCommand: (id: string) => void }) { return <Dialog title="Commands and controls" onClose={onClose} width="760px"><div class="dialog-body"><p class="dialog-intro">Every command has a visible GUI home. Unknown slash input is sent unchanged to Muse.</p><div class="help-table">{actions.map((action)=><button onClick={()=>{onClose();void onCommand(action.id);}}><code>{action.command}</code><span><strong>{action.label}</strong><small>{action.description}</small></span><span><em>{action.source}</em><small>{action.gui}</small></span></button>)}</div></div></Dialog>; }

function groupProjects(sessions: SessionSummary[]): ProjectSummary[] { const map=new Map<string,ProjectSummary>(); for(const session of sessions){const root=session.workspaceRoot||`unavailable:${session.sessionId}`;if(!map.has(root))map.set(root,{workspaceRoot:root,name:session.workspaceRoot?folderName(root):"Unavailable workspace",available:Boolean(session.workspaceRoot),sessions:[]});map.get(root)!.sessions.push(session);}return [...map.values()]; }
function normalize(error: unknown) { return error instanceof ApiError ? error : new ApiError("unexpected_error", error instanceof Error ? error.message : String(error), true, "Retry. If it persists, restart mortiφ."); }
function folderName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"; }
function titleFrom(items: Json[]) { const item=items.find((i)=>i.kind==="userMessage"&&!i.retracted); return item?.text ? String(item.text).replace(/\s+/g," ").slice(0,68) : "New task"; }
function gitStatusLabel(status: string) { const value=status.trim();if(status==="??")return "New";if(value.includes("R"))return "Renamed";if(value.includes("D"))return "Deleted";if(value.includes("A"))return "Added";if(value.includes("M"))return "Modified";if(value.includes("C"))return "Copied";return value||"Changed"; }
function formatDate(value: string) { const date=new Date(value); return Number.isFinite(date.getTime())?date.toLocaleString():"Unavailable"; }
function formatNumber(value: unknown) { const number=Number(value??0); return Number.isFinite(number)?new Intl.NumberFormat("en",{notation:number>9999?"compact":"standard"}).format(number):"—"; }
function totalTokens(value: Json) { return Object.values(value).filter((v)=>typeof v==="number").reduce<number>((a,b)=>a+(b as number),0); }
function capitalize(value: string) { return value.charAt(0).toUpperCase()+value.slice(1); }
function effortLabel(value: ReasoningEffort) { return value === "xhigh" ? "XHigh" : capitalize(value); }
function modeLabel(value: string) { return MODES.find((m)=>m.value===value)?.label ?? value ?? "Muse default"; }
function effectiveMode(snapshot: SessionProjectionSnapshot | null) { return String(snapshot?.state.approvalMode?.mode ?? (snapshot?.session.approvalMode as Json)?.mode ?? "promptUnmatched"); }
function authoritativeFailedTurns(snapshot: SessionProjectionSnapshot) { return snapshot.turns.filter((turn)=>FAILED_TURN_STATES.has(String(turn.state))); }
function sessionState(snapshot: SessionProjectionSnapshot) { if(snapshot.state.connection!=="connected")return "failed";if(snapshot.state.activeTurnId)return "running";if(snapshot.pending.approvals.length||snapshot.pending.userInputs.length)return "waiting";if(snapshot.state.queuedTurns.length)return "queued";if(authoritativeFailedTurns(snapshot).length)return "failed";return "idle"; }
function isNearBottom(el: HTMLElement, tolerance = 48) { return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance; }
function firstVisibleItemId(container: HTMLElement) {
  const top = container.getBoundingClientRect().top;
  const nodes = container.querySelectorAll("[data-item-id]");
  for (const node of nodes) if (node.getBoundingClientRect().bottom > top) return node.getAttribute("data-item-id");
  return null;
}
function findAnchorItem(container: HTMLElement | null, anchor: string) {
  if (!container) return null;
  const nodes = container.querySelectorAll("[data-item-id]");
  for (const node of nodes) if (node.getAttribute("data-item-id") === anchor) return node;
  return null;
}
function transcriptBlocks(items: Json[]): TranscriptBlock[] { const raw: TranscriptBlock[]=[];for(const [index,item] of items.entries()){const turnId=typeof item.turnId==="string"?item.turnId:null;const previous=raw.at(-1);if(previous&&previous.turnId===turnId)previous.items.push(item);else raw.push({key:`${turnId??"session"}:${index}`,turnId,items:[item]});}const blocks: TranscriptBlock[]=[];for(const block of raw){const previous=blocks.at(-1);const previousPrompt=previous?.items.find((item)=>item.kind==="userMessage");const nextPrompt=block.items.find((item)=>item.kind==="userMessage");const previousAnswered=previous?.items.some((item)=>item.kind==="agentMessage");if(previous&&previousPrompt&&nextPrompt&&!previousAnswered&&normalizedPrompt(previousPrompt.text)===normalizedPrompt(nextPrompt.text)){previous.items.push(...block.items);previous.turnId=block.turnId;continue;}blocks.push(block);}return blocks; }
function normalizedPrompt(value: unknown) { return String(value??"").trim().replace(/\s+/g," "); }
function activityName(item: Json) { if(item.kind==="reasoning")return "Reasoning";if(item.kind==="compaction")return "Context compacted";if(item.kind==="toolCall"||item.kind==="userShell")return String(item.tool??(item.kind==="userShell"?"Shell":"Tool"));if(item.kind==="subagent")return "Subagent";if(item.kind==="workflow")return "Workflow";return String(item.kind??"Activity"); }
function summarizeActivity(items: Json[]) { const groups=new Map<string,{name:string;count:number;failed:number}>();for(const item of items){const name=activityName(item);const current=groups.get(name)??{name,count:0,failed:0};current.count++;if(item.status==="failed")current.failed++;groups.set(name,current);}return [...groups.values()]; }
function fileBase64(file: File) { return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);}); }
function eventAnnouncement(event: Json) { if(event.method==="turn/completed")return `Muse turn ${event.params?.terminal??"completed"}.`;if(event.method==="turn/retracted")return "Prompt retracted and restored to the composer.";if(event.method.startsWith("approval/"))return "Muse needs permission.";if(event.method.startsWith("userInput/"))return "Muse has a question.";return "Muse state updated."; }
function applyIncrementalEvent(event: Json, setSnapshot: (update: (prev: SessionProjectionSnapshot | null) => SessionProjectionSnapshot | null) => void) {
  const turnId = typeof (event.params as Json)?.turnId === "string" ? (event.params as Json).turnId as string : null;
  if (!turnId) return;
  if (event.method === "turn/started") setSnapshot((prev) => prev ? { ...prev, state: { ...prev.state, activeTurnId: turnId } } : prev);
  else if (event.method === "turn/completed" || event.method === "turn/retracted" || event.method === "turn/unqueued") {
    setSnapshot((prev) => prev && prev.state.activeTurnId === turnId ? { ...prev, state: { ...prev.state, activeTurnId: null } } : prev);
  }
}
function liveActivityLabel(item?: Json) { if(!item)return "Working";if(item.kind==="reasoning")return item.status==="inProgress"?"Reasoning":"Continuing";if(item.kind==="agentMessage")return item.status==="inProgress"?"Writing a response":"Finishing";if(item.kind==="toolCall"||item.kind==="userShell"){const name=String(item.tool??item.kind);return item.status==="inProgress"?`Running ${name}`:`Finished ${name}; continuing`;}if(item.kind==="subagent"||item.kind==="workflow")return `${capitalize(String(item.kind))} ${item.status??"running"}`;return "Working"; }
function latestLiveItem(snapshot: SessionProjectionSnapshot) { const activeId=snapshot.state.activeTurnId;return [...snapshot.items].reverse().find((item)=>item.turnId===activeId&&["reasoning","toolCall","userShell","agentMessage","subagent","workflow"].includes(String(item.kind))); }
function transientStage(snapshot: SessionProjectionSnapshot, state: string) { if(state==="waiting")return snapshot.pending.approvals.length?"approval":"question";if(state==="queued")return "next";if(state!=="running")return null;const item=latestLiveItem(snapshot);if(!item)return "starting";if(item.kind==="reasoning")return "reasoning";if(item.kind==="agentMessage")return "writing";if(item.kind==="userShell")return "shell";if(item.kind==="toolCall")return String(item.tool??"tool").replaceAll("_"," ");if(item.kind==="subagent")return "subagent";if(item.kind==="workflow")return "workflow";return null; }

document.documentElement.dataset.theme = localStorage.getItem("mortiphi:theme") ?? "system";
const root = document.getElementById("app")!;
render(<App />, root);
if (import.meta.hot) import.meta.hot.dispose(() => { render(null, root); root.replaceChildren(); });
