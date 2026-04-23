import React from "react";
import { Handle, NodeProps, Position } from "reactflow";
import { PlotNode as PlotNodeType, BranchPointNode } from "../types/plot";

type PlotNodeData = {
  node: PlotNodeType;
  isSelected: boolean;
  isActiveGenNode?: boolean;
};

const nodeTypeColor: Record<PlotNodeType["type"], string> = {
  Act: "#f97316",
  Route: "#06b6d4",
  Scene: "#84cc16",
  Event: "#ef4444",
  BranchPoint: "#8b5cf6",
};

export const PlotNode = React.memo(function PlotNode({ data }: NodeProps<PlotNodeData>) {
  const node = data.node;
  const isScene = node.type === "Scene";
  const isBranchPoint = node.type === "BranchPoint";

  return (
    <div
      className={`min-w-[220px] rounded-xl border bg-slate-900/95 p-3 text-slate-100 shadow-xl transition-all duration-300 ${data.isActiveGenNode ? "animate-pulse" : ""}`}
      style={{
        borderColor: data.isActiveGenNode ? "#a855f7" : data.isSelected ? "#f59e0b" : "#334155",
        boxShadow: data.isActiveGenNode ? "0 0 15px rgba(168, 85, 247, 0.6)" : `0 0 0 2px ${data.isSelected ? "rgba(245,158,11,0.25)" : "transparent"}`,
      }}
    >
      <Handle type="target" position={Position.Left} id="in" className="!h-3 !w-3 !bg-amber-400" />
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded-md px-2 py-1 text-xs font-semibold" style={{ backgroundColor: nodeTypeColor[node.type] }}>
          {node.type}
        </span>
        <span className="text-[11px] text-slate-400">{node.id}</span>
      </div>

      <div className="text-sm font-semibold">{node.name}</div>
      <div className="mt-1 text-xs text-slate-300">Tags: {node.layerTags.join(", ") || "none"}</div>

      {isScene ? (
        <div className="mt-2 rounded-lg border border-slate-700/70 bg-slate-800/70 p-2 text-xs">
          <div>Default Out</div>
          <Handle type="source" position={Position.Right} id="default" className="!h-3 !w-3 !bg-emerald-400" />
        </div>
      ) : isBranchPoint ? (
        <div className="mt-2 rounded-lg border border-slate-700/70 bg-slate-800/70 p-2 text-xs">
          <div>Choices</div>
          {(node as BranchPointNode).parameters.choices.map((choice, index) => (
            <div key={choice.id} className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate">{choice.text || `Choice ${index + 1}`}</span>
              <Handle
                type="source"
                position={Position.Bottom}
                id={`choice:${choice.id}`}
                style={{ left: `${25 + index * 18}%` }}
                className="!h-3 !w-3 !bg-violet-400"
              />
            </div>
          ))}
        </div>
      ) : (
        <Handle type="source" position={Position.Right} id="out" className="!h-3 !w-3 !bg-emerald-400" />
      )}
    </div>
  );
});
