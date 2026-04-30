import { PlotNode, PlotNodeType, PlotProject } from "../types/plot";

export const createNodeId = (type: PlotNodeType): string =>
  `node_${type.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`;

export const createDefaultNode = (
  type: PlotNodeType,
  x: number,
  y: number,
): PlotNode => {
  const id = createNodeId(type);

  const common = {
    id,
    type,
    name: `${type} Node`,
    position: { x, y },
    layerTags: [],
    connectedFrom: [],
    connectedTo: [],
  };

  if (type === "Act") {
    return {
      ...common,
      type,
      parameters: {
        order: 1,
        title: "Act 1",
        description: "",
        requiredFlags: [],
        overrides: [],
        isStart: false,
      },
    };
  }

  if (type === "Route") {
    return {
      ...common,
      type,
      parameters: {
        divergencePoint: "",
        conditions: [],
        title: "Route A",
        color: "#3b82f6",
      },
    };
  }

  if (type === "Scene") {
    return {
      ...common,
      type,
      parameters: {
        actingCharacters: [],
        locationId: "",
        timeOfDay: "evening",
        toneAndMood: "",
        narrativeAction: "",
        goal: "",
        constraints: "",
        triggers: [],
        dialogueVariants: [],
        defaultNextNode: "",
        visualImportant: false,
      },
    };
  }

  if (type === "Event") {
    return {
      ...common,
      type,
      parameters: {
        effects: [],
      },
    };
  }

  if (type === "BranchPoint") {
    return {
      ...common,
      type,
      parameters: {
        conditionType: "playerChoice",
        branches: [],
        choices: [],
      },
    };
  }

  throw new Error(`Unknown node type: ${type}`);
};

export const defaultProject: PlotProject = {
  meta: {
    title: "My Visual Novel",
    version: "0.1",
  },
  globalStylePrompt: "",
  nodes: {
    node_act_001: {
      id: "node_act_001",
      type: "Act",
      name: "Act 1: The Lab",
      position: { x: 80, y: 220 },
      layerTags: ["global", "day_1"],
      connectedFrom: [],
      connectedTo: ["node_scene_001"],
      parameters: {
        order: 1,
        title: "Act 1",
        description: "Main setup in laboratory.",
        requiredFlags: [],
        overrides: [],
        isStart: true,
      },
    },
    node_scene_001: {
      id: "node_scene_001",
      type: "Scene",
      name: "Meeting Anna in the Lab",
      position: { x: 430, y: 180 },
      layerTags: ["day_1", "route_a"],
      connectedFrom: ["node_act_001"],
      connectedTo: ["node_branch_001", "node_scene_002"],
      parameters: {
        actingCharacters: [
          { characterId: "mc", presetState: "curious", relationships: "" },
          { characterId: "anna", presetState: "distrustful", relationships: "mc: suspicious" },
          { characterId: "doctor", presetState: "busy", relationships: "" }
        ],
        locationId: "lab_main_hall",
        timeOfDay: "evening",
        toneAndMood: "Tense and mysterious.",
        narrativeAction: "MC meets Anna. Anna tries to hide something.",
        goal: "Establish Anna's distrust.",
        constraints: "Don't mention the outside world yet.",
        triggers: [{ type: "flag", key: "lab_visited", value: true }],
        dialogueVariants: [
          {
            id: "var1",
            text: "I refuse to go with you",
            effects: [
              { target: "flag", key: "escape_attempt", value: true },
              {
                target: "relation",
                character: "anna",
                affinity: -20,
                value: -20,
              },
            ],
            nextNode: "node_scene_002",
          },
        ],
        defaultNextNode: "node_branch_001",
        visualImportant: true,
      },
    },
    node_branch_001: {
      id: "node_branch_001",
      type: "BranchPoint",
      name: "Branch: Anna Trust",
      position: { x: 820, y: 160 },
      layerTags: ["route_a", "day_1"],
      connectedFrom: ["node_scene_001"],
      connectedTo: ["node_scene_002"],
      parameters: {
        conditionType: "relationCheck",
        branches: [
          { label: "Trust", condition: "anna_affinity >= 40", nextNode: "node_scene_002" },
        ],
        choices: [],
      },
    },
    node_scene_002: {
      id: "node_scene_002",
      type: "Scene",
      name: "Escape Attempt",
      position: { x: 1160, y: 260 },
      layerTags: ["route_a", "escape_attempt", "day_1"],
      connectedFrom: ["node_scene_001", "node_branch_001"],
      connectedTo: [],
      parameters: {
        actingCharacters: [
          { characterId: "mc", presetState: "worried", relationships: "" },
          { characterId: "anna", presetState: "panicked", relationships: "mc: needs help but still suspicious" }
        ],
        locationId: "lab_corridor",
        timeOfDay: "night",
        toneAndMood: "Action-packed, urgent.",
        narrativeAction: "Running away from guards.",
        goal: "Reach the exit door.",
        constraints: "No magic used.",
        triggers: [{ type: "flag", key: "escape_attempt", value: true }],
        dialogueVariants: [],
        defaultNextNode: "",
        visualImportant: false,
      },
    },
  },
  acts: ["node_act_001"],
  routes: [],
  startNodeId: "node_act_001",
  characters: [
    { id: "mc", icon: "sprites/mc_base.png" },
    { id: "anna", icon: "sprites/anna_base.png" },
    { id: "doctor", icon: "sprites/doctor_base.png" },
  ],
  locations: [
    {
      id: "lab_main_hall",
      title: "Lab Main Hall",
      preview: "locations/lab_main_hall.png",
    },
    {
      id: "lab_corridor",
      title: "Lab Corridor",
      preview: "locations/lab_corridor.png",
    },
  ],
  globalFlags: ["lab_visited", "escape_attempt"],
  layerPresets: ["global", "day_1", "day_2", "route_a", "route_b", "escape_attempt", "bad_end"],
  lore: {},
  llmProvider: 'gemini',
  localModelName: 'qwen2.5:0.5b',
};
