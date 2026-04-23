import { PlotNode } from "../types/plot";

export function sanitizeNodeForAI(node: PlotNode) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    layerTags: node.layerTags,
    connectedFrom: node.connectedFrom,
    connectedTo: node.connectedTo,
    parameters: node.parameters,
  };
}
