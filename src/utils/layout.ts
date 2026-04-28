import dagre from "dagre";
import { Edge, Node as FlowNode } from "reactflow";
import { PlotNode } from "../types/plot";

const NODE_WIDTH = 300;
const NODE_HEIGHT = 150;

/**
 * Calculates new X,Y positions for nodes using Dagre's directed graph layout algorithm.
 * Arranges nodes hierarchically to prevent overlapping and create a clean visual structure.
 *
 * @param nodes - Array of plot nodes to be laid out
 * @param edges - Array of edges connecting the nodes
 * @param direction - Layout direction: 'LR' (left-to-right), 'TB' (top-to-bottom), etc. Defaults to 'LR'
 * @returns Tuple of [layoutedNodes, layoutedEdges] with updated position properties
 */
export function getLayoutedElements(
  nodes: (PlotNode | FlowNode)[],
  edges: Edge[],
  direction: "LR" | "RL" | "TB" | "BT" = "LR",
): { nodes: typeof nodes; edges: typeof edges } {
  // Create a new directed graph instance
  const graph = new dagre.graphlib.Graph({ compound: false });

  // Configure the graph layout parameters
  graph.setGraph({ rankdir: direction, nodesep: 80, ranksep: 120 });
  graph.setDefaultEdgeLabel(() => ({}));

  // Add all nodes to the graph with their dimensions
  nodes.forEach((node) => {
    graph.setNode(node.id, {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      label: node.id,
    });
  });

  // Add all edges to the graph
  edges.forEach((edge) => {
    graph.setEdge(edge.source, edge.target);
  });

  // Run the layout algorithm
  dagre.layout(graph);

  // Extract the new positions from the layout and apply them to nodes
  const layoutedNodes = nodes.map((node) => {
    const graphNode = graph.node(node.id);
    return {
      ...node,
      position: {
        x: (graphNode?.x ?? 0) - NODE_WIDTH / 2,
        y: (graphNode?.y ?? 0) - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}
