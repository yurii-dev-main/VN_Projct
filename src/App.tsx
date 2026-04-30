import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
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
import { AIChatMessage, ActNode, AgentMutationRecord, BranchChoice, BranchPointNode, DialogueVariant, EventNode, NodeOverride, PlotNode, PlotNodeType, PlotProject, RouteNode, SceneNode, StructuredLore } from "./types/plot";
import { sanitizeNodeForAI } from "./utils/aiExport";
import { getLayoutedElements } from "./utils/layout";

type ContextMenuState =
  | { kind: "node"; nodeId: string; x: number; y: number }
  | { kind: "edge"; edgeId: string; x: number; y: number }
  | null;

type AgentTask = {
  id: number;
  desc: string;
  status: string;
};

type LoreContextItem = {
  key: string;
  kind: "Character" | "Location" | "Tag";
  id: string;
  label: string;
  description: string;
};

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
  aiChatHistory: project.aiChatHistory ?? [],
  nodes: project.nodes ?? defaultProjectSnapshot.nodes,
  acts: project.acts ?? defaultProjectSnapshot.acts,
  routes: project.routes ?? defaultProjectSnapshot.routes,
  startNodeId: project.startNodeId ?? defaultProjectSnapshot.startNodeId,
  characters: project.characters ?? defaultProjectSnapshot.characters,
  locations: project.locations ?? defaultProjectSnapshot.locations,
  globalFlags: project.globalFlags ?? defaultProjectSnapshot.globalFlags,
  layerPresets: project.layerPresets ?? defaultProjectSnapshot.layerPresets,
  lore: project.lore ?? defaultProjectSnapshot.lore,
  loreStructured: project.loreStructured ?? {},
  tags: project.tags ?? {},
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

const isSourceTreePath = (path: string): boolean => path.startsWith("projects/") || path.startsWith("projects\\");

const sanitizeFileName = (value: string): string =>
  value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "untitled";

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
  const [loreViewMode, setLoreViewMode] = useState<"draft" | "structured">("draft");
  const [loreStructuredEdit, setLoreStructuredEdit] = useState<StructuredLore>({ role: "", aliases: "", publicDescription: "", hiddenTraits: "" });
  const [isStructurizing, setIsStructurizing] = useState(false);
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
  const [leftPanelTab, setLeftPanelTab] = useState<"hierarchy" | "chat">("chat");
  const [aiChatDraft, setAiChatDraft] = useState("");
  const [aiChatMessages, setAiChatMessages] = useState<AIChatMessage[]>([]);
  const [agentStatus, setAgentStatus] = useState<"idle" | "planning" | "executing" | "completed" | "error">("idle");
  const [agentStatusMessage, setAgentStatusMessage] = useState<string>("");
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [selectedLoreContext, setSelectedLoreContext] = useState<string[]>([]);
  const [stagedMutations, setStagedMutations] = useState<AgentMutationRecord[]>([]);
  const [isAwaitingApproval, setIsAwaitingApproval] = useState(false);
  const [isLorePopoverOpen, setIsLorePopoverOpen] = useState(false);
  const lorePopoverRef = useRef<HTMLDivElement | null>(null);
  const stagedMutationsRef = useRef<AgentMutationRecord[]>([]);
  const [lastSavedPath, setLastSavedPath] = useState<string>(() => {
    const stored = localStorage.getItem("plot-architect:lastSavedPath") || "";
    return stored || (isSourceTreePath(projectPath) ? "" : projectPath);
  });
  const [lastExportDir, setLastExportDir] = useState<string>(() => localStorage.getItem("plot-architect:lastExportDir") || "");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);

  // Play mode state
  const [playModeNodeId, setPlayModeNodeId] = useState<string | null>(null);

  const historyRef = useRef<PlotProject[]>([cloneProject(defaultProject)]);
  const historyIndexRef = useRef(0);
  const globalStylePromptRef = useRef<HTMLTextAreaElement | null>(null);
  const aiChatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const aiChatScrollRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<unknown>("agent-event", (event) => {
      const rawPayload = event.payload;
      const payload = typeof rawPayload === "string"
        ? (() => {
            try {
              return JSON.parse(rawPayload) as Record<string, unknown>;
            } catch {
              return null;
            }
          })()
        : (rawPayload as Record<string, unknown> | null);

      if (!payload || typeof payload !== "object") {
        return;
      }

      if (payload.type === "agent:status") {
        const nextStatus = payload.status;
        const nextMessage = typeof payload.message === "string" ? payload.message : "";

        if (nextStatus === "planning" || nextStatus === "executing" || nextStatus === "completed" || nextStatus === "error" || nextStatus === "idle") {
          setAgentStatus(nextStatus);
        }
        setAgentStatusMessage(nextMessage);
        // If execution finished and we have staged mutations, show approval UI
        if (nextStatus === "completed" && stagedMutationsRef.current.length > 0) {
          setIsAwaitingApproval(true);
        }
      }

      if (payload.type === "agent:todo") {
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        setAgentTasks(
          tasks
            .filter((task): task is AgentTask => Boolean(task) && typeof task === "object")
            .map((task, index) => ({
              id: Number((task as Record<string, unknown>).id ?? index + 1),
              desc: String((task as Record<string, unknown>).desc ?? ""),
              status: String((task as Record<string, unknown>).status ?? "pending"),
            })),
        );
        setAgentStatus("completed");
        setAgentStatusMessage("Planning complete.");
      }

      if (payload.type === "agent:mutation") {
        // Stage mutations for human approval instead of applying directly
        setStagedMutations((prev) => {
          const next = [...prev, payload as AgentMutationRecord];
          stagedMutationsRef.current = next;
          return next;
        });
      }

      if (payload.type === "agent:task_update") {
        const taskId = Number(payload.task_id);
        const nextStatus = String(payload.status ?? "pending");

        setAgentTasks((previous) =>
          previous.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  status: nextStatus,
                }
              : task,
          ),
        );
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
        setAiChatMessages(loaded.aiChatHistory ?? []);
        setStatus("Ready");
      })
      .catch(() => {
        setAiChatMessages([]);
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

  const buildAgentNodeFromMutation = (payloadNode: Record<string, unknown>): PlotNode | null => {
    const nodeType = String(payloadNode.type ?? "");
    if (nodeType !== "Act" && nodeType !== "Scene" && nodeType !== "BranchPoint") {
      return null;
    }

    const id = String(payloadNode.id ?? "").trim() || createSlug(`${nodeType}_${Date.now()}`);
    const positionValue = payloadNode.position as { x?: number; y?: number } | undefined;
    const x = Number(positionValue?.x ?? 100);
    const y = Number(positionValue?.y ?? 100);
    const data = (payloadNode.data as Record<string, unknown> | undefined) ?? {};
    const title = String(data.title ?? nodeType).trim() || nodeType;
    const description = String(data.description ?? "");

    const created = createDefaultNode(nodeType as PlotNodeType, x, y);

    if (created.type === "Act") {
      const act = created as ActNode;
      return {
        ...act,
        id,
        name: title,
        parameters: {
          ...act.parameters,
          title,
          description,
        },
      };
    }

    if (created.type === "Scene") {
      const scene = created as SceneNode;
      return {
        ...scene,
        id,
        name: title,
        parameters: {
          ...scene.parameters,
          narrativeAction: description || scene.parameters.narrativeAction,
          goal: scene.parameters.goal || description,
        },
      };
    }

    const branchPoint = created as BranchPointNode;
    return {
      ...branchPoint,
      id,
      name: title,
    };
  };

  const applyAgentNodeMutation = (payloadNode: Record<string, unknown>) => {
    const createdNode = buildAgentNodeFromMutation(payloadNode);

    if (!createdNode) {
      return;
    }

    commitProject((previous) => ({
      ...previous,
      nodes: {
        ...previous.nodes,
        [createdNode.id]: createdNode,
      },
      acts: createdNode.type === "Act" ? dedupe([...previous.acts, createdNode.id]) : previous.acts,
      routes: createdNode.type === "Route" ? dedupe([...previous.routes, createdNode.id]) : previous.routes,
    }));

    setSelectedNodeId(createdNode.id);
    setStatus(`Agent added ${createdNode.type} node ${createdNode.id}`);
  };

  const applyAgentEdgeMutation = (payloadEdge: Record<string, unknown>) => {
    const sourceId = String(payloadEdge.source ?? "").trim();
    const targetId = String(payloadEdge.target ?? "").trim();

    if (!sourceId || !targetId) {
      return;
    }

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
        const existingChoiceIndex = branch.parameters.choices.findIndex((choice) => !choice.nextNode);
        const nextChoices = branch.parameters.choices.slice();

        if (existingChoiceIndex >= 0) {
          nextChoices[existingChoiceIndex] = {
            ...nextChoices[existingChoiceIndex],
            nextNode: targetNode.id,
          };
        } else {
          nextChoices.push({
            id: createSlug(`choice_${sourceId}_${targetId}_${Date.now()}`),
            text: "Choice",
            nextNode: targetNode.id,
          });
        }

        branch.parameters = {
          ...branch.parameters,
          choices: nextChoices,
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

    setStatus(`Agent connected ${sourceId} -> ${targetId}`);
  };

  const applyAgentUpdateMutation = (nodeId: string, data: Record<string, unknown>) => {
    // Merge provided fields into the existing node's parameters
    commitProject((previous) => {
      const existing = previous.nodes[nodeId];
      if (!existing) return previous;

      const next = { ...existing } as PlotNode;

      // For Scene nodes, map common keys into parameters
      const nextParameters = { ...(next.parameters || {}) } as Record<string, unknown>;

      Object.keys(data).forEach((key) => {
        const value = (data as Record<string, unknown>)[key];
        if (value === null || value === undefined) return;

        // Accept both snake_case and camelCase keys from the agent
        if (key === "narrativeAction" || key === "narrative_action") {
          nextParameters["narrativeAction"] = String(value);
          return;
        }
        if (key === "toneAndMood" || key === "tone" || key === "tone_and_mood") {
          nextParameters["toneAndMood"] = String(value);
          return;
        }
        if (key === "goal") {
          nextParameters["goal"] = String(value);
          return;
        }
        if (key === "constraints") {
          nextParameters["constraints"] = String(value);
          return;
        }
        if (key === "dialogue_text" || key === "dialogueText") {
          // Append a dialogue variant if the node is a Scene
          if (next.type === "Scene") {
            const scene = next as SceneNode;
            const variant: DialogueVariant = {
              id: `var_${Math.random().toString(36).slice(2, 6)}`,
              text: String(value),
              effects: [],
              nextNode: "",
            };
            nextParameters["dialogueVariants"] = [...(scene.parameters.dialogueVariants || []), variant];
          }
          return;
        }
        if (key === "choices" && Array.isArray(value)) {
          // Replace or set choices for BranchPoint nodes
          if (next.type === "BranchPoint") {
            const choices = (value as unknown[]).map((entry) => {
              const obj = entry as Record<string, unknown>;
              return {
                id: String(obj.id ?? createSlug(String(obj.text ?? "choice"))),
                text: String(obj.text ?? ""),
                nextNode: String((obj.nextNode ?? "") as string) || undefined,
              } as BranchChoice;
            });
            nextParameters["choices"] = choices;
          }
          return;
        }

        // For any other keys, just set them directly on parameters
        nextParameters[key] = value as unknown;
      });

      next.parameters = nextParameters as typeof next.parameters;

      return {
        ...previous,
        nodes: {
          ...previous.nodes,
          [next.id]: next,
        },
      };
    });

    setStatus(`Agent updated ${nodeId}`);
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

  // Search logic
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setCurrentSearchIndex(0);
      return;
    }

    const query = searchQuery.toLowerCase();
    const matched: string[] = [];

    Object.values(project.nodes).forEach((node) => {
      // Search in node name
      if (node.name.toLowerCase().includes(query)) {
        matched.push(node.id);
        return;
      }

      // Search in node-type-specific properties
      if (node.type === "Act") {
        if (node.parameters.title?.toString().toLowerCase().includes(query) ||
            node.parameters.description?.toString().toLowerCase().includes(query)) {
          matched.push(node.id);
          return;
        }
      }

      if (node.type === "Route") {
        if (node.parameters.title?.toString().toLowerCase().includes(query)) {
          matched.push(node.id);
          return;
        }
      }

      if (node.type === "Scene") {
        if (node.parameters.narrativeAction?.toString().toLowerCase().includes(query) ||
            node.parameters.goal?.toString().toLowerCase().includes(query) ||
            node.parameters.constraints?.toString().toLowerCase().includes(query)) {
          matched.push(node.id);
          return;
        }

        // Search in dialogue variants
        if (Array.isArray(node.parameters.dialogueVariants)) {
          const hasMatchingDialogue = node.parameters.dialogueVariants.some(
            (d) => d.text?.toLowerCase().includes(query)
          );
          if (hasMatchingDialogue) {
            matched.push(node.id);
            return;
          }
        }
      }

      if (node.type === "BranchPoint") {
        // Search in branch labels and choices
        const branchLabels = Array.isArray(node.parameters.branches)
          ? node.parameters.branches.some((b) => b.label?.toLowerCase().includes(query))
          : false;

        const choiceText = Array.isArray(node.parameters.choices)
          ? node.parameters.choices.some((c) => c.text?.toLowerCase().includes(query))
          : false;

        if (branchLabels || choiceText) {
          matched.push(node.id);
        }
      }
    });

    setSearchResults(matched);
    setCurrentSearchIndex(0);
  }, [searchQuery, project.nodes]);

  const focusSearchResult = (nodeId: string) => {
    const node = project.nodes[nodeId];
    if (!node || !flowInstanceRef.current) return;

    const NODE_WIDTH = 300;
    const NODE_HEIGHT = 150;

    flowInstanceRef.current.setCenter(
      node.position.x + NODE_WIDTH / 2,
      node.position.y + NODE_HEIGHT / 2,
      { zoom: 1.2, duration: 500 },
    );

    // Highlight the node by setting it as selected
    setSelectedNodeId(nodeId);
  };

  const handleSearchNext = () => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(nextIndex);
    focusSearchResult(searchResults[nextIndex]);
  };

  const handleSearchPrev = () => {
    if (searchResults.length === 0) return;
    const prevIndex = currentSearchIndex === 0 ? searchResults.length - 1 : currentSearchIndex - 1;
    setCurrentSearchIndex(prevIndex);
    focusSearchResult(searchResults[prevIndex]);
  };

  // Play mode helper functions
  const getNextNodeForPlayMode = (currentNodeId: string): string | null => {
    const currentNode = project.nodes[currentNodeId];
    if (!currentNode) return null;

    if (currentNode.type === "Scene") {
      const scene = currentNode as SceneNode;
      return scene.parameters.defaultNextNode || currentNode.connectedTo[0] || null;
    }

    // For Act, Route, Event, or other types: use first connectedTo
    return currentNode.connectedTo[0] || null;
  };

  const getChoiceTarget = (nodeId: string, choiceId: string): string | null => {
    const node = project.nodes[nodeId];
    if (node?.type !== "BranchPoint") return null;

    const branchPoint = node as BranchPointNode;
    const choice = branchPoint.parameters.choices.find((c) => c.id === choiceId);
    return choice?.nextNode || null;
  };

  const handlePlayModeNavigate = (nextNodeId: string | null) => {
    if (!nextNodeId) {
      setPlayModeNodeId(null);
      setStatus("Play mode ended");
      return;
    }
    setPlayModeNodeId(nextNodeId);
  };

  const loadLoreText = (id: string) => {
    setSelectedLoreId(id);
    setActiveLoreText(project.lore?.[id] || "");
    setLoreStructuredEdit(project.loreStructured?.[id] ?? { role: "", aliases: "", publicDescription: "", hiddenTraits: "" });
    setLoreViewMode("draft");
  };

  const saveLoreText = () => {
    if (!selectedLoreId) return;
    commitProject((prev) => ({
      ...prev,
      lore: {
        ...(prev.lore || {}),
        [selectedLoreId]: activeLoreText,
      },
      loreStructured: {
        ...(prev.loreStructured || {}),
        [selectedLoreId]: loreStructuredEdit,
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
      setLoreStructuredEdit({ role: "", aliases: "", publicDescription: "", hiddenTraits: "" });
    }
  };

  const getSelectedLoreEntityType = (): "character" | "location" | "tag" => {
    if (!selectedLoreId) return "character";
    if (project.characters.some(c => c.id === selectedLoreId)) return "character";
    if (project.locations.some(l => l.id === selectedLoreId)) return "location";
    return "tag";
  };

  const structurizeWithAI = async () => {
    if (!selectedLoreId || !activeLoreText.trim()) return;
    setIsStructurizing(true);
    try {
      const entityType = getSelectedLoreEntityType();
      const result = await invoke<string>("run_lore_parser", {
        draftText: activeLoreText,
        entityType,
      });
      const parsed = JSON.parse(result) as StructuredLore;
      setLoreStructuredEdit({
        role: parsed.role ?? "[Not specified]",
        aliases: parsed.aliases ?? "[Not specified]",
        publicDescription: parsed.publicDescription ?? "[Not specified]",
        hiddenTraits: parsed.hiddenTraits ?? "[Not specified]",
      });
      // Auto-save structured data and switch to structured mode
      commitProject((prev) => ({
        ...prev,
        loreStructured: {
          ...(prev.loreStructured || {}),
          [selectedLoreId]: {
            role: parsed.role ?? "[Not specified]",
            aliases: parsed.aliases ?? "[Not specified]",
            publicDescription: parsed.publicDescription ?? "[Not specified]",
            hiddenTraits: parsed.hiddenTraits ?? "[Not specified]",
          },
        },
      }));
      setLoreViewMode("structured");
      setStatus("AI parsing complete — review the structured fields");
    } catch (err) {
      setStatus(`Structurize failed: ${String(err)}`);
    } finally {
      setIsStructurizing(false);
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

  const selectedCanvasNodeCount = useMemo(
    () => allNodes.filter((node) => selectedFlowNodeIds.includes(node.id)).length,
    [allNodes, selectedFlowNodeIds],
  );

  const selectedNodesForChat = useMemo(
    () => allNodes.filter((node) => selectedFlowNodeIds.includes(node.id)).map((node) => sanitizeNodeForAI(node)),
    [allNodes, selectedFlowNodeIds],
  );

  const loreContextOptions = useMemo<LoreContextItem[]>(() => {
    const titleize = (value: string) =>
      value
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
        .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
        .join(" ");

    const characterOptions: LoreContextItem[] = (project.characters || []).map((character) => ({
      key: `character:${character.id}`,
      kind: "Character",
      id: character.id,
      label: `[Character] ${titleize(character.id)}`,
      description: project.lore?.[character.id] || "",
    }));

    const locationOptions: LoreContextItem[] = (project.locations || []).map((location) => ({
      key: `location:${location.id}`,
      kind: "Location",
      id: location.id,
      label: `[Location] ${location.title || titleize(location.id)}`,
      description: project.lore?.[location.id] || "",
    }));

    const tagOptions: LoreContextItem[] = (project.layerPresets || []).map((tag) => ({
      key: `tag:${tag}`,
      kind: "Tag",
      id: tag,
      label: `[Tag] ${titleize(tag)}`,
      description: project.lore?.[tag] || "",
    }));

    return [...characterOptions, ...locationOptions, ...tagOptions];
  }, [project.characters, project.layerPresets, project.locations, project.lore]);

  const selectedLoreContextItems = useMemo(
    () => loreContextOptions.filter((item) => selectedLoreContext.includes(item.key)),
    [loreContextOptions, selectedLoreContext],
  );

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
            isSearchActive: searchResults.length > 0 && node.id === searchResults[currentSearchIndex],
          },
        })),
    [allNodes, selectedNodeId, visibleNodeIds, activeGenNodeId, searchResults, currentSearchIndex],
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

  const summarizeMutation = (mutation: AgentMutationRecord): string => {
    if (mutation.action === "add_node") {
      const nodeType = String(mutation.node?.type ?? "Node");
      return `➕ Create Node: ${nodeType}`;
    }

    if (mutation.action === "add_edge") {
      const source = String(mutation.edge?.source ?? "?");
      const target = String(mutation.edge?.target ?? "?");
      return `🔗 Connect Nodes: ${source} → ${target}`;
    }

    if (mutation.action === "update_node") {
      return `✏️ Update Node: ${String(mutation.node_id ?? "unknown")}`;
    }

    if (mutation.action === "ADD_LORE") {
      const entityLabel = mutation.entityType === "character" ? "Character" : mutation.entityType === "location" ? "Location" : "Tag";
      return `✨ Create ${entityLabel}: ${mutation.payload.name}`;
    }

    return `• Mutation`;
  };

  const allStagedWarnings = useMemo(
    () => stagedMutations.flatMap((mutation) => mutation.warnings ?? []),
    [stagedMutations],
  );

  const handleApprove = () => {
    const staged = stagedMutationsRef.current.slice();
    const hasAddedNodes = staged.some((mutation) => mutation?.action === "add_node" && mutation.node);
    staged.forEach((mutation) => {
      if (!mutation || typeof mutation !== "object") return;
      if (mutation.action === "add_node" && mutation.node) applyAgentNodeMutation(mutation.node as Record<string, unknown>);
      if (mutation.action === "add_edge" && mutation.edge) applyAgentEdgeMutation(mutation.edge as Record<string, unknown>);
      if (mutation.action === "update_node" && typeof mutation.node_id === "string" && mutation.data) applyAgentUpdateMutation(String(mutation.node_id), mutation.data as Record<string, unknown>);
      if (mutation.action === "ADD_LORE") {
        const loreMutation = mutation as Extract<AgentMutationRecord, { action: "ADD_LORE" }>;
        commitProject((previous) => {
          const next = cloneProject(previous);
          const { entityType, payload } = loreMutation;
          const lore = { ...(next.lore || {}) };

          lore[payload.id] = payload.description;

          if (entityType === "character") {
            if (!next.characters.some((character) => character.id === payload.id)) {
              next.characters = [...next.characters, { id: payload.id, icon: "" }];
            }
          } else if (entityType === "location") {
            if (!next.locations.some((location) => location.id === payload.id)) {
              next.locations = [...next.locations, { id: payload.id, title: payload.name, preview: "" }];
            }
          } else if (!next.layerPresets.includes(payload.id)) {
            next.layerPresets = [...next.layerPresets, payload.id];
          }

          next.lore = lore;
          return next;
        });
      }
    });
    setStagedMutations([]);
    stagedMutationsRef.current = [];
    setIsAwaitingApproval(false);
    setStatus(`Applied ${staged.length} agent change(s)`);

    setTimeout(() => {
      void saveProject();
    }, 0);

    if (hasAddedNodes) {
      // Auto-arrange only when the AI introduced new nodes, which is the common overlap case.
      setTimeout(() => {
        handleAutoLayout();
      }, 150);
    }
  };

  const handleReject = () => {
    setStagedMutations([]);
    stagedMutationsRef.current = [];
    setIsAwaitingApproval(false);
    setStatus("Rejected agent changes");
  };

  const handleAutoLayout = () => {
    const flowInstance = flowInstanceRef.current;
    if (!flowInstance) return;

    // Get current nodes and edges
    const allPlotNodes = Object.values(project.nodes);
    const { nodes: layoutedNodes } = getLayoutedElements(allPlotNodes, flowEdges);

    // Update project with new positions
    commitProject((prev) => {
      const updated = cloneProject(prev);
      layoutedNodes.forEach((node) => {
        if (updated.nodes[node.id]) {
          updated.nodes[node.id].position = node.position;
        }
      });
      return updated;
    });

    // Fit view with smooth animation
    setTimeout(() => {
      flowInstance.fitView({ duration: 800, padding: 0.2 });
    }, 100);

    setStatus("Auto-arranged nodes");
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
      let targetPath = lastSavedPath;

      if (!targetPath) {
        const selected = await dialogSave({
          defaultPath: `${sanitizeFileName(project.meta.title || projectName)}.plot.json`,
          filters: [{ name: "Plot Project", extensions: ["json"] }],
        });

        if (!selected) {
          setStatus("Save cancelled");
          return;
        }

        targetPath = selected;
        setLastSavedPath(selected);
      }

      await invoke("save_project_json", { path: targetPath, payload });
      setStatus(`Saved — ${targetPath}`);
    } catch (error) {
      setStatus(`Save failed: ${String(error)}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, lastSavedPath, project.meta.title, projectName]);

  const exportProject = async () => {
    const fileName = await dialogSave({
      defaultPath: `project-${Date.now()}.plot.json`,
      filters: [{ name: "Plot Project", extensions: ["json"] }],
    });

    if (!fileName) {
      setStatus("Export cancelled");
      return;
    }

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
      let exportDir = lastExportDir;

      if (!exportDir) {
        const selected = await dialogOpen({
          directory: true,
          multiple: false,
          defaultPath: `modular-${Date.now()}`,
        });

        if (typeof selected !== "string" || !selected) {
          setStatus("Modular export cancelled");
          return;
        }

        exportDir = selected;
        setLastExportDir(selected);
      }

      payload["project_settings.json"] = JSON.stringify(
        {
          globalStylePrompt: project.globalStylePrompt,
        },
        null,
        2,
      );

      project.characters.forEach((char) => {
        payload[`Lore/characters/${sanitizeFileName(char.id)}.md`] = project.lore?.[char.id] || "";
      });
      project.locations.forEach((loc) => {
        payload[`Lore/locations/${sanitizeFileName(loc.title)}.md`] = project.lore?.[loc.id] || "";
      });
      project.layerPresets.forEach((tag) => {
        payload[`Lore/tags/${sanitizeFileName(tag)}.md`] = project.lore?.[tag] || "";
      });

      Object.keys(project.nodes).forEach((nodeId) => {
        const node = project.nodes[nodeId];
        let folderName = "Uncategorized";
        if (node.layerTags.length > 0) {
           folderName = sanitizeFileName(node.layerTags[0]);
        }
        const displayName = sanitizeFileName(node.name || (node.type === "Act" ? node.parameters.title : node.type));
        payload[`Acts/${folderName}/${sanitizeFileName(`${node.type}_${displayName}`)}.json`] = JSON.stringify(sanitizeNodeForAI(node), null, 2);
      });

      payload["progress_state.json"] = JSON.stringify({ current_node: project.startNodeId || project.acts[0] || "", context_bridge: "" }, null, 2);

      await invoke("export_modular_project", { exportDir, payload: JSON.stringify(payload) });
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

  useEffect(() => {
    if (leftPanelTab !== "chat" || !aiChatInputRef.current) {
      return;
    }

    const textarea = aiChatInputRef.current;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [aiChatDraft, leftPanelTab]);

  useEffect(() => {
    if (!aiChatScrollRef.current) {
      return;
    }

    aiChatScrollRef.current.scrollTop = aiChatScrollRef.current.scrollHeight;
  }, [aiChatMessages]);

  useEffect(() => {
    if (lastSavedPath) {
      localStorage.setItem("plot-architect:lastSavedPath", lastSavedPath);
    } else {
      localStorage.removeItem("plot-architect:lastSavedPath");
    }
  }, [lastSavedPath]);

  useEffect(() => {
    if (lastExportDir) {
      localStorage.setItem("plot-architect:lastExportDir", lastExportDir);
    } else {
      localStorage.removeItem("plot-architect:lastExportDir");
    }
  }, [lastExportDir]);

  useEffect(() => {
    setProject((previous) => ({
      ...previous,
      aiChatHistory: aiChatMessages,
    }));
  }, [aiChatMessages]);

  const handleAiChatSend = () => {
    const prompt = aiChatDraft.trim();
    if (!prompt) {
      return;
    }

    setAgentStatus("idle");
    setAgentStatusMessage("");

    const structuredPromptPackage = {
      nodes: selectedNodesForChat,
      globalStyle: project.globalStylePrompt.trim(),
      lore: project.lore || {},
      projectPath,
      // Send a minimized representation to the agent to save tokens and
      // make name->id resolution deterministic: only id + name/title fields.
      characters: (project.characters || []).map((c) => ({ id: c.id, name: (c as any).name || (c as any).displayName || c.id })),
      locations: (project.locations || []).map((l) => ({ id: l.id, title: (l as any).title || l.id })),
      llmProvider: project.llmProvider || "gemini",
      localModelName: project.localModelName || "qwen2.5:0.5b",
      selectedLoreContext: selectedLoreContextItems,
      userPrompt: prompt,
    };

    setAiChatMessages((previous) => [
      ...previous,
      { id: `user-${Date.now()}`, role: "user", content: prompt },
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: `Prompt package prepared for AI backend. Selected nodes: ${selectedNodesForChat.length}. Global directives are attached and ready to be sent.`,
      },
    ]);

    setAgentStatus("planning");
    setAgentStatusMessage("Initializing agent...");
    setAgentTasks([]);
    setStatus(`AI Co-pilot planning: ${selectedNodesForChat.length} selected node(s)`);
    setAiChatDraft("");

    void invoke("run_agent_planner", {
      prompt,
      contextJson: JSON.stringify(structuredPromptPackage),
    }).then(() => {
      setSelectedLoreContext([]);
    }).catch((error) => {
      setAgentStatus("error");
      setAgentStatusMessage(`Failed to start planner: ${String(error)}`);
    });
  };

  return (
    <div
      style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}
      className="h-screen overflow-hidden bg-[radial-gradient(circle_at_20%_20%,#1f2937_0,#0f172a_38%,#020617_100%)] text-slate-100"
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

          {/* Search Bar */}
          <div className="flex items-center gap-2 rounded-md border border-slate-600 bg-slate-800 px-2 py-1">
            <input
              type="text"
              placeholder="🔍 Search nodes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-40 bg-slate-800 text-sm text-slate-100 placeholder-slate-500 outline-none"
            />
            {searchResults.length > 0 && (
              <span className="text-xs font-medium text-slate-300">
                {currentSearchIndex + 1} / {searchResults.length}
              </span>
            )}
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-sm hover:bg-slate-700 disabled:opacity-50"
              onClick={handleSearchPrev}
              disabled={searchResults.length === 0}
              title="Previous result"
            >
              &lt;
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-sm hover:bg-slate-700 disabled:opacity-50"
              onClick={handleSearchNext}
              disabled={searchResults.length === 0}
              title="Next result"
            >
              &gt;
            </button>
          </div>
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
          <button
            type="button"
            className={`rounded-md px-3 py-1 text-sm font-semibold ${selectedFlowNodeIds.length === 1 ? "bg-emerald-600" : "bg-slate-600 cursor-not-allowed"}`}
            onClick={(e) => {
              e.preventDefault();
              if (selectedFlowNodeIds.length === 1) {
                setPlayModeNodeId(selectedFlowNodeIds[0]);
                setStatus("Play mode started");
              }
            }}
            disabled={selectedFlowNodeIds.length !== 1}
          >
            ▶ Play from Selected
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
          <button type="button" className="rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={(e) => { e.preventDefault(); handleAutoLayout(); }}>
            🪄 Auto-Arrange
          </button>
        </div>
      </header>

      {activeView === "graph" ? (
      <main className="grid grid-cols-[20%_60%_20%]" style={{ flex: 1, minHeight: 0 }}>
              {/* Play Mode Modal */}
              {playModeNodeId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8">
                  {(() => {
                    const currentNode = project.nodes[playModeNodeId];
                    if (!currentNode) {
                      return (
                        <div className="flex w-full max-w-3xl flex-col gap-4 rounded-2xl border border-slate-600 bg-slate-900 p-6 text-slate-100">
                          <p>Node not found.</p>
                          <button
                            type="button"
                            className="rounded-md bg-slate-700 px-4 py-2 text-sm"
                            onClick={() => setPlayModeNodeId(null)}
                          >
                            Close
                          </button>
                        </div>
                      );
                    }

                    const isBranchPoint = currentNode.type === "BranchPoint";
                    const isScene = currentNode.type === "Scene";

                    return (
                      <div className="relative flex w-full max-w-3xl flex-col gap-4 rounded-2xl border border-slate-600 bg-gradient-to-b from-slate-900 to-slate-950 p-8 text-slate-100 shadow-2xl">
                        {/* Close button */}
                        <button
                          type="button"
                          className="absolute right-4 top-4 rounded-md bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
                          onClick={() => setPlayModeNodeId(null)}
                        >
                          ✕ Close
                        </button>

                        {/* Node title/name */}
                        <div className="pr-12">
                          <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                            {currentNode.type}
                          </div>
                          <h2 className="mt-2 text-2xl font-bold text-slate-50">{currentNode.name}</h2>
                        </div>

                        {/* Node content based on type */}
                        <div className="flex-1 space-y-4 rounded-lg border border-slate-700/50 bg-slate-800/30 p-4">
                          {isScene && (() => {
                            const scene = currentNode as SceneNode;
                            return (
                              <div className="space-y-3">
                                {scene.parameters.narrativeAction && (
                                  <p className="text-sm leading-relaxed text-slate-200">
                                    {scene.parameters.narrativeAction}
                                  </p>
                                )}
                                {scene.parameters.dialogueVariants.length > 0 && (
                                  <div className="space-y-2 border-t border-slate-700/50 pt-3">
                                    {scene.parameters.dialogueVariants.map((variant) => (
                                      <div key={variant.id} className="text-sm text-slate-300">
                                        <span className="font-semibold text-emerald-400">Dialogue:</span> {variant.text}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {isBranchPoint && (() => {
                            const branch = currentNode as BranchPointNode;
                            return (
                              <div className="space-y-2">
                                <p className="text-sm text-slate-300">
                                  {branch.parameters.conditionType === "playerChoice"
                                    ? "What do you choose?"
                                    : `Branching logic: ${branch.parameters.conditionType}`}
                                </p>
                              </div>
                            );
                          })()}

                          {(currentNode.type === "Act" || currentNode.type === "Route" || currentNode.type === "Event") && (
                            <div className="text-sm text-slate-300">
                              {String((currentNode as ActNode | RouteNode | EventNode).parameters.description || `[${currentNode.type} node]`)}
                            </div>
                          )}
                        </div>

                        {/* Navigation buttons */}
                        <div className="flex gap-3">
                          {isBranchPoint && (() => {
                            const branch = currentNode as BranchPointNode;
                            return (
                              <>
                                {branch.parameters.choices.map((choice) => {
                                  const nextNodeId = getChoiceTarget(playModeNodeId, choice.id);
                                  return (
                                    <button
                                      key={choice.id}
                                      type="button"
                                      className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                                        nextNodeId
                                          ? "bg-blue-600 hover:bg-blue-700"
                                          : "bg-slate-600 cursor-not-allowed opacity-50"
                                      }`}
                                      onClick={() => handlePlayModeNavigate(nextNodeId)}
                                      disabled={!nextNodeId}
                                    >
                                      {choice.text || "Unnamed Choice"}
                                    </button>
                                  );
                                })}
                              </>
                            );
                          })()}

                          {!isBranchPoint && (() => {
                            const nextNodeId = getNextNodeForPlayMode(playModeNodeId);
                            return (
                              <button
                                type="button"
                                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                                  nextNodeId
                                    ? "bg-emerald-600 hover:bg-emerald-700"
                                    : "bg-slate-600 cursor-not-allowed opacity-50"
                                }`}
                                onClick={() => handlePlayModeNavigate(nextNodeId)}
                              >
                                {nextNodeId ? "Continue →" : "End of Path"}
                              </button>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
        <aside className="flex min-h-0 flex-col border-r border-slate-700/80 bg-slate-900/65 p-3 overflow-hidden">
          <div className="mb-3 rounded-xl border border-slate-700/70 bg-slate-950/80 p-1">
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className={`rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  leftPanelTab === "hierarchy"
                    ? "bg-slate-700 text-slate-50 shadow-inner shadow-slate-950/40"
                    : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
                }`}
                onClick={() => setLeftPanelTab("hierarchy")}
              >
                Hierarchy
              </button>
              <button
                type="button"
                className={`rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  leftPanelTab === "chat"
                    ? "bg-fuchsia-600/80 text-white shadow-lg shadow-fuchsia-950/30"
                    : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
                }`}
                onClick={() => setLeftPanelTab("chat")}
              >
                AI Co-pilot
              </button>
            </div>
          </div>

          {leftPanelTab === "chat" ? (
            <div className="flex h-full min-h-0 flex-col rounded-xl border border-slate-700/70 bg-slate-950/60 p-3 overflow-hidden">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex-1">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">AI Co-pilot</h2>
                  <p className="mt-1 text-xs text-slate-500">Phase 4 workspace stub for guided generation.</p>
                </div>
                <div className="flex flex-col gap-2 items-end">
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">LLM</label>
                  <select
                    className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-slate-600 focus:outline-none focus:border-fuchsia-500"
                    value={project.llmProvider || "gemini"}
                    onChange={(e) => {
                      const next = e.target.value as "gemini" | "ollama";
                      commitProject((prev) => ({ ...prev, llmProvider: next }));
                    }}
                  >
                    <option value="gemini">Cloud (Gemini)</option>
                    <option value="ollama">Local (Ollama)</option>
                  </select>
                  {project.llmProvider === "ollama" ? (
                    <input
                      className="w-44 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-fuchsia-500"
                      value={project.localModelName || "qwen2.5:0.5b"}
                      placeholder="e.g., qwen2.5:0.5b"
                      onChange={(e) => {
                        const next = e.target.value;
                        commitProject((prev) => ({ ...prev, localModelName: next }));
                      }}
                    />
                  ) : null}
                </div>
              </div>

              <div ref={aiChatScrollRef} className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
                {aiChatMessages.length === 0 ? (
                  <div className="rounded-2xl border border-fuchsia-500/20 bg-slate-900/70 p-4 text-sm text-slate-300 shadow-lg shadow-slate-950/40">
                    <div className="text-xs font-semibold uppercase tracking-wider text-fuchsia-300">Ready</div>
                    <p className="mt-2 leading-relaxed">
                      🤖 AI Co-pilot ready. Hold SHIFT + Drag on the canvas to select nodes and include them in context.
                    </p>
                  </div>
                ) : (
                  aiChatMessages.map((message) => (
                    <div
                      key={message.id}
                      className={`rounded-2xl border p-4 text-sm shadow-lg shadow-slate-950/40 ${
                        message.role === "user"
                          ? "ml-8 border-slate-700 bg-slate-900/75 text-slate-100"
                          : message.role === "system"
                            ? "border-amber-500/20 bg-amber-500/10 text-amber-50"
                            : "border-fuchsia-500/20 bg-slate-900/70 text-slate-300"
                      }`}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        {message.role === "user" ? "You" : message.role === "system" ? "Prompt Package" : "AI Co-pilot"}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{message.content}</p>
                    </div>
                  ))
                )}
              </div>

              {isAwaitingApproval && (
                <div className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-900/20 p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-amber-200">Review Changes</div>
                      <div className="text-xs text-amber-300">{stagedMutations.length} proposed change(s) from the agent pending your approval.</div>
                      <div className="mt-3 space-y-2">
                        {stagedMutations.map((mutation, index) => (
                          <div key={`${mutation.action}-${mutation.node_id ?? mutation.edge?.id ?? index}`} className="rounded-lg border border-amber-500/20 bg-slate-950/50 px-3 py-2 text-xs text-amber-50">
                            <div className="font-semibold text-amber-100">{summarizeMutation(mutation)}</div>
                            {mutation.warnings && mutation.warnings.length > 0 ? (
                              <div className="mt-2 space-y-1 text-amber-200">
                                {mutation.warnings.map((warning, warningIndex) => (
                                  <div key={`${warningIndex}-${warning}`} className="flex gap-2">
                                    <span>⚠️</span>
                                    <span>{warning}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      {allStagedWarnings.length > 0 ? (
                        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                          <div className="font-semibold uppercase tracking-wider text-amber-200">Warnings</div>
                          <div className="mt-2 space-y-1">
                            {allStagedWarnings.map((warning, index) => (
                              <div key={`${warning}-${index}`} className="flex gap-2">
                                <span>⚠️</span>
                                <span>{warning}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-semibold"
                        onClick={handleApprove}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-rose-600 px-3 py-1 text-sm font-semibold"
                        onClick={handleReject}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-3 shrink-0 rounded-2xl border border-slate-700/70 bg-slate-950/80 p-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Agent Status</span>
                  {agentStatus === "error" ? (
                    <button
                      type="button"
                      className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-100 hover:bg-rose-500/20"
                      onClick={() => {
                        setAgentStatus("idle");
                        setAgentStatusMessage("");
                      }}
                    >
                      ✖ Dismiss
                    </button>
                  ) : null}
                </div>
                <div className={`flex items-start gap-3 rounded-xl border px-3 py-2 text-sm ${
                  agentStatus === "planning"
                    ? "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-100"
                    : agentStatus === "completed"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                      : agentStatus === "error"
                        ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
                        : "border-slate-700 bg-slate-900/70 text-slate-300"
                }`}>
                  <div
                    className={`h-2.5 w-2.5 rounded-full ${
                      agentStatus === "planning"
                        ? "animate-pulse bg-fuchsia-400 shadow-[0_0_18px_rgba(217,70,239,0.8)]"
                        : agentStatus === "completed"
                          ? "bg-emerald-400"
                          : agentStatus === "error"
                            ? "bg-rose-400"
                            : "bg-slate-500"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="font-semibold capitalize">{agentStatus}</div>
                    <div className="break-words whitespace-pre-wrap text-xs text-slate-400">{agentStatusMessage || "Idle"}</div>
                  </div>
                </div>
              </div>

              <div className="mt-3 shrink-0 rounded-2xl border border-slate-700/70 bg-slate-950/80 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">TODO List</div>
                  <div className="text-[11px] text-slate-500">Planner output</div>
                </div>
                <div className="space-y-2 max-h-[150px] overflow-y-auto pr-2">
                  {agentTasks.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-700/80 bg-slate-900/40 px-3 py-4 text-sm text-slate-500">
                      No tasks yet. Send a request to generate an agent plan.
                    </div>
                  ) : (
                    agentTasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-start gap-3 rounded-xl border border-slate-700/80 bg-slate-900/70 px-3 py-3 shadow-sm shadow-slate-950/30"
                      >
                        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-500 text-[10px] text-slate-400">
                          {task.status === "pending" ? "○" : "✓"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Task {task.id}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                              task.status === "pending"
                                ? "bg-slate-800 text-slate-400"
                                : task.status === "done"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-fuchsia-500/15 text-fuchsia-300"
                            }`}>
                              {task.status}
                            </span>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-slate-200 break-words whitespace-pre-wrap">{task.desc}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="mt-3 shrink-0 flex items-center justify-between">
                <div
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                    selectedCanvasNodeCount > 0
                      ? "border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-200 shadow-[0_0_24px_rgba(217,70,239,0.18)]"
                      : "border-slate-700 bg-slate-900 text-slate-400"
                  }`}
                >
                  Context: {selectedCanvasNodeCount} nodes selected
                </div>
              </div>

              <div className="mt-3 shrink-0 rounded-2xl border border-slate-700/70 bg-slate-950/80 p-3">
                <div className="relative">
                  {/* ── Floating Lore Context Popover ───────────── */}
                  {isLorePopoverOpen && (
                    <div
                      ref={lorePopoverRef}
                      className="absolute bottom-full mb-2 right-0 left-0 z-50 rounded-xl border border-slate-600/80 bg-slate-900/95 shadow-2xl shadow-black/40 backdrop-blur-sm"
                      style={{ maxHeight: "220px" }}
                    >
                      <div className="flex items-center justify-between border-b border-slate-700/70 px-3 py-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-fuchsia-300">Lore Context</span>
                        <button
                          type="button"
                          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                          onMouseDown={(e) => { e.preventDefault(); setIsLorePopoverOpen(false); }}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="overflow-y-auto px-1 py-1" style={{ maxHeight: "176px" }}>
                        {loreContextOptions.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-slate-500 italic">No lore entities available. Add characters, locations, or tags in the Lore Editor.</div>
                        ) : (
                          loreContextOptions.map((item) => {
                            const isChecked = selectedLoreContext.includes(item.key);
                            return (
                              <label
                                key={item.key}
                                className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                                  isChecked
                                    ? "bg-fuchsia-500/15 text-fuchsia-200"
                                    : "text-slate-300 hover:bg-slate-800/60"
                                }`}
                                onMouseDown={(e) => e.preventDefault()}
                              >
                                <input
                                  type="checkbox"
                                  className="accent-fuchsia-500"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedLoreContext((prev) =>
                                      isChecked ? prev.filter((k) => k !== item.key) : [...prev, item.key],
                                    );
                                  }}
                                />
                                <span>{item.label}</span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Lore toggle button + selected count ─────── */}
                  <div className="mb-2 flex items-center justify-between">
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${
                        selectedLoreContextItems.length > 0
                          ? "border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/20"
                          : "border-slate-700 bg-slate-800/60 text-slate-400 hover:bg-slate-700/80 hover:text-slate-200"
                      }`}
                      onClick={() => setIsLorePopoverOpen((prev) => !prev)}
                    >
                      <span>📖</span>
                      <span>Lore{selectedLoreContextItems.length > 0 ? ` (${selectedLoreContextItems.length})` : ""}</span>
                      <span className="text-[10px]">{isLorePopoverOpen ? "▲" : "▼"}</span>
                    </button>
                    {selectedLoreContextItems.length > 0 && (
                      <button
                        type="button"
                        className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                        onClick={() => setSelectedLoreContext([])}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <textarea
                  ref={aiChatInputRef}
                  className="max-h-[150px] min-h-[80px] w-full resize-none overflow-y-auto border-0 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
                  placeholder="Ask the AI Co-pilot to draft, revise, or branch the story..."
                  value={aiChatDraft}
                  onInput={(event) => {
                    event.currentTarget.style.height = "auto";
                    event.currentTarget.style.maxHeight = "150px";
                    event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
                  }}
                  onChange={(event) => setAiChatDraft(event.target.value)}
                />
                <div className="mt-3 flex items-center justify-between">
                  {selectedLoreContextItems.length > 0 && (
                    <div className="flex flex-wrap gap-1 max-w-[65%]">
                      {selectedLoreContextItems.slice(0, 3).map((item) => (
                        <span key={item.key} className="inline-flex items-center rounded-full bg-fuchsia-500/10 border border-fuchsia-500/20 px-2 py-0.5 text-[10px] text-fuchsia-300">
                          {item.kind === "Character" ? "👤" : item.kind === "Location" ? "📍" : "🏷️"} {item.id}
                        </span>
                      ))}
                      {selectedLoreContextItems.length > 3 && (
                        <span className="text-[10px] text-slate-500">+{selectedLoreContextItems.length - 3} more</span>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="ml-auto rounded-md bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-fuchsia-500"
                    onClick={() => {
                        setIsLorePopoverOpen(false);
                        handleAiChatSend();
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}
        </aside>

        <section
          ref={reactFlowWrapperRef}
          className="reactflow-wrapper relative h-full min-h-0 w-full bg-slate-950/40"
          style={{ width: "100%", height: "100%" }}
          onClick={() => setContextMenu(null)}
        >
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-full border border-slate-700/60 bg-slate-950/70 px-3 py-1.5 text-sm text-slate-500 shadow-lg backdrop-blur">
            💡 Hold [Shift] + Drag to multi-select nodes
          </div>
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
                <div className="flex flex-col gap-2">
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                    value={selectedTagToAdd}
                    onChange={(event) => setSelectedTagToAdd(event.target.value)}
                  >
                    {layerCatalog.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                  <button className="w-full rounded-md bg-slate-700 px-3 py-1 text-sm" onClick={addSelectedTag}>
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
                <div className="mt-2 flex flex-col gap-2">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                    placeholder="Search presets"
                    value={tagSearch}
                    onChange={(event) => setTagSearch(event.target.value)}
                  />
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                    placeholder="new tag"
                    value={newTagInput}
                    onChange={(event) => setNewTagInput(event.target.value)}
                  />
                  <button className="w-full rounded-md bg-indigo-600 px-3 py-1 text-sm" onClick={addNewTag}>
                    Create new tag
                  </button>
                </div>
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
              {/* Header row */}
              <div className="flex flex-wrap justify-between items-center mb-4 gap-3">
                <h2 className="text-xl font-bold">Editing Lore: <span className="text-emerald-400">{selectedLoreId}</span></h2>
                <div className="flex items-center gap-2">
                  {/* Mode toggle */}
                  <div className="flex rounded-md bg-slate-900 p-1 gap-1">
                    <button
                      type="button"
                      className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${loreViewMode === "draft" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
                      onClick={() => setLoreViewMode("draft")}
                    >
                      Draft Mode
                    </button>
                    <button
                      type="button"
                      className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${loreViewMode === "structured" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
                      onClick={() => setLoreViewMode("structured")}
                    >
                      Structured Mode
                    </button>
                  </div>
                  <button
                    onClick={saveLoreText}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded font-semibold transition-colors text-sm"
                  >
                    Save Details
                  </button>
                </div>
              </div>

              {loreViewMode === "draft" ? (
                /* ── Draft Mode ─────────────────────────────────────── */
                <div className="flex flex-col flex-1 gap-3">
                  <textarea
                    className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-md p-4 text-slate-200 font-mono text-sm resize-none focus:outline-none focus:border-emerald-500 min-h-[300px]"
                    value={activeLoreText}
                    onChange={(e) => setActiveLoreText(e.target.value)}
                    placeholder={`Write anything about ${selectedLoreId} here — stream of consciousness, notes, backstory fragments...`}
                  />
                  <button
                    type="button"
                    disabled={isStructurizing || !activeLoreText.trim()}
                    onClick={structurizeWithAI}
                    className={`self-start flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
                      isStructurizing || !activeLoreText.trim()
                        ? "bg-violet-800/50 text-slate-400 cursor-not-allowed"
                        : "bg-violet-600 hover:bg-violet-500 text-white"
                    }`}
                  >
                    {isStructurizing ? (
                      <><span className="animate-spin">⏳</span> Structurizing…</>
                    ) : (
                      <>✨ Structurize with AI</>
                    )}
                  </button>
                  <p className="text-xs text-slate-500">
                    The AI will extract structured fields (Role, Aliases, Public Description, Hidden Traits) from your draft and automatically switch to Structured Mode.
                  </p>
                </div>
              ) : (
                /* ── Structured Mode ─────────────────────────────────── */
                <div className="space-y-4 overflow-auto">
                  <div>
                    <label className="block mb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Role</label>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                      value={loreStructuredEdit.role}
                      onChange={(e) => setLoreStructuredEdit(prev => ({ ...prev, role: e.target.value }))}
                      placeholder="e.g. Main antagonist, Comic relief, Quest giver…"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Aliases / Names</label>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                      value={loreStructuredEdit.aliases}
                      onChange={(e) => setLoreStructuredEdit(prev => ({ ...prev, aliases: e.target.value }))}
                      placeholder="e.g. The Shadow, Lord Malachar, Mal…"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Public Description</label>
                    <textarea
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                      rows={4}
                      value={loreStructuredEdit.publicDescription}
                      onChange={(e) => setLoreStructuredEdit(prev => ({ ...prev, publicDescription: e.target.value }))}
                      placeholder="What most characters know about this entity…"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Hidden Traits / Secrets</label>
                    <textarea
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-rose-200 bg-rose-950/20 resize-none focus:outline-none focus:border-rose-500"
                      rows={4}
                      value={loreStructuredEdit.hiddenTraits}
                      onChange={(e) => setLoreStructuredEdit(prev => ({ ...prev, hiddenTraits: e.target.value }))}
                      placeholder="Secrets, hidden motivations, true nature — only revealed at key plot points…"
                    />
                  </div>
                  <p className="text-xs text-slate-500">
                    Switch to <strong className="text-slate-300">Draft Mode</strong> to edit the raw notes. Hit <strong className="text-slate-300">Save Details</strong> to persist both views.
                  </p>
                </div>
              )}
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
              <div className="mb-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">LLM Provider</div>
                <div className="text-sm">
                  <select
                    className="rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                    value={project.llmProvider || "gemini"}
                    onChange={(e) => {
                      const next = e.target.value as "gemini" | "ollama";
                      commitProject((previous) => ({ ...previous, llmProvider: next }));
                    }}
                  >
                    <option value="gemini">Cloud API (Gemini/OpenAI)</option>
                    <option value="ollama">Local (Ollama)</option>
                  </select>
                </div>
              </div>
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
    // Save to recent projects
    try {
      const recentProjectsKey = "plot-architect:recentProjects";
      const stored = localStorage.getItem(recentProjectsKey);
      const recent = stored ? JSON.parse(stored) : [];
      const filtered = recent.filter((p: any) => p.path !== projectPath);
      const updated = [
        { path: projectPath, name: projectName, timestamp: Date.now() },
        ...filtered,
      ].slice(0, 10);
      localStorage.setItem(recentProjectsKey, JSON.stringify(updated));
    } catch {
      // Silently fail
    }
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

