import { useEffect, useRef } from "preact/hooks";

export function useDismissableLayer<T extends HTMLElement>(open: boolean, onDismiss: () => void) {
  const ref = useRef<T>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => target instanceof Node && Boolean(ref.current) && !ref.current!.contains(target);
    const pointer = (event: PointerEvent) => { if (outside(event.target)) dismiss.current(); };
    const focus = (event: FocusEvent) => { if (outside(event.target)) dismiss.current(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return ref;
}
