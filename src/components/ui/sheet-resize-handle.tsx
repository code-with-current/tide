import { useCallback, useRef } from "react";
import { useUi } from "@/lib/stores/ui";

export function SheetResizeHandle() {
  const setSheetWidth = useUi((s) => s.setSheetWidth);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const sheet = e.currentTarget.closest('[data-slot="sheet-content"]') as HTMLElement | null;
      const prevTransition = sheet?.style.transition;
      if (sheet) sheet.style.transition = "none";
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return;
        setSheetWidth(((window.innerWidth - ev.clientX) / window.innerWidth) * 100);
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (sheet) sheet.style.transition = prevTransition ?? "";
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setSheetWidth]
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="absolute top-0 -left-1 z-50 h-full w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
    />
  );
}
