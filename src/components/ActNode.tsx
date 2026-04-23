import React from "react";
import { Handle, NodeProps, Position } from "reactflow";
import { ActNode as ActNodeType } from "../types/plot";

type ActNodeData = {
  node: ActNodeType;
  isSelected: boolean;
  isActiveGenNode?: boolean;
};

export const ActNode = React.memo(function ActNode({ data }: NodeProps<ActNodeData>) {
  const node = data.node;
  const overrideCount = node.parameters.overrides.length;
  const isStart = node.parameters.isStart;

  return (
    <div
      className={`min-w-[320px] rounded-2xl border-2 px-4 py-3 text-slate-50 shadow-2xl transition-all duration-300 ${data.isActiveGenNode ? "animate-pulse" : ""}`}
      style={{
        borderColor: data.isActiveGenNode ? "#f472b6" : isStart ? "#10b981" : data.isSelected ? "#facc15" : "#7c3aed",
        background:
          "linear-gradient(135deg, rgba(88,28,135,0.98) 0%, rgba(67,56,202,0.96) 55%, rgba(30,41,59,0.96) 100%)",
        boxShadow: data.isActiveGenNode
          ? "0 0 20px rgba(244, 114, 182, 0.7), 0 18px 40px rgba(76,29,149,0.5)"
          : isStart
          ? "0 0 0 3px rgba(16,185,129,0.35), 0 18px 40px rgba(76,29,149,0.35)"
          : data.isSelected
            ? "0 0 0 2px rgba(250,204,21,0.25)"
            : "0 18px 40px rgba(76,29,149,0.35)",
      }}
    >
      <Handle type="target" position={Position.Left} id="in" className="!h-3 !w-3 !bg-amber-300" />
      <Handle type="source" position={Position.Right} id="out" className="!h-3 !w-3 !bg-amber-300" />

      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-amber-300/60 bg-amber-300/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-200">
              Act
            </div>
            {isStart ? (
              <div className="inline-flex items-center rounded-full border border-green-400/60 bg-green-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-green-300">
                START
              </div>
            ) : null}
          </div>
          <div className="mt-2 text-xl font-black tracking-tight">{node.name}</div>
          <div className="mt-1 text-xs text-violet-100/80">{node.parameters.title}</div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-right">
          <div className="text-[10px] uppercase tracking-[0.18em] text-violet-200/70">Overrides</div>
          <div className="text-2xl font-black text-amber-200">{overrideCount}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-violet-100/80">
        <span className="rounded-full bg-black/20 px-2 py-1">Order {node.parameters.order}</span>
        <span className="rounded-full bg-black/20 px-2 py-1">Flags {node.parameters.requiredFlags.length}</span>
      </div>

      {node.parameters.description ? <div className="mt-3 text-sm text-violet-50/85">{node.parameters.description}</div> : null}
    </div>
  );
});