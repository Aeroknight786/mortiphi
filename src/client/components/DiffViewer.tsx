import { diffStats, parseUnifiedDiff } from "../diff";

export interface DiffResult {
  path: string;
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  message?: string;
}

export function DiffViewer({ result, onClose }: { result: DiffResult; onClose?: () => void }) {
  const content = result.message ?? result.diff ?? "";
  const stats = diffStats(result.diff ?? "");
  const lines = parseUnifiedDiff(content);
  return <section class="diff-review" aria-label={`Diff for ${result.path}`}>
    <header class="diff-header"><strong title={result.path}>{result.path}</strong><span class="diff-count additions">+{stats.additions}</span><span class="diff-count deletions">−{stats.deletions}</span>{onClose && <button onClick={onClose} aria-label="Close diff">×</button>}</header>
    {result.binary ? <div class="diff-empty">Binary files cannot be previewed.</div> : result.truncated ? <div class="diff-empty">This preview is limited because the file is large.</div> : lines.length === 0 || !content ? <div class="diff-empty">No text diff is available.</div> : <div class="diff-lines" role="table" aria-label="Unified diff">{lines.map((line, index) => <div class={`diff-line ${line.kind}`} role="row" key={`${index}:${line.text}`}><span class="line-number" role="cell">{line.oldNumber ?? ""}</span><span class="line-number" role="cell">{line.newNumber ?? ""}</span><code role="cell">{line.text || " "}</code></div>)}</div>}
  </section>;
}
