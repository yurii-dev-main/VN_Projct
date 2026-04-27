import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import ReactFlow, {
  Background,
  Connection,
  Controls,
  Edge,
  MiniMap,
  Node as FlowNode,
  OnConnect,
  ReactFlowInstance,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { ActNode as ActNodeView } from "./components/ActNode";
import { DragGhost } from "./components/DragGhost";
import { EventInspector } from "./components/EventInspector";
import { PlotNode as PlotNodeView } from "./components/PlotNode";
import { ProjectSelector } from "./components/ProjectSelector";
import { RouteInspector } from "./components/RouteInspector";
import { createDefaultNode, defaultProject } from "./data/defaultProject";
import { ActNode, BranchChoice, BranchPointNode, DialogueVariant, EventNode, NodeOverride, PlotNode, PlotNodeType, PlotProject, RouteNode, SceneNode } from "./types/plot";
import { sanitizeNodeForAI } from "./utils/aiExport";

type ContextMenuState =
  | { kind: "node"; nodeId: string; x: number; y: number }
  | { kind: "edge"; edgeId: string; x: number; y: number }
  | null;

const nodeTypes = {
  actNode: ActNodeView,
  plotNode: PlotNodeView,
};

const dedupe = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
const cloneProject = (project: PlotProject): PlotProject => JSON.parse(JSON.stringify(project)) as PlotProject;
const defaultProjectSnapshot = cloneProject(defaultProject);
const normalizeProject = (project: Partial<PlotProject>): PlotProject => ({
  ...defaultProjectSnapshot,
  ...project,
  meta: {
    ...defaultProjectSnapshot.meta,
    ...(project.meta || {}),
  },
  globalStylePrompt: project.globalStylePrompt ?? "",
  nodes: project.nodes ?? defaultProjectSnapshot.nodes,
  acts: project.acts ?? defaultProjectSnapshot.acts,
  routes: project.routes ?? defaultProjectSnapshot.routes,
  startNodeId: project.startNodeId ?? defaultProjectSnapshot.startNodeId,
  characters: project.characters ?? defaultProjectSnapshot.characters,
  locations: project.locations ?? defaultProjectSnapshot.locations,
  globalFlags: project.globalFlags ?? defaultProjectSnapshot.globalFlags,
  layerPresets: project.layerPresets ?? defaultProjectSnapshot.layerPresets,
  lore: project.lore ?? defaultProjectSnapshot.lore,
});
const getPrimaryLayer = (node: PlotNode): string => node.layerTags[0] ?? "ungrouped";
const equalStringArrays = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const createSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const validateConsistency = (project: PlotProject): string[] => {
  const ids = new Set(Object.keys(project.nodes));
  const issues: string[] = [];

  Object.values(project.nodes).forEach((node) => {
    node.connectedTo.forEach((nextId) => {
      if (!ids.has(nextId)) {
        issues.push(`${node.id}: connectedTo has missing node ${nextId}`);
      }
    });

    node.connectedFrom.forEach((prevId) => {
      if (!ids.has(prevId)) {
        issues.push(`${node.id}: connectedFrom has missing node ${prevId}`);
      }
    });

    if (node.type === "Scene") {
      const scene = node as SceneNode;

      if (scene.parameters.defaultNextNode && !ids.has(scene.parameters.defaultNextNode)) {
        issues.push(`${node.id}: defaultNextNode points to missing node ${scene.parameters.defaultNextNode}`);
      }

      scene.parameters.dialogueVariants.forEach((variant) => {
        if (variant.nextNode && !ids.has(variant.nextNode)) {
          issues.push(`${node.id}: dialogue variant ${variant.id} points to missing node ${variant.nextNode}`);
        }
      });
    }
  });

  project.acts.forEach((actId) => {
    if (!ids.has(actId)) {
      issues.push(`acts contains missing node ${actId}`);
    }
  });

  project.routes.forEach((routeId) => {
    if (!ids.has(routeId)) {
      issues.push(`routes contains missing node ${routeId}`);
    }
  });

  return issues;
};

// ─────────────────────────────────────────────────────────────────────────────
//  ProjectEditor — the full graph / lore editor bound to a specific file path
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectEditorProps {
  projectPath: string;
  projectName: string;
  onBack: () => void;
}

interface GraphCanvasProps {
  flowNodes: FlowNode[];
  flowEdges: Edge[];
  onInit: (instance: ReactFlowInstance) => void;
  onConnect: OnConnect;
  onNodeDragStop: (event: React.MouseEvent, node: FlowNode) => void;
  onNodeClick: (event: React.MouseEvent, node: FlowNode) => void;
  onSelectionChange: (selection: { nodes: FlowNode[]; edges: Edge[] }) => void;
  onNodeContextMenu: (event: React.MouseEvent, node: FlowNode) => void;
  onEdgeContextMenu: (event: React.MouseEvent, edge: Edge) => void;
  onPaneClick: () => void;
}

const GraphCanvas = memo(function GraphCanvas({
  flowNodes,
  flowEdges,
  onInit,
  onConnect,
  onNodeDragStop,
  onNodeClick,
  onSelectionChange,
  onNodeContextMenu,
  onEdgeContextMenu,
  onPaneClick,
}: GraphCanvasProps) {
  const [canvasNodes, setCanvasNodes, onCanvasNodesChange] = useNodesState(flowNodes);

  useEffect(() => {
    setCanvasNodes(flowNodes);
  }, [flowNodes, setCanvasNodes]);

  return (
    <ReactFlow
      className="h-full w-full"
      nodes={canvasNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      onNodesChange={onCanvasNodesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onSelectionChange={onSelectionChange}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
      onPaneClick={onPaneClick}
      fitView
    >
      <Background color="#334155" gap={32} />
      <MiniMap zoomable pannable className="!bg-slate-900" />
      <Controls />
    </ReactFlow>
  );
});

function ProjectEditor({ projectPath, projectName, onBack }: ProjectEditorProps) {
  const [project, setProject] = useState<PlotProject>(() => cloneProject(defaultProject));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeLayerTags, setActiveLayerTags] = useState<string[]>([]);
  const [selectedTagToAdd, setSelectedTagToAdd] = useState("");
  const [newTagInput, setNewTagInput] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [status, setStatus] = useState("Loading…");
  const [validationMessages, setValidationMessages] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [activeView, setActiveView] = useState<"graph" | "lore">("graph");
  const [selectedLoreId, setSelectedLoreId] = useState<string | null>(null);
  const [activeLoreText, setActiveLoreText] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [collapsedLayers, setCollapsedLayers] = useState<Record<string, boolean>>({});
  const [selectedFlowNodeIds, setSelectedFlowNodeIds] = useState<string[]>([]);
  const [selectedFlowEdgeIds, setSelectedFlowEdgeIds] = useState<string[]>([]);
  const [loreNewTag, setLoreNewTag] = useState("");
  const [loreNewCharacter, setLoreNewCharacter] = useState("");
  const [loreNewLocation, setLoreNewLocation] = useState("");
  const [lastExportPath, setLastExportPath] = useState("");
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const reactFlowWrapperRef = useRef<HTMLDivElement | null>(null);

  const [generationLogs, setGenerationLogs] = useState<string[]>([]);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [activeGenNodeId, setActiveGenNodeId] = useState<string | null>(null);
  const [draggedNodeType, setDraggedNodeType] = useState<string | null>(null);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);

  const historyRef = useRef<PlotProject[]>([cloneProject(defaultProject)]);
  const historyIndexRef = useRef(0);
  const globalStylePromptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("pipeline-log", (event) => {
      const line = event.payload;
      if (line.startsWith("__PLOT_NODE_ACTIVE__:")) {
        setActiveGenNodeId(line.split(":")[1]);
      } else if (line.startsWith("__PIPELINE_COMPLETE__") || line.startsWith("__PIPELINE_ERROR__")) {
        setIsGenerating(false);
        setActiveGenNodeId(null);
        setGenerationLogs((prev) => [...prev, line]);
      } else {
        setGenerationLogs((prev) => [...prev, line]);
      }
    }).then((f) => {
      unlisten = f;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Load the project from its file whenever projectPath changes
  useEffect(() => {
    setStatus("Loading…");
    historyRef.current = [cloneProject(defaultProject)];
    historyIndexRef.current = 0;
    setProject(cloneProject(defaultProject));

    invoke<string>("load_project_json", { path: projectPath })
      .then((raw) => {
        const loaded = normalizeProject(JSON.parse(raw) as Partial<PlotProject>);
        historyRef.current = [cloneProject(loaded)];
        historyIndexRef.current = 0;
        setProject(cloneProject(loaded));
        setStatus("Ready");
      })
      .catch(() => {
        setStatus("New project — not saved yet");
      });
  // projectPath is the only real dependency here
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const commitProject = (updater: (previous: PlotProject) => PlotProject) => {
    setProject((previous) => {
      const next = updater(previous);
      const snapshot = cloneProject(next);
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      nextHistory.push(snapshot);
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
      return next;
    });
  };

  const applySnapshot = (snapshot: PlotProject) => {
    setProject(cloneProject(snapshot));
  };

  const undo = () => {
    if (historyIndexRef.current <= 0) {
      return;
    }

    historyIndexRef.current -= 1;
    applySnapshot(historyRef.current[historyIndexRef.current]);
    setStatus("Undo");
  };

  const redo = () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) {
      return;
    }

    historyIndexRef.current += 1;
    applySnapshot(historyRef.current[historyIndexRef.current]);
    setStatus("Redo");
  };

  const allNodes = useMemo(() => Object.values(project.nodes), [project.nodes]);

  const layerCatalog = useMemo(() => {
    const fromNodes = allNodes.flatMap((node) => node.layerTags);
    return dedupe([...project.layerPresets, ...fromNodes]).sort((left, right) => left.localeCompare(right));
  }, [allNodes, project.layerPresets]);

  useEffect(() => {
    setSelectedTagToAdd((current) => current || layerCatalog[0] || "");
  }, [layerCatalog]);


  const loadLoreText = (id: string) => {
    setSelectedLoreId(id);
    setActiveLoreText(project.lore?.[id] || "");
  };

  const saveLoreText = () => {
    if (!selectedLoreId) return;
    commitProject((prev) => ({
      ...prev,
      lore: {
        ...(prev.lore || {}),
        [selectedLoreId]: activeLoreText,
      },
    }));
    setStatus(`Saved lore for ${selectedLoreId}`);
  };

  const addLoreEntity = (type: "tag" | "character" | "location", value: string) => {
    const slug = createSlug(value);
    if (!slug) return;
    
    commitProject((prev) => {
      const lore = { ...prev.lore, [slug]: "" };
      if (type === "tag" && !prev.layerPresets.includes(slug)) {
        return { ...prev, layerPresets: [...prev.layerPresets, slug], lore };
      }
      if (type === "character" && !prev.characters.some(c => c.id === slug)) {
        return { ...prev, characters: [...prev.characters, { id: slug, icon: "" }], lore };
      }
      if (type === "location" && !prev.locations.some(l => l.id === slug)) {
        return { ...prev, locations: [...prev.locations, { id: slug, title: value, preview: "" }], lore };
      }
      return prev;
    });

    if (type === "tag") setLoreNewTag("");
    if (type === "character") setLoreNewCharacter("");
    if (type === "location") setLoreNewLocation("");
  };

  const deleteLoreEntity = (type: "tag" | "character" | "location", id: string) => {
    commitProject((prev) => {
      const lore = { ...prev.lore };
      delete lore[id];
      if (type === "tag") {
        return { ...prev, layerPresets: prev.layerPresets.filter(t => t !== id), lore };
      }
      if (type === "character") {
        return { ...prev, characters: prev.characters.filter(c => c.id !== id), lore };
      }
      if (type === "location") {
        return { ...prev, locations: prev.locations.filter(l => l.id !== id), lore };
      }
      return prev;
    });
    if (selectedLoreId === id) {
      setSelectedLoreId(null);
      setActiveLoreText("");
    }
  };

  const visibleNodeIds = useMemo(() => {
    if (activeLayerTags.length === 0 || activeLayerTags.includes("global")) {
      return new Set(allNodes.map((node) => node.id));
    }

    return new Set(
      allNodes
        .filter((node) => activeLayerTags.every((tag) => node.layerTags.includes(tag)))
        .map((node) => node.id),
    );
  }, [activeLayerTags, allNodes]);

  const groupedNodes = useMemo(() => {
    const groups = new Map<string, PlotNode[]>();

    allNodes.forEach((node) => {
      const group = getPrimaryLayer(node);
      const current = groups.get(group) ?? [];
      current.push(node);
      groups.set(group, current);
    });

    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [allNodes]);

  const flowNodes = useMemo<FlowNode[]>(
    () =>
      allNodes
        .filter((node) => visibleNodeIds.has(node.id))
        .map((node) => ({
          id: node.id,
          type: node.type === "Act" ? "actNode" : "plotNode",
          position: node.position,
          data: {
            node,
            isSelected: node.id === selectedNodeId,
            isActiveGenNode: node.id === activeGenNodeId,
          },
        })),
    [allNodes, selectedNodeId, visibleNodeIds, activeGenNodeId],
  );

  const flowEdges = useMemo<Edge[]>(() => {
    const edges = new Map<string, Edge>();

    const pushEdge = (id: string, source: string, target: string, sourceHandle?: string) => {
      if (!visibleNodeIds.has(source) || !visibleNodeIds.has(target)) {
        return;
      }

      if (!edges.has(id)) {
        edges.set(id, {
          id,
          source,
          target,
          sourceHandle,
        });
      }
    };

    allNodes.forEach((node) => {
      if (node.type !== "Scene" && node.type !== "BranchPoint") {
        node.connectedTo.forEach((target) => {
          pushEdge(`${node.id}->${target}`, node.id, target, "out");
        });
      }

      if (node.type === "Scene") {
        const scene = node as SceneNode;

        if (scene.parameters.defaultNextNode) {
          pushEdge(
            `${node.id}::default::${scene.parameters.defaultNextNode}`,
            node.id,
            scene.parameters.defaultNextNode,
            "default",
          );
        }
      }

      if (node.type === "BranchPoint") {
        const branch = node as BranchPointNode;

        branch.parameters.choices.forEach((choice) => {
          if (choice.nextNode) {
            pushEdge(
              `${node.id}::choice:${choice.id}::${choice.nextNode}`,
              node.id,
              choice.nextNode,
              `choice:${choice.id}`,
            );
          }
        });
      }
    });

    return [...edges.values()];
  }, [allNodes, visibleNodeIds]);

  const selectedNode = selectedNodeId ? project.nodes[selectedNodeId] ?? null : null;

  const updateNode = (nodeId: string, updater: (node: PlotNode) => PlotNode) => {
    commitProject((previous) => {
      const existing = previous.nodes[nodeId];

      if (!existing) {
        return previous;
      }

      return {
        ...previous,
        nodes: {
          ...previous.nodes,
          [nodeId]: updater(existing),
        },
      };
    });
  };

  const removeNode = (nodeId: string) => {
    commitProject((previous) => {
      if (!previous.nodes[nodeId]) {
        return previous;
      }

      const nextNodes = Object.fromEntries(
        Object.entries(previous.nodes).filter(([currentId]) => currentId !== nodeId),
      );

      Object.values(nextNodes).forEach((node) => {
        node.connectedFrom = node.connectedFrom.filter((entry) => entry !== nodeId);
        node.connectedTo = node.connectedTo.filter((entry) => entry !== nodeId);

        if (node.type === "Scene") {
          const scene = node as SceneNode;
          scene.parameters = {
            ...scene.parameters,
            defaultNextNode: scene.parameters.defaultNextNode === nodeId ? "" : scene.parameters.defaultNextNode,
          };
        }

        if (node.type === "BranchPoint") {
          const branch = node as BranchPointNode;
          branch.parameters = {
            ...branch.parameters,
            choices: branch.parameters.choices.map((choice) =>
              choice.nextNode === nodeId ? { ...choice, nextNode: "" } : choice,
            ),
          };
        }
      });

      return {
        ...previous,
        nodes: nextNodes,
        acts: previous.acts.filter((entry) => entry !== nodeId),
        routes: previous.routes.filter((entry) => entry !== nodeId),
      };
    });

    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }

    setStatus(`Deleted node ${nodeId}`);
  };

  const removeEdge = (edgeId: string) => {
    const edge = flowEdges.find((entry) => entry.id === edgeId);
    if (!edge) {
      return;
    }

    commitProject((previous) => {
      const sourceNode = previous.nodes[edge.source];
      const targetNode = previous.nodes[edge.target];

      if (!sourceNode || !targetNode) {
        return previous;
      }

      const nextSource = cloneProject({ ...previous, nodes: { [sourceNode.id]: sourceNode } }).nodes[sourceNode.id];
      const nextTarget = cloneProject({ ...previous, nodes: { [targetNode.id]: targetNode } }).nodes[targetNode.id];

      nextSource.connectedTo = nextSource.connectedTo.filter((entry) => entry !== targetNode.id);
      nextTarget.connectedFrom = nextTarget.connectedFrom.filter((entry) => entry !== sourceNode.id);

      if (nextSource.type === "Scene") {
        const scene = nextSource as SceneNode;
        scene.parameters = {
          ...scene.parameters,
          defaultNextNode: scene.parameters.defaultNextNode === targetNode.id ? "" : scene.parameters.defaultNextNode,
        };
      }

      if (nextSource.type === "BranchPoint") {
        const branch = nextSource as BranchPointNode;
        branch.parameters = {
          ...branch.parameters,
          choices: branch.parameters.choices.map((choice) =>
            choice.nextNode === targetNode.id ? { ...choice, nextNode: "" } : choice,
          ),
        };
      }

      return {
        ...previous,
        nodes: {
          ...previous.nodes,
          [nextSource.id]: nextSource,
          [nextTarget.id]: nextTarget,
        },
      };
    });

    setStatus(`Deleted connection ${edge.source} -> ${edge.target}`);
  };

  const deleteSelection = () => {
    if (selectedFlowNodeIds.length > 0) {
      selectedFlowNodeIds.forEach((nodeId) => removeNode(nodeId));
      return;
    }

    selectedFlowEdgeIds.forEach((edgeId) => removeEdge(edgeId));
  };

  const onConnect: OnConnect = (connection: Edge | Connection) => {
    if (!connection.source || !connection.target) {
      return;
    }

    const sourceId = connection.source;
    const targetId = connection.target;

    commitProject((previous) => {
      const sourceNode = previous.nodes[sourceId];
      const targetNode = previous.nodes[targetId];

      if (!sourceNode || !targetNode) {
        return previous;
      }

      const nextSource = cloneProject({ ...previous, nodes: { [sourceNode.id]: sourceNode } }).nodes[sourceNode.id];
      const nextTarget = cloneProject({ ...previous, nodes: { [targetNode.id]: targetNode } }).nodes[targetNode.id];

      nextSource.connectedTo = dedupe([...nextSource.connectedTo, targetNode.id]);
      nextTarget.connectedFrom = dedupe([...nextTarget.connectedFrom, sourceNode.id]);

      if (nextSource.type === "Scene") {
        const scene = nextSource as SceneNode;
        scene.parameters = {
          ...scene.parameters,
          defaultNextNode: targetNode.id,
        };
      }

      if (nextSource.type === "BranchPoint") {
        const branch = nextSource as BranchPointNode;
        if (connection.sourceHandle?.startsWith("choice:")) {
          const choiceId = connection.sourceHandle.replace("choice:", "");
          branch.parameters = {
            ...branch.parameters,
            choices: branch.parameters.choices.map((choice) =>
              choice.id === choiceId ? { ...choice, nextNode: targetNode.id } : choice,
            ),
          };
        }
      }

      return {
        ...previous,
        nodes: {
          ...previous.nodes,
          [nextSource.id]: nextSource,
          [nextTarget.id]: nextTarget,
        },
      };
    });

    setStatus(`Connected ${sourceId} -> ${targetId}`);
  };

  const handleNodeDragStop = (_event: React.MouseEvent, node: FlowNode) => {
    updateNode(node.id, (current) => ({
      ...current,
      position: { x: node.position.x, y: node.position.y },
    }));
  };

  const handlePalettePointerDown = (event: React.PointerEvent<HTMLElement>, nodeType: PlotNodeType) => {
    event.preventDefault();
    setDraggedNodeType(nodeType);
  };

  const addNode = (type: PlotNodeType) => {
    let x = 300 + Math.floor(Math.random() * 240);
    let y = 220 + Math.floor(Math.random() * 240);

    if (flowInstanceRef.current) {
      const center = flowInstanceRef.current.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      x = center.x;
      y = center.y;
    }

    const created = createDefaultNode(type, x, y);

    commitProject((previous) => ({
      ...previous,
      nodes: { ...previous.nodes, [created.id]: created },
      acts: created.type === "Act" ? dedupe([...previous.acts, created.id]) : previous.acts,
      routes: created.type === "Route" ? dedupe([...previous.routes, created.id]) : previous.routes,
    }));

    setSelectedNodeId(created.id);
    setStatus(`Created ${created.type} node ${created.id}`);
  };

  const toggleLayer = (layer: string) => {
    setActiveLayerTags((previous) =>
      previous.includes(layer) ? previous.filter((entry) => entry !== layer) : [...previous, layer],
    );
  };

  const addSelectedTag = () => {
    if (!selectedNodeId || !selectedTagToAdd) {
      return;
    }

    updateNode(selectedNodeId, (node) => ({
      ...node,
      layerTags: dedupe([...node.layerTags, selectedTagToAdd]),
    }));
  };

  const addNewTag = () => {
    const value = newTagInput.trim();
    if (!value || !selectedNodeId) {
      return;
    }

    commitProject((previous) => ({
      ...previous,
      layerPresets: dedupe([...previous.layerPresets, value]),
      nodes: {
        ...previous.nodes,
        [selectedNodeId]: {
          ...previous.nodes[selectedNodeId],
          layerTags: dedupe([...previous.nodes[selectedNodeId].layerTags, value]),
        },
      },
    }));

    setSelectedTagToAdd(value);
    setNewTagInput("");
  };

  const removeNodeTag = (tag: string) => {
    if (!selectedNodeId) {
      return;
    }

    updateNode(selectedNodeId, (node) => ({
      ...node,
      layerTags: node.layerTags.filter((entry) => entry !== tag),
    }));
  };

  const validate = () => {
    const issues = validateConsistency(project);
    setValidationMessages(issues);
    setStatus(issues.length === 0 ? "Validation passed" : `Validation found ${issues.length} issue(s)`);
  };

  const saveProject = useCallback(async (proj?: PlotProject) => {
    const payload = JSON.stringify(proj ?? project, null, 2);
    try {
      await invoke("save_project_json", { path: projectPath, payload });
      setStatus(`Saved — ${projectPath}`);
    } catch (error) {
      setStatus(`Save failed: ${String(error)}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectPath]);

  const exportProject = async () => {
    const fileName = `../exports/project-${Date.now()}.plot.json`;
    const payload = JSON.stringify(project, null, 2);
    try {
      await invoke("export_project_json", { path: fileName, payload });
      setStatus(`Exported to ${fileName}`);
    } catch (error) {
      setStatus(`Export failed: ${String(error)}`);
    }
  };

  const exportModularProject = async () => {
    try {
      const payload: Record<string, string> = {};
      const exportDir = `../exports/modular-${Date.now()}`;

      payload[`${exportDir}/project_settings.json`] = JSON.stringify(
        {
          globalStylePrompt: project.globalStylePrompt,
        },
        null,
        2,
      );

      project.characters.forEach((char) => {
        payload[`${exportDir}/Lore/characters/${char.id}.md`] = project.lore?.[char.id] || "";
      });
      project.locations.forEach((loc) => {
        payload[`${exportDir}/Lore/locations/${loc.id}.md`] = project.lore?.[loc.id] || "";
      });
      project.layerPresets.forEach((tag) => {
        payload[`${exportDir}/Lore/tags/${tag}.md`] = project.lore?.[tag] || "";
      });

      Object.keys(project.nodes).forEach((nodeId) => {
        const node = project.nodes[nodeId];
        let folderName = "Uncategorized";
        if (node.layerTags.length > 0) {
           folderName = node.layerTags[0].replace(/[^a-zA-Z0-9]/g, '_');
        }
        payload[`${exportDir}/Acts/${folderName}/${node.id}.json`] = JSON.stringify(sanitizeNodeForAI(node), null, 2);
      });

      payload[`${exportDir}/progress_state.json`] = JSON.stringify({ current_node: project.startNodeId || project.acts[0] || "", context_bridge: "" }, null, 2);

      await invoke("export_modular_project", { payload: JSON.stringify(payload) });
      setLastExportPath(exportDir);
      console.log("Exported to:", exportDir);
      setStatus(`Exported modular project to ${exportDir}`);
    } catch (error) {
      setStatus(`Modular export failed: ${String(error)}`);
    }
  };

  const runGeneration = async () => {
    if (!lastExportPath) {
      alert("Please Export Modular first.");
      return;
    }
    setGenerationLogs(["Starting AI generation..."]);
    setActiveGenNodeId(null);
    setIsLogModalOpen(true);
    setIsGenerating(true);
    setStatus("Running AI Generation pipeline...");
    try {
      await invoke("run_ai_pipeline", { exportDir: lastExportPath });
      setStatus(`Generation started successfully!`);
    } catch (error) {
      setIsGenerating(false);
      setStatus(`Generation start failed: ${String(error)}`);
      setGenerationLogs((prev) => [...prev, `Failed to start: ${String(error)}`]);
      alert(`AI Generation Failed to Start:\n\n${String(error)}`);
    }
  };

  const copyStateFromPreviousAct = (nodeId: string) => {
    const source = project.nodes[nodeId];
    if (!source) {
      return;
    }

    const duplicated = createDefaultNode(source.type, source.position.x + 90, source.position.y + 90);
    const duplicate = {
      ...source,
      id: duplicated.id,
      name: `${source.name} (Copied State)`,
      position: { x: source.position.x + 90, y: source.position.y + 90 },
      connectedFrom: [],
      connectedTo: [],
      parameters: JSON.parse(JSON.stringify(source.parameters)),
    } as PlotNode;

    commitProject((previous) => ({
      ...previous,
      nodes: {
        ...previous.nodes,
        [duplicate.id]: duplicate,
      },
      acts: duplicate.type === "Act" ? dedupe([...previous.acts, duplicate.id]) : previous.acts,
      routes: duplicate.type === "Route" ? dedupe([...previous.routes, duplicate.id]) : previous.routes,
    }));

    setSelectedNodeId(duplicate.id);
    setStatus(`Created copy ${duplicate.id}`);
  };

  const addSceneVariant = () => {
    if (!selectedNodeId || selectedNode?.type !== "Scene") {
      return;
    }

    const scene = selectedNode as SceneNode;
    const variant: DialogueVariant = {
      id: `var_${Math.random().toString(36).slice(2, 6)}`,
      text: "New player choice",
      effects: [],
      nextNode: "",
    };

    updateNode(selectedNodeId, () => ({
      ...scene,
      parameters: {
        ...scene.parameters,
        dialogueVariants: [...scene.parameters.dialogueVariants, variant],
      },
    }));
  };

  const removeSceneVariant = (variantId: string) => {
    if (!selectedNodeId || selectedNode?.type !== "Scene") {
      return;
    }

    const scene = selectedNode as SceneNode;
    const nextVariants = scene.parameters.dialogueVariants.filter((variant) => variant.id !== variantId);
    const nextConnectedTo = dedupe(
      [scene.parameters.defaultNextNode, ...nextVariants.map((variant) => variant.nextNode)]
        .filter(Boolean)
        .map((entry) => String(entry)),
    );

    updateNode(selectedNodeId, () => ({
      ...scene,
      connectedTo: nextConnectedTo,
      parameters: {
        ...scene.parameters,
        dialogueVariants: nextVariants,
      },
    }));
  };
  const removeSceneCharacter = (characterId: string) => {
    if (!selectedNodeId || selectedNode?.type !== "Scene") {
      return;
    }

    const scene = selectedNode as SceneNode;
    updateNode(selectedNodeId, () => ({
      ...scene,
      parameters: {
        ...scene.parameters,
        actingCharacters: scene.parameters.actingCharacters.filter((entry) => entry.characterId !== characterId),
      },
    }));
  };

  const addVariantPresetEffect = (variantId: string, preset: "affinity" | "flag" | "hands") => {
    if (!selectedNodeId || selectedNode?.type !== "Scene") {
      return;
    }

    const scene = selectedNode as SceneNode;
    const effect =
      preset === "affinity"
        ? { target: "relation", character: "anna", affinity: -20, value: -20 }
        : preset === "flag"
          ? { target: "flag", key: "escape_attempt", value: true }
          : { target: "character:mc", field: "hands", value: 1, operator: "set" as const };

    updateNode(selectedNodeId, () => ({
      ...scene,
      parameters: {
        ...scene.parameters,
        dialogueVariants: scene.parameters.dialogueVariants.map((variant) =>
          variant.id === variantId ? { ...variant, effects: [...variant.effects, effect] } : variant,
        ),
      },
    }));
  };

  const focusNode = (nodeId: string) => {
    const node = project.nodes[nodeId];
    if (!node) {
      return;
    }

    setSelectedNodeId(nodeId);
    flowInstanceRef.current?.setCenter(node.position.x, node.position.y, { zoom: 1.35, duration: 300 });
  };

  useEffect(() => {
    const handleGlobalPointerUp = (event: PointerEvent) => {
      if (!draggedNodeType) {
        return;
      }

      const bounds = reactFlowWrapperRef.current?.getBoundingClientRect();
      const flow = flowInstanceRef.current;

      if (
        bounds &&
        flow &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom
      ) {
        const position = flow.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        const created = createDefaultNode(draggedNodeType as PlotNodeType, position.x, position.y);

        commitProject((previous) => ({
          ...previous,
          nodes: {
            ...previous.nodes,
            [created.id]: created,
          },
          acts: created.type === "Act" ? dedupe([...previous.acts, created.id]) : previous.acts,
          routes: created.type === "Route" ? dedupe([...previous.routes, created.id]) : previous.routes,
        }));

        setSelectedNodeId(created.id);
        setStatus(`Created ${created.type} node ${created.id}`);
      }

      setDraggedNodeType(null);
    };

    window.addEventListener("pointerup", handleGlobalPointerUp);
    return () => window.removeEventListener("pointerup", handleGlobalPointerUp);
  }, [draggedNodeType]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName;
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") {
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();

        if (selectedFlowNodeIds.length > 0 || selectedFlowEdgeIds.length > 0) {
          deleteSelection();
          return;
        }

        if (selectedNodeId) {
          removeNode(selectedNodeId);
          setSelectedFlowNodeIds([]);
          setSelectedFlowEdgeIds([]);
          setSelectedNodeId(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelection, redo, removeNode, selectedFlowEdgeIds, selectedFlowNodeIds, selectedNodeId, undo]);

  const selectedNodePreview = selectedNode?.type === "Scene" ? (selectedNode as SceneNode) : null;
  const selectedActPreview = selectedNode?.type === "Act" ? (selectedNode as ActNode) : null;
  const actOverrideTargetOptions = useMemo(
    () => [
      ...project.characters.map((character) => ({ id: character.id, label: `Character: ${character.id}` })),
      ...project.locations.map((location) => ({ id: location.id, label: `Location: ${location.title}` })),
    ],
    [project.characters, project.locations],
  );

  const updateActOverride = (overrideId: string, patch: Partial<NodeOverride>) => {
    if (!selectedNodeId || !selectedActPreview) {
      return;
    }

    updateNode(selectedNodeId, (node) => {
      if (node.type !== "Act") {
        return node;
      }

      const act = node as ActNode;

      return {
        ...act,
        parameters: {
          ...act.parameters,
          overrides: act.parameters.overrides.map((override) =>
            override.id === overrideId ? { ...override, ...patch } : override,
          ),
        },
      };
    });
  };

  const addActOverride = () => {
    if (!selectedNodeId || !selectedActPreview) {
      return;
    }

    const defaultTargetId = actOverrideTargetOptions[0]?.id ?? "";
    const nextOverride: NodeOverride = {
      id: `override_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      targetId: defaultTargetId,
      property: "Status",
      newValue: "",
    };

    updateNode(selectedNodeId, (node) => {
      if (node.type !== "Act") {
        return node;
      }

      const act = node as ActNode;

      return {
        ...act,
        parameters: {
          ...act.parameters,
          overrides: [...act.parameters.overrides, nextOverride],
        },
      };
    });
  };

  const removeActOverride = (overrideId: string) => {
    if (!selectedNodeId || !selectedActPreview) {
      return;
    }

    updateNode(selectedNodeId, (node) => {
      if (node.type !== "Act") {
        return node;
      }

      const act = node as ActNode;

      return {
        ...act,
        parameters: {
          ...act.parameters,
          overrides: act.parameters.overrides.filter((override) => override.id !== overrideId),
        },
      };
    });
  };

  const setStartNode = (nodeId: string) => {
    commitProject((previous) => {
      const nextNodes: Record<string, PlotNode> = {};
      
      Object.entries(previous.nodes).forEach(([id, node]) => {
        if (node.type !== "Act") {
          nextNodes[id] = node;
          return;
        }
        
        const act = node as ActNode;
        nextNodes[id] = {
          ...act,
          parameters: {
            ...act.parameters,
            isStart: id === nodeId,
          },
        };
      });

      return {
        ...previous,
        nodes: nextNodes,
        startNodeId: nodeId,
      };
    });
    setStatus(`Set start node to ${nodeId}`);
  };

  // Autosave then return to project selection
  const handleBack = useCallback(async () => {
    await saveProject();
    onBack();
  }, [saveProject, onBack]);

  const handleRouteInspectorChange = (nextRoute: RouteNode) => {
    updateNode(nextRoute.id, () => nextRoute);
  };

  const handleEventInspectorChange = (nextEventNode: EventNode) => {
    updateNode(nextEventNode.id, () => nextEventNode);
  };

  useEffect(() => {
    if (!isProjectSettingsOpen || !globalStylePromptRef.current) {
      return;
    }

    const textarea = globalStylePromptRef.current;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [isProjectSettingsOpen, project.globalStylePrompt]);

  return (
    <div
      style={{ width: "100vw", height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column" }}
      className="bg-[radial-gradient(circle_at_20%_20%,#1f2937_0,#0f172a_38%,#020617_100%)] text-slate-100"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-700/80 bg-slate-950/80 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
            onClick={(e) => { e.preventDefault(); handleBack(); }}
            title="Save and return to project list"
          >
            ← Projects
          </button>
          <button
            type="button"
            className="rounded-md bg-slate-700 px-3 py-1 text-sm"
            onClick={(e) => { e.preventDefault(); setIsProjectSettingsOpen(true); }}
          >
            Project Settings
          </button>
          <div>
            <h1 className="text-lg font-bold tracking-wide">{projectName}</h1>
            <p className="text-xs text-slate-400">{status}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-4 flex space-x-1 rounded-md bg-slate-900 p-1">
            <button
              type="button"
              className={`rounded px-3 py-1 text-sm font-semibold ${activeView === "graph" ? "bg-slate-700 text-white" : "text-slate-400"}`}
              onClick={(e) => { e.preventDefault(); setActiveView("graph"); }}
            >
              Graph View
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1 text-sm font-semibold ${activeView === "lore" ? "bg-slate-700 text-white" : "text-slate-400"}`}
              onClick={(e) => { e.preventDefault(); setActiveView("lore"); }}
            >
              Lore Editor
            </button>
          </div>
          <button type="button" className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={(e) => { e.preventDefault(); saveProject(); }}>
            Save Project
          </button>
          <button type="button" className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={(e) => { e.preventDefault(); exportProject(); }}>
            Export JSON
          </button>
          <button type="button" className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-semibold" onClick={(e) => { e.preventDefault(); exportModularProject(); }}>
            Export Modular
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1 text-sm font-semibold ${isGenerating ? "bg-fuchsia-600/50 cursor-not-allowed" : "bg-fuchsia-600"}`}
            onClick={(e) => { e.preventDefault(); runGeneration(); }}
            disabled={isGenerating}
          >
            {isGenerating ? "Running..." : "▶ Run AI Generation"}
          </button>
          <button type="button" className="rounded-md bg-amber-600 px-3 py-1 text-sm font-semibold text-slate-950" onClick={(e) => { e.preventDefault(); validate(); }}>
            Validate Consistency
          </button>
          <button type="button" className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={(e) => { e.preventDefault(); setActiveLayerTags([]); }}>
            Switch Layer: Global
          </button>
          <button type="button" className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={(e) => { e.preventDefault(); undo(); }}>
            Undo
          </button>
          <button type="button" className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={(e) => { e.preventDefault(); redo(); }}>
            Redo
          </button>
        </div>
      </header>

      {activeView === "graph" ? (
      <main className="grid grid-cols-[20%_60%_20%]" style={{ flex: 1, minHeight: 0 }}>
        <aside className="border-r border-slate-700/80 bg-slate-900/65 p-3">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Hierarchy / Layers</h2>

          <div className="mb-3 rounded-md border border-slate-700/70 bg-slate-950/70 p-2">
            <div className="mb-2 text-xs font-semibold text-slate-400">Layer Filters</div>
            <div className="mb-2 max-h-32 space-y-1 overflow-auto pr-1">
              {layerCatalog.map((layer) => (
                <label key={layer} className="flex items-center gap-2 text-xs text-slate-200">
                  <input type="checkbox" checked={activeLayerTags.includes(layer)} onChange={() => toggleLayer(layer)} />
                  <span>{layer}</span>
                </label>
              ))}
            </div>

            <div className="flex gap-2">
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                placeholder="custom tag"
                value={newTagInput}
                onChange={(event) => setNewTagInput(event.target.value)}
              />
              <button className="rounded-md bg-slate-700 px-2 py-1 text-xs" onClick={addNewTag}>
                Create new tag
              </button>
            </div>
          </div>

          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Nodes by Layer</div>
          <div className="mt-2 max-h-[68vh] space-y-2 overflow-auto pr-1">
            {groupedNodes.map(([layer, nodes]) => {
              const collapsed = collapsedLayers[layer] ?? false;

              return (
                <div key={layer} className="rounded-md border border-slate-700 bg-slate-800/60">
                  <button
                    className="flex w-full items-center justify-between px-2 py-2 text-left text-xs font-semibold"
                    onClick={() => setCollapsedLayers((previous) => ({ ...previous, [layer]: !collapsed }))}
                  >
                    <span>{layer}</span>
                    <span>{collapsed ? "+" : "-"}</span>
                  </button>
                  {!collapsed ? (
                    <div className="space-y-1 border-t border-slate-700 p-2">
                      {nodes.map((node) => (
                        <button
                          key={node.id}
                          className={`w-full rounded-md border px-2 py-2 text-left text-xs ${
                            selectedNodeId === node.id
                              ? "border-amber-400 bg-amber-500/20"
                              : "border-slate-700 bg-slate-800/60 hover:bg-slate-800"
                          }`}
                          onPointerDown={(event) => handlePalettePointerDown(event, node.type)}
                          onClick={() => setSelectedNodeId(node.id)}
                          onDoubleClick={() => focusNode(node.id)}
                        >
                          <div className="font-semibold">{node.name}</div>
                          <div className="text-slate-400">{node.type}</div>
                          <div className="truncate text-slate-500">{node.layerTags.join(", ") || "no tags"}</div>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>

        <section
          ref={reactFlowWrapperRef}
          className="reactflow-wrapper relative h-full min-h-0 w-full bg-slate-950/40"
          style={{ width: "100%", height: "100%" }}
          onClick={() => setContextMenu(null)}
        >
          <GraphCanvas
            flowNodes={flowNodes}
            flowEdges={flowEdges}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
            onConnect={onConnect}
            onNodeDragStop={handleNodeDragStop}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setContextMenu(null);
            }}
            onSelectionChange={(selection) => {
              const nextNodeIds = selection.nodes.map((node) => node.id);
              const nextEdgeIds = selection.edges.map((edge) => edge.id);

              setSelectedFlowNodeIds((current) => (equalStringArrays(current, nextNodeIds) ? current : nextNodeIds));
              setSelectedFlowEdgeIds((current) => (equalStringArrays(current, nextEdgeIds) ? current : nextEdgeIds));
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              const bounds = reactFlowWrapperRef.current?.getBoundingClientRect();
              if (!bounds) {
                return;
              }
              const left = event.clientX - bounds.left;
              const top = event.clientY - bounds.top;
              setContextMenu({ kind: "node", nodeId: node.id, x: left, y: top });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              const bounds = reactFlowWrapperRef.current?.getBoundingClientRect();
              if (!bounds) {
                return;
              }
              const left = event.clientX - bounds.left;
              const top = event.clientY - bounds.top;
              setContextMenu({ kind: "edge", edgeId: edge.id, x: left, y: top });
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setContextMenu(null);
            }}
          />

          {contextMenu ? (
            <div
              className="absolute z-20 min-w-56 rounded-md border border-slate-700 bg-slate-900 p-1 text-sm shadow-2xl"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {contextMenu.kind === "node" ? (
                <>
                  <button
                    className="w-full rounded px-2 py-1 text-left hover:bg-slate-800"
                    onClick={() => {
                      copyStateFromPreviousAct(contextMenu.nodeId);
                      setContextMenu(null);
                    }}
                  >
                    Copy state from previous act
                  </button>
                  <button
                    className="w-full rounded px-2 py-1 text-left text-rose-300 hover:bg-slate-800"
                    onClick={() => {
                      removeNode(contextMenu.nodeId);
                      setContextMenu(null);
                    }}
                  >
                    Delete node
                  </button>
                </>
              ) : (
                <button
                  className="w-full rounded px-2 py-1 text-left text-rose-300 hover:bg-slate-800"
                  onClick={() => {
                    removeEdge(contextMenu.edgeId);
                    setContextMenu(null);
                  }}
                >
                  Delete connection
                </button>
              )}
            </div>
          ) : null}
        </section>

        <aside className="border-l border-slate-700/80 bg-slate-900/65 p-3">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Inspector</h2>

          {!selectedNode ? (
            <div className="space-y-2">
              <div className="mb-3 text-xs text-slate-400 leading-relaxed">
                <span className="font-semibold text-slate-300">Node Palette</span>
                <br />Drag a card onto the canvas, or click to add at viewport center.
              </div>
              {(
                [
                  { type: "Act" as const,        color: "#7c3aed", bg: "rgba(124,58,237,0.15)", border: "rgba(124,58,237,0.5)",  desc: "Story act / chapter container" },
                  { type: "Scene" as const,       color: "#84cc16", bg: "rgba(132,204,22,0.12)", border: "rgba(132,204,22,0.45)", desc: "Dialogue & narrative scene" },
                  { type: "BranchPoint" as const, color: "#8b5cf6", bg: "rgba(139,92,246,0.12)", border: "rgba(139,92,246,0.45)", desc: "Player choice branch" },
                  { type: "Event" as const,       color: "#ef4444", bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.45)",  desc: "World event / trigger" },
                  { type: "Route" as const,       color: "#06b6d4", bg: "rgba(6,182,212,0.12)",  border: "rgba(6,182,212,0.45)",  desc: "Story path / route node" },
                ]
              ).map(({ type, color, bg, border, desc }) => (
                <div
                  key={type}
                  onPointerDown={(event) => handlePalettePointerDown(event, type)}
                  onClick={() => addNode(type)}
                  className="group flex cursor-grab items-center gap-3 rounded-xl border px-3 py-2.5 transition-all duration-150 active:cursor-grabbing hover:scale-[1.02]"
                  style={{ background: bg, borderColor: border }}
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-black text-white"
                    style={{ background: color }}
                  >
                    {type.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-100">{type}</div>
                    <div className="text-[11px] text-slate-400">{desc}</div>
                  </div>
                  <div className="ml-auto text-slate-600 group-hover:text-slate-400 transition-colors text-xs">⠿</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="max-h-[86vh] space-y-3 overflow-auto pr-1">
              <div className="rounded-md border border-slate-700 bg-slate-950/70 p-3">
                <div className="mb-1 text-xs text-slate-400">Node Name</div>
                <input
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                  value={selectedNode.name}
                  onChange={(event) => updateNode(selectedNode.id, (node) => ({ ...node, name: event.target.value }))}
                />
                <div className="mt-2 text-xs text-slate-500">Type: {selectedNode.type}</div>
              </div>

              <div className="rounded-md border border-slate-700 bg-slate-950/70 p-3">
                <div className="mb-1 text-xs text-slate-400">Layer Tags</div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {selectedNode.layerTags.map((tag) => (
                    <button
                      key={tag}
                      className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-xs"
                      onClick={() => removeNodeTag(tag)}
                    >
                      {tag} ×
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <select
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                    value={selectedTagToAdd}
                    onChange={(event) => setSelectedTagToAdd(event.target.value)}
                  >
                    {layerCatalog.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                  <button className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={addSelectedTag}>
                    Add tag
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {layerCatalog.filter((tag) => tag.startsWith(tagSearch)).slice(0, 8).map((tag) => (
                    <button
                      key={tag}
                      className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[11px]"
                      onClick={() => setSelectedTagToAdd(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                  <input
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                    placeholder="Search presets"
                    value={tagSearch}
                    onChange={(event) => setTagSearch(event.target.value)}
                  />
                  <input
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                    placeholder="new tag"
                    value={newTagInput}
                    onChange={(event) => setNewTagInput(event.target.value)}
                  />
                </div>
                <button className="mt-2 w-full rounded-md bg-indigo-600 px-3 py-1 text-sm" onClick={addNewTag}>
                  Create new tag
                </button>
              </div>

              {selectedNode.type === "Act" ? (
                <div className="space-y-3 rounded-md border border-amber-400/30 bg-slate-950/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-amber-200">Global State Modifiers</div>
                      <div className="text-xs text-slate-400">These overrides apply at the act level and shape global lore state.</div>
                    </div>
                    <button className="rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950" onClick={addActOverride}>
                      + Add Override
                    </button>
                  </div>

                  <label className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
                    <input
                      type="checkbox"
                      checked={selectedActPreview?.parameters.isStart ?? false}
                      onChange={(event) => {
                        if (event.target.checked && selectedNodeId) {
                          setStartNode(selectedNodeId);
                        }
                      }}
                      className="cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-green-300">Set as Starting Node</span>
                  </label>

                  <div className="space-y-2">
                    {selectedActPreview?.parameters.overrides.map((override) => (
                      <div key={override.id} className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-800/60 p-2">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wide">Target</div>
                        <select
                          className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                          value={override.targetId}
                          onChange={(event) => updateActOverride(override.id, { targetId: event.target.value })}
                        >
                          <option value="">Select target</option>
                          <optgroup label="Characters">
                            {project.characters.map((character) => (
                              <option key={character.id} value={character.id}>
                                {character.id}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="Locations">
                            {project.locations.map((location) => (
                              <option key={location.id} value={location.id}>
                                {location.title}
                              </option>
                            ))}
                          </optgroup>
                        </select>

                        <div className="text-[10px] text-slate-500 uppercase tracking-wide">Property</div>
                        <input
                          className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                          list="act-override-properties"
                          placeholder='e.g. "Status"'
                          value={override.property}
                          onChange={(event) => updateActOverride(override.id, { property: event.target.value })}
                        />

                        <div className="text-[10px] text-slate-500 uppercase tracking-wide">New Value</div>
                        <textarea
                          className="w-full resize-none min-h-[40px] max-h-[200px] overflow-y-auto bg-slate-800 border-slate-700 rounded border box-border px-2 py-1 text-xs"
                          placeholder="New value"
                          value={override.newValue}
                          onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                          onChange={(event) => updateActOverride(override.id, { newValue: event.target.value })}
                        />

                        <button
                          className="w-full rounded-md bg-rose-700 px-3 py-1 text-xs font-semibold text-white"
                          onClick={() => removeActOverride(override.id)}
                        >
                          Remove Override
                        </button>
                      </div>
                    ))}
                  </div>

                  {selectedActPreview?.parameters.overrides.length === 0 ? (
                    <div className="rounded-md border border-dashed border-slate-700 bg-slate-900/50 p-3 text-xs text-slate-400">
                      No overrides yet. Add one to define a global modifier for characters or locations.
                    </div>
                  ) : null}
                </div>
              ) : selectedNode.type === "Scene" ? (
                <div className="space-y-3 rounded-md border border-slate-700 bg-slate-950/70 p-3">
                  <div>
                    <div className="mb-1 text-xs text-slate-400">Acting Characters</div>
                    <div className="space-y-2">
                      {selectedNodePreview?.parameters.actingCharacters.map((actor, index) => {
                        const character = project.characters.find((entry) => entry.id === actor.characterId);
                        return (
                          <div
                            key={actor.characterId}
                            className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 p-2"
                          >
                            <div className="flex h-20 w-20 items-center justify-center rounded-md bg-slate-900 text-xl font-bold">
                              {(actor.characterId || "??").slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold">{character?.id ?? actor.characterId}</div>
                              <div className="truncate text-[11px] text-slate-400">{character?.icon ?? "unknown"}</div>
                              <input
                                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                                placeholder="Preset State (e.g. wounded)"
                                value={actor.presetState}
                                onChange={(e) => {
                                  const scene = selectedNode as SceneNode;
                                  const next = [...scene.parameters.actingCharacters];
                                  next[index] = { ...actor, presetState: e.target.value };
                                  updateNode(selectedNode.id, () => ({ ...scene, parameters: { ...scene.parameters, actingCharacters: next } }));
                                }}
                              />
                              <input
                                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                                placeholder="Relationships (e.g. mc: trust)"
                                value={actor.relationships}
                                onChange={(e) => {
                                  const scene = selectedNode as SceneNode;
                                  const next = [...scene.parameters.actingCharacters];
                                  next[index] = { ...actor, relationships: e.target.value };
                                  updateNode(selectedNode.id, () => ({ ...scene, parameters: { ...scene.parameters, actingCharacters: next } }));
                                }}
                              />
                            </div>
                            <button
                              className="rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white"
                              onClick={() => removeSceneCharacter(actor.characterId)}
                            >
                              Remove
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2">
                      <select
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                        value=""
                        onChange={(event) => {
                          const charId = event.target.value;
                          if (!charId) return;
                          const scene = selectedNode as SceneNode;
                          updateNode(selectedNode.id, () => ({
                            ...scene,
                            parameters: {
                              ...scene.parameters,
                              actingCharacters: [...scene.parameters.actingCharacters, { characterId: charId, presetState: "", relationships: "" }],
                            },
                          }));
                        }}
                      >
                        <option value="">+ Add an actor...</option>
                        {project.characters
                          .filter((character) => !selectedNodePreview?.parameters.actingCharacters.some((a) => a.characterId === character.id))
                          .map((character) => (
                            <option key={character.id} value={character.id}>
                              {character.id}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-xs text-slate-400">Location</div>
                    <select
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                      value={selectedNodePreview?.parameters.locationId}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: {
                            ...scene.parameters,
                            locationId: event.target.value,
                          },
                        }));
                      }}
                    >
                      <option value="">Choose location</option>
                      {project.locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.title}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-xs text-slate-400">
                      Preview: {project.locations.find((item) => item.id === selectedNodePreview?.parameters.locationId)?.preview || "-"}
                    </div>
                    <div className="mt-2">
                      <button
                        className="rounded-md bg-rose-700 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() => {
                          const scene = selectedNode as SceneNode;
                          updateNode(selectedNode.id, () => ({
                            ...scene,
                            parameters: { ...scene.parameters, locationId: "" },
                          }));
                        }}
                      >
                        Clear location
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-xs text-slate-400">Time of Day</div>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                      value={selectedNodePreview?.parameters.timeOfDay}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: {
                            ...scene.parameters,
                            timeOfDay: event.target.value,
                          },
                        }));
                      }}
                    />
                  </div>

                  <div>
                    <div className="mb-1 text-xs text-slate-400">Tone &amp; Mood</div>
                    <textarea
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                      style={{ resize: "none", maxHeight: "200px", overflowY: "auto" }}
                      rows={2}
                      value={selectedNodePreview?.parameters.toneAndMood}
                      onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: { ...scene.parameters, toneAndMood: event.target.value },
                        }));
                      }}
                    />
                  </div>

                  <div>
                    <div className="mb-1 text-xs text-slate-400">Narrative Action (What happens)</div>
                    <textarea
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                      style={{ resize: "none", maxHeight: "200px", overflowY: "auto" }}
                      rows={3}
                      value={selectedNodePreview?.parameters.narrativeAction}
                      onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: { ...scene.parameters, narrativeAction: event.target.value },
                        }));
                      }}
                    />
                  </div>

                  <div>
                    <div className="mb-1 text-xs text-slate-400">Goal (Outcome)</div>
                    <textarea
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                      style={{ resize: "none", maxHeight: "200px", overflowY: "auto" }}
                      rows={2}
                      value={selectedNodePreview?.parameters.goal}
                      onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: { ...scene.parameters, goal: event.target.value },
                        }));
                      }}
                    />
                  </div>

                  <div>
                    <div className="mb-1 text-xs text-slate-400">Constraints (AI rules)</div>
                    <textarea
                      className="w-full rounded-md border border-slate-700 bg-rose-950/30 px-2 py-1 text-sm text-rose-200"
                      style={{ resize: "none", maxHeight: "200px", overflowY: "auto" }}
                      rows={2}
                      value={selectedNodePreview?.parameters.constraints}
                      onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: { ...scene.parameters, constraints: event.target.value },
                        }));
                      }}
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                      <span>Triggers</span>
                      <button
                        className="rounded bg-slate-700 px-2 py-1"
                        onClick={() => {
                          const scene = selectedNode as SceneNode;
                          updateNode(selectedNode.id, () => ({
                            ...scene,
                            parameters: {
                              ...scene.parameters,
                              triggers: [...scene.parameters.triggers, { type: "flag", key: "", value: true }],
                            },
                          }));
                        }}
                      >
                        +
                      </button>
                    </div>
                    <div className="space-y-2">
                      {selectedNodePreview?.parameters.triggers.map((trigger, index) => (
                        <div key={`${trigger.key}-${index}`} className="grid grid-cols-3 gap-1">
                          <input
                            className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-xs"
                            value={trigger.type}
                            onChange={(event) => {
                              const scene = selectedNode as SceneNode;
                              const next = [...scene.parameters.triggers];
                              next[index] = { ...next[index], type: event.target.value };
                              updateNode(selectedNode.id, () => ({
                                ...scene,
                                parameters: { ...scene.parameters, triggers: next },
                              }));
                            }}
                          />
                          <input
                            className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-xs"
                            value={trigger.key}
                            onChange={(event) => {
                              const scene = selectedNode as SceneNode;
                              const next = [...scene.parameters.triggers];
                              next[index] = { ...next[index], key: event.target.value };
                              updateNode(selectedNode.id, () => ({
                                ...scene,
                                parameters: { ...scene.parameters, triggers: next },
                              }));
                            }}
                          />
                          <input
                            className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-xs"
                            value={String(trigger.value)}
                            onChange={(event) => {
                              const scene = selectedNode as SceneNode;
                              const next = [...scene.parameters.triggers];
                              next[index] = { ...next[index], value: event.target.value };
                              updateNode(selectedNode.id, () => ({
                                ...scene,
                                parameters: { ...scene.parameters, triggers: next },
                              }));
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                      <span>Dialogue Variants</span>
                      <button className="rounded bg-emerald-600 px-2 py-1 text-slate-950" onClick={addSceneVariant}>
                        + New Choice
                      </button>
                    </div>
                    <div className="space-y-2">
                      {selectedNodePreview?.parameters.dialogueVariants.map((variant) => (
                        <div key={variant.id} className="rounded-md border border-slate-700 bg-slate-900/70 p-2">
                          <textarea
                            className="mb-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                            style={{ resize: "none", maxHeight: "120px", overflowY: "auto" }}
                            rows={2}
                            value={variant.text}
                            onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                            onChange={(event) => {
                              const scene = selectedNode as SceneNode;
                              updateNode(selectedNode.id, () => ({
                                ...scene,
                                parameters: {
                                  ...scene.parameters,
                                  dialogueVariants: scene.parameters.dialogueVariants.map((item) =>
                                    item.id === variant.id ? { ...item, text: event.target.value } : item,
                                  ),
                                },
                              }));
                            }}
                          />
                          <div className="mb-1 text-[11px] text-slate-400">Effects: {variant.effects.length}</div>
                          <div className="mb-2 flex flex-wrap gap-1">
                            {variant.effects.map((effect, index) => (
                              <span key={`${variant.id}-effect-${index}`} className="rounded bg-slate-700 px-2 py-1 text-[10px]">
                                {effect.target}
                              </span>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1 text-[10px]">
                            <button className="rounded bg-slate-700 px-2 py-1" onClick={() => addVariantPresetEffect(variant.id, "affinity") }>
                              -20 affinity
                            </button>
                            <button className="rounded bg-slate-700 px-2 py-1" onClick={() => addVariantPresetEffect(variant.id, "flag") }>
                              set flag escape
                            </button>
                            <button className="rounded bg-slate-700 px-2 py-1" onClick={() => addVariantPresetEffect(variant.id, "hands") }>
                              change hands
                            </button>
                            <button className="rounded bg-rose-700 px-2 py-1" onClick={() => removeSceneVariant(variant.id)}>
                              delete choice
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2 text-xs">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNodePreview?.parameters.visualImportant)}
                      onChange={(event) => {
                        const scene = selectedNode as SceneNode;
                        updateNode(selectedNode.id, () => ({
                          ...scene,
                          parameters: {
                            ...scene.parameters,
                            visualImportant: event.target.checked,
                          },
                        }));
                      }}
                    />
                    Important for visual scene
                  </label>
                </div>
              ) : selectedNode.type === "Route" ? (
                <RouteInspector route={selectedNode as RouteNode} onChange={handleRouteInspectorChange} />
              ) : selectedNode.type === "Event" ? (
                <EventInspector eventNode={selectedNode as EventNode} onChange={handleEventInspectorChange} />
              ) : selectedNode.type === "BranchPoint" ? (
                <div className="space-y-3 rounded-md border border-violet-400/30 bg-slate-950/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-violet-200">Branch Choices</div>
                      <div className="text-xs text-slate-400">Define player choices at this branching point.</div>
                    </div>
                    <button
                      className="rounded-md bg-violet-600 px-3 py-1 text-xs font-semibold text-slate-100"
                      onClick={() => {
                        const branch = selectedNode as BranchPointNode;
                        const newChoice: BranchChoice = {
                          id: `choice_${Math.random().toString(36).slice(2, 6)}`,
                          text: "New choice",
                          nextNode: "",
                        };
                        updateNode(selectedNode.id, () => ({
                          ...branch,
                          parameters: {
                            ...branch.parameters,
                            choices: [...branch.parameters.choices, newChoice],
                          },
                        }));
                      }}
                    >
                      + Add Choice
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(selectedNode as BranchPointNode).parameters.choices.map((choice) => (
                      <div key={choice.id} className="rounded-md border border-slate-700 bg-slate-900/70 p-2">
                        <textarea
                          className="mb-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                          style={{ resize: "none", maxHeight: "120px", overflowY: "auto" }}
                          rows={2}
                          value={choice.text}
                          placeholder="Choice text"
                          onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"; }}
                          onChange={(event) => {
                            const branch = selectedNode as BranchPointNode;
                            updateNode(selectedNode.id, () => ({
                              ...branch,
                              parameters: {
                                ...branch.parameters,
                                choices: branch.parameters.choices.map((c) =>
                                  c.id === choice.id ? { ...c, text: event.target.value } : c,
                                ),
                              },
                            }));
                          }}
                        />
                        <select
                          className="mb-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                          value={choice.nextNode || ""}
                          onChange={(event) => {
                            const branch = selectedNode as BranchPointNode;
                            updateNode(selectedNode.id, () => ({
                              ...branch,
                              parameters: {
                                ...branch.parameters,
                                choices: branch.parameters.choices.map((c) =>
                                  c.id === choice.id ? { ...c, nextNode: event.target.value } : c,
                                ),
                              },
                            }));
                          }}
                        >
                          <option value="">No next node</option>
                          {allNodes
                            .filter((node) => node.id !== selectedNode.id)
                            .map((node) => (
                              <option key={node.id} value={node.id}>
                                {node.name}
                              </option>
                            ))}
                        </select>
                        <button
                          className="w-full rounded bg-rose-700 px-2 py-1 text-xs"
                          onClick={() => {
                            const branch = selectedNode as BranchPointNode;
                            updateNode(selectedNode.id, () => ({
                              ...branch,
                              parameters: {
                                ...branch.parameters,
                                choices: branch.parameters.choices.filter((c) => c.id !== choice.id),
                              },
                            }));
                          }}
                        >
                          Delete choice
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <button
                className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold"
                onClick={() => copyStateFromPreviousAct(selectedNode.id)}
              >
                Copy state from previous act
              </button>

              <div className="rounded-md border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-300">
                <div className="mb-2 font-semibold text-slate-200">Tips</div>
                <ul className="space-y-1">
                  <li>Delete selected node or edge with Del.</li>
                  <li>Undo / Redo with Ctrl+Z and Ctrl+Y.</li>
                  <li>Double-click a node in the left panel to center the camera.</li>
                </ul>
              </div>

              {validationMessages.length > 0 ? (
                <div className="rounded-md border border-rose-500/50 bg-rose-950/40 p-3">
                  <div className="mb-1 text-xs font-semibold text-rose-300">Validation Issues</div>
                  <ul className="space-y-1 text-xs text-rose-200">
                    {validationMessages.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </aside>
      </main>
      ) : (
      <main className="flex" style={{ flex: 1, minHeight: 0 }}>
        <aside className="w-1/4 border-r border-slate-700/80 bg-slate-900/65 p-3 flex flex-col gap-4 overflow-auto">
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Tags</h2>
            <div className="flex gap-2 mb-2">
              <input className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs" placeholder="New Tag" value={loreNewTag} onChange={(e) => setLoreNewTag(e.target.value)} />
              <button className="rounded bg-slate-700 px-2 py-1 text-xs" onClick={() => addLoreEntity("tag", loreNewTag)}>+</button>
            </div>
            <div className="space-y-1 pl-2">
              {project.layerPresets.map((tag) => (
                <div key={tag} className={`flex items-center justify-between rounded ${selectedLoreId === tag ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
                  <button onClick={() => loadLoreText(tag)} className="flex-1 text-left text-sm px-2 py-1">{tag}</button>
                  <button onClick={() => deleteLoreEntity("tag", tag)} className="px-2 text-xs text-rose-400 hover:text-rose-300">×</button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Characters</h2>
            <div className="flex gap-2 mb-2">
              <input className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs" placeholder="New Character" value={loreNewCharacter} onChange={(e) => setLoreNewCharacter(e.target.value)} />
              <button className="rounded bg-slate-700 px-2 py-1 text-xs" onClick={() => addLoreEntity("character", loreNewCharacter)}>+</button>
            </div>
            <div className="space-y-1 pl-2">
              {project.characters.map((c) => (
                <div key={c.id} className={`flex items-center justify-between rounded ${selectedLoreId === c.id ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
                  <button onClick={() => loadLoreText(c.id)} className="flex-1 text-left text-sm px-2 py-1">{c.id}</button>
                  <button onClick={() => deleteLoreEntity("character", c.id)} className="px-2 text-xs text-rose-400 hover:text-rose-300">×</button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Locations</h2>
            <div className="flex gap-2 mb-2">
              <input className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs" placeholder="New Location" value={loreNewLocation} onChange={(e) => setLoreNewLocation(e.target.value)} />
              <button className="rounded bg-slate-700 px-2 py-1 text-xs" onClick={() => addLoreEntity("location", loreNewLocation)}>+</button>
            </div>
            <div className="space-y-1 pl-2">
              {project.locations.map((l) => (
                <div key={l.id} className={`flex items-center justify-between rounded ${selectedLoreId === l.id ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
                  <button onClick={() => loadLoreText(l.id)} className="flex-1 text-left text-sm px-2 py-1">{l.id}</button>
                  <button onClick={() => deleteLoreEntity("location", l.id)} className="px-2 text-xs text-rose-400 hover:text-rose-300">×</button>
                </div>
              ))}
            </div>
          </div>
        </aside>
        <section className="flex-1 bg-slate-950 p-4 flex flex-col">
          {selectedLoreId ? (
            <>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold">Editing Lore: <span className="text-emerald-400">{selectedLoreId}</span></h2>
                <button onClick={saveLoreText} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded font-semibold transition-colors">
                  Save Details
                </button>
              </div>
              <textarea
                className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-md p-4 text-slate-200 font-mono text-sm resize-none focus:outline-none focus:border-emerald-500"
                value={activeLoreText}
                onChange={(e) => setActiveLoreText(e.target.value)}
                placeholder={`Write markdown lore details for ${selectedLoreId} here...`}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              Select a tag, character, or location from the sidebar to edit its lore.
            </div>
          )}
        </section>
      </main>
      )}

      {isProjectSettingsOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-4xl flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <div>
                <h2 className="text-lg font-bold text-slate-100">Project Settings</h2>
                <p className="text-xs text-slate-400">Global directives used by the AI generator across all scene nodes.</p>
              </div>
              <button
                type="button"
                className="rounded-md bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
                onClick={() => setIsProjectSettingsOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Global Style Directives</div>
              <textarea
                ref={globalStylePromptRef}
                className="min-h-[320px] w-full resize-none rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-emerald-500"
                value={project.globalStylePrompt}
                placeholder={`e.g., Write in 1st person perspective. Format dialogue strictly as 'Name: "Speech"'. Always describe the lighting and weather.`}
                onInput={(event) => {
                  event.currentTarget.style.height = "auto";
                  event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
                }}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  commitProject((previous) => ({
                    ...previous,
                    globalStylePrompt: nextValue,
                  }));
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* Drag Ghost — fully isolated, no App re-renders on mousemove */}
      <DragGhost activeNodeType={draggedNodeType} />

      {/* Log Modal */}
      {isLogModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[80vh] w-[800px] flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h2 className="text-lg font-bold text-slate-200">AI Generation Logs</h2>
              <button
                className="rounded-md bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
                onClick={() => setIsLogModalOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-sm text-slate-300 space-y-1">
              {generationLogs.map((log, i) => (
                <div key={i} className={log.includes("ERROR") || log.includes("Failed") ? "text-rose-400" : ""}>
                  {log}
                </div>
              ))}
              {isGenerating && (
                <div className="animate-pulse text-amber-400">Pipeline is processing...</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  App — top-level router between ProjectSelector and ProjectEditor
// ─────────────────────────────────────────────────────────────────────────────

type AppScreen =
  | { kind: "selecting" }
  | { kind: "editing"; projectPath: string; projectName: string };

function App() {
  const [screen, setScreen] = useState<AppScreen>({ kind: "selecting" });

  const openProject = useCallback((projectPath: string, projectName: string) => {
    setScreen({ kind: "editing", projectPath, projectName });
  }, []);

  const goBack = useCallback(() => {
    setScreen({ kind: "selecting" });
  }, []);

  if (screen.kind === "editing") {
    return (
      <ProjectEditor
        projectPath={screen.projectPath}
        projectName={screen.projectName}
        onBack={goBack}
      />
    );
  }

  return <ProjectSelector onOpen={openProject} />;
}

export default App;
