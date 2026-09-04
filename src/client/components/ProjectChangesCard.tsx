import { useEffect, useState } from "preact/hooks";
import type { WorkspaceChanges } from "../../shared/contracts";
import { api, type ApiError } from "../api";
import { DiffViewer, type DiffResult } from "./DiffViewer";

export function ProjectChangesCard({ sessionId, refreshKey, active, paths, onError }: { sessionId: string; refreshKey: string; active: boolean; paths: string[]; onError: (error: ApiError) => void }) {
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    if (active) return;
    let cancelled = false;
    void api.changes(sessionId).then((value) => { if (!cancelled) setChanges(value); }).catch(() => { if (!cancelled) setChanges(null); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, active]);

  const choose = async (path: string) => {
    setSelected(path); setDiff(null); setLoadingDiff(true);
    try { setDiff(await api.diff(sessionId, path)); }
    catch (error) { onError(error as ApiError); }
    finally { setLoadingDiff(false); }
  };
  const files = changes?.files.filter((file) => paths.includes(file.path)) ?? [];
  const openReview = () => { const first = selected || files[0]?.path; if (!first) return; setReviewing(true); void choose(first); };
  const toggleReview = () => {
    if (reviewing) { setReviewing(false); setDiff(null); return; }
    openReview();
  };
  if (active || !files.length) return null;

  return <section class="project-changes-card">
    <header><div><strong>{files.length === 1 ? "File changed" : `${files.length} files changed`}</strong><small>Changed in this turn · current working tree</small></div><button onClick={toggleReview}>{reviewing ? "Close" : "Review"}</button></header>
    {(!reviewing || files.length > 1) && <div class="project-change-files">{files.slice(0, 3).map((file) => <button class={reviewing && selected === file.path ? "selected" : ""} onClick={() => { setReviewing(true); void choose(file.path); }}><b>{statusLabel(file.status)}</b><span>{file.path}</span></button>)}{files.length > 3 && <small>+{files.length - 3} more</small>}</div>}
    {reviewing && <div class="conversation-diff">{loadingDiff ? <div class="diff-empty">Loading diff…</div> : diff && <DiffViewer result={diff}/>}</div>}
  </section>;
}

function statusLabel(status: string) { const value=status.trim();if(status==="??")return "New";if(value.includes("R"))return "Renamed";if(value.includes("D"))return "Deleted";if(value.includes("A"))return "Added";if(value.includes("M"))return "Modified";if(value.includes("C"))return "Copied";return value||"Changed"; }
