import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

export function Dialog({ title, onClose, children, width = "560px" }: { title: string; onClose: () => void; children: ComponentChildren; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>("button,input,select,textarea,[tabindex='0']")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex='0']")];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [onClose]);
  return <div class="modal-backdrop" onClick={(e) => e.currentTarget === e.target && onClose()}><div class="dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title" style={{ maxWidth: width }}><header><h2 id="dialog-title">{title}</h2><button class="icon-button" onClick={onClose} aria-label="Close dialog">×</button></header>{children}</div></div>;
}
