export type PlotNodeType = "Act" | "Route" | "Scene" | "Event" | "BranchPoint";

export type Tag = {
  id: string;
  name: string;
  description: string;
};

export type StructuredLore = {
  role: string;
  aliases: string;
  publicDescription: string;
  hiddenTraits: string;
};

export type ConditionType = "playerChoice" | "flagCheck" | "random" | "relationCheck";

export type Effect = {
  target: string;
  field?: string;
  key?: string;
  flag?: string;
  value: string | number | boolean;
  operator?: "set" | "add" | "sub";
  character?: string;
  affinity?: number;
};

export type Trigger = {
  type: string;
  key: string;
  value: string | number | boolean;
};

export type DialogueVariant = {
  id: string;
  text: string;
  effects: Effect[];
  nextNode?: string;
};

export type NodeOverride = {
  id: string;
  targetId: string;
  property: string;
  newValue: string;
};

export type PlotNodeBase = {
  id: string;
  type: PlotNodeType;
  name: string;
  position: { x: number; y: number };
  layerTags: string[];
  connectedFrom: string[];
  connectedTo: string[];
  parameters: Record<string, unknown>;
  data?: {
    generated_text?: string;
    [key: string]: any;
  };
};

export type ActNode = PlotNodeBase & {
  type: "Act";
  parameters: {
    order: number;
    title: string;
    description: string;
    requiredFlags: string[];
    overrides: NodeOverride[];
    isStart: boolean;
  };
};

export type RouteNode = PlotNodeBase & {
  type: "Route";
  parameters: {
    divergencePoint: string;
    conditions: { flag: string; value: boolean }[];
    title: string;
    color: string;
  };
};

export type Actor = {
  characterId: string;
  presetState: string;
  relationships: string;
};

export type SceneNode = PlotNodeBase & {
  type: "Scene";
  parameters: {
    actingCharacters: Actor[];
    locationId: string;
    timeOfDay: string;
    toneAndMood: string;
    narrativeAction: string;
    goal: string;
    constraints: string;
    triggers: Trigger[];
    dialogueVariants: DialogueVariant[];
    defaultNextNode?: string;
    visualImportant?: boolean;
    tagIds?: string[];
  };
};

export type EventNode = PlotNodeBase & {
  type: "Event";
  parameters: {
    effects: Effect[];
  };
};

export type BranchChoice = {
  id: string;
  text: string;
  nextNode?: string;
};

export type BranchPointNode = PlotNodeBase & {
  type: "BranchPoint";
  parameters: {
    conditionType: ConditionType;
    branches: { label: string; condition: string; nextNode?: string }[];
    choices: BranchChoice[];
  };
};

export type PlotNode = ActNode | RouteNode | SceneNode | EventNode | BranchPointNode;

export type PlotProject = {
  meta: {
    title: string;
    version: string;
  };
  globalStylePrompt: string;
  aiChatHistory?: AIChatMessage[];
  nodes: Record<string, PlotNode>;
  acts: string[];
  routes: string[];
  startNodeId?: string;
  characters: { id: string; icon: string }[];
  locations: { id: string; title: string; preview: string }[];
  globalFlags: string[];
  layerPresets: string[];
  lore?: Record<string, string>;
  llmProvider?: 'gemini' | 'ollama';
  localModelName?: string;
  loreStructured?: Record<string, StructuredLore>;
  tags?: Record<string, Tag>;
};

export type AIChatMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
};

export type AgentMutationRecord =
  | {
      type: string;
      action: "add_node";
      node: Record<string, unknown>;
      node_id?: string;
      edge?: { id?: string };
      data?: Record<string, unknown>;
      warnings?: string[];
    }
  | {
      type: string;
      action: "add_edge";
      edge: Record<string, unknown>;
      node_id?: string;
      data?: Record<string, unknown>;
      warnings?: string[];
    }
  | {
      type: string;
      action: "update_node";
      node_id: string;
      edge?: { id?: string };
      data: Record<string, unknown>;
      warnings?: string[];
    }
  | {
      type: string;
      action: "ADD_LORE";
      entityType: "character" | "location" | "tag";
      node_id?: string;
      edge?: { id?: string };
      payload: {
        id: string;
        name: string;
        description: string;
      };
      warnings?: string[];
    };
