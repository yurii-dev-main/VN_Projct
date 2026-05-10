import React from "react";
import { Handle, NodeProps, Position } from "reactflow";
import { PlotNode as PlotNodeType, BranchPointNode, RouteNode } from "../types/plot";

type PlotNodeData = {
  node: PlotNodeType;
  isSelected: boolean;
  isActiveGenNode?: boolean;
  isSearchActive?: boolean;
};

const nodeTypeColor: Record<PlotNodeType["type"], string> = {
  Act: "#f97316",
  Route: "#06b6d4",
  Scene: "#84cc16",
  Event: "#ef4444",
  BranchPoint: "#8b5cf6",
};

// Helper: determine if text should be light or dark based on background color brightness
const getContrastColor = (hexColor: string): string => {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  // Calculate luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1f2937" : "#f3f4f6"; // dark gray or light gray
};

export const PlotNode = React.memo(function PlotNode({ data }: NodeProps<PlotNodeData>) {
  const node = data.node;
  const isScene = node.type === "Scene";
  const isBranchPoint = node.type === "BranchPoint";
  const isRoute = node.type === "Route";
  
  // Extract custom color from Route node if present
  let customColor: string | undefined;
  let headerTextColor: string | undefined;

  if (isRoute) {
    const routeNode = node as RouteNode;
    const routeColor = routeNode.parameters.color;
    if (routeColor && routeColor !== "#06b6d4") {
      customColor = routeColor;
      headerTextColor = getContrastColor(routeColor);
    }
  }

  return (
    <div
      className={`min-w-[220px] rounded-xl border bg-slate-900 p-3 shadow-xl transition-all duration-300 ${data.isActiveGenNode ? "animate-pulse" : ""}`}
      style={{
        // keep the main body dark for readability; only apply a colored left border and subtle glow
        color: "#f1f5f9",
        borderColor: data.isSearchActive ? "#0ea5e9" : data.isActiveGenNode ? "#a855f7" : data.isSelected ? "#f59e0b" : "#334155",
        borderWidth: "1px",
        borderLeft: customColor ? `4px solid ${customColor}` : undefined,
        boxShadow: data.isSearchActive
          ? "0 0 20px rgba(6, 182, 212, 0.8), 0 0 40px rgba(6, 182, 212, 0.4)"
          : data.isActiveGenNode
            ? "0 0 15px rgba(168, 85, 247, 0.6)"
            : customColor
              ? `0 0 8px ${customColor}22`
              : `0 0 0 2px ${data.isSelected ? "rgba(245,158,11,0.25)" : "transparent"}`,
      }}
    >
      <Handle type="target" position={Position.Left} id="in" className="!h-3 !w-3 !bg-amber-400" />
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="rounded-md px-2 py-1 text-xs font-semibold"
          style={{
            backgroundColor: isRoute && customColor ? customColor : nodeTypeColor[node.type],
            color: isRoute && headerTextColor ? headerTextColor : undefined,
          }}
        >
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
