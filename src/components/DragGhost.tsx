import { useEffect, useRef } from "react";

interface DragGhostProps {
  activeNodeType: string | null;
}

/**
 * Renders a floating label that follows the cursor during a drag operation.
 *
 * Position updates are applied directly to the DOM via a ref — no React
 * state is touched on every mousemove frame, so neither App nor ReactFlow are
 * re-rendered during the drag.
 */
export function DragGhost({ activeNodeType }: DragGhostProps) {
  const ghostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeNodeType) return;

    const onMove = (e: MouseEvent) => {
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${e.clientX + 18}px, ${e.clientY + 14}px)`;
      }
    };

    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [activeNodeType]);

  if (!activeNodeType) return null;

  return (
    <div
      ref={ghostRef}
      className="fixed top-0 left-0 pointer-events-none z-[9999] rounded-[10px] border border-slate-400/60 bg-slate-900/95 px-3 py-2 text-xs font-semibold text-slate-200 shadow-[0_12px_28px_rgba(15,23,42,0.45)]"
      style={{ willChange: "transform" }}
    >
      {activeNodeType}
    </div>
  );
}
