import { useMemo } from "react";
import type { TreeNode, TreeEdge } from "../lib/api";

interface BranchGraphProps {
  nodes: TreeNode[];
  edges: TreeEdge[];
  defaultBranch: string;
  selectedBranch: string | null;
  onSelectBranch: (branchName: string) => void;
}

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  node: TreeNode;
  depth: number;
  row: number;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  isDesigned: boolean;
}

const NODE_WIDTH = 250;
const NODE_HEIGHT = 36;
const HORIZONTAL_GAP = 40;
const VERTICAL_GAP = 20;
const PADDING = 20;

export default function BranchGraph({
  nodes,
  edges,
  defaultBranch,
  selectedBranch,
  onSelectBranch,
}: BranchGraphProps) {
  const { layoutNodes, layoutEdges, width, height } = useMemo(() => {
    if (nodes.length === 0) {
      return { layoutNodes: [], layoutEdges: [], width: 400, height: 200 };
    }

    // Build adjacency map (parent -> children)
    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string>();

    edges.forEach((edge) => {
      const children = childrenMap.get(edge.parent) || [];
      children.push(edge.child);
      childrenMap.set(edge.parent, children);
      parentMap.set(edge.child, edge.parent);
    });

    // Find root nodes (nodes that are not children of any other node)
    const childSet = new Set(edges.map((e) => e.child));
    const rootNodes = nodes.filter((n) => !childSet.has(n.branchName));

    // Sort roots: default branch first
    rootNodes.sort((a, b) => {
      if (a.branchName === defaultBranch) return -1;
      if (b.branchName === defaultBranch) return 1;
      return a.branchName.localeCompare(b.branchName);
    });

    // Layout nodes - horizontal tree (root on left, children to right)
    const layoutNodes: LayoutNode[] = [];
    const nodeMap = new Map<string, LayoutNode>();

    function layoutSubtree(branchName: string, depth: number, minRow: number): number {
      const node = nodes.find((n) => n.branchName === branchName);
      if (!node || nodeMap.has(branchName)) return minRow;

      const children = childrenMap.get(branchName) || [];

      // Place this node at the top of its subtree (minRow)
      const row = minRow;

      // Horizontal layout: depth controls X, row controls Y
      const layoutNode: LayoutNode = {
        id: branchName,
        x: PADDING + depth * (NODE_WIDTH + HORIZONTAL_GAP),
        y: PADDING + row * (NODE_HEIGHT + VERTICAL_GAP),
        node,
        depth,
        row,
      };

      layoutNodes.push(layoutNode);
      nodeMap.set(branchName, layoutNode);

      // Layout children below (they go to the right, starting from the same row)
      let currentRow = minRow;
      children.forEach((childName) => {
        currentRow = layoutSubtree(childName, depth + 1, currentRow);
      });

      // Return the next available row (at least minRow + 1 for this node)
      return Math.max(currentRow, minRow + 1);
    }

    // Layout from each root
    let nextRow = 0;
    rootNodes.forEach((root) => {
      nextRow = layoutSubtree(root.branchName, 0, nextRow);
    });

    // Handle orphan nodes (not connected to any root)
    nodes.forEach((node) => {
      if (!nodeMap.has(node.branchName)) {
        const depth = 0;
        const row = nextRow++;

        const layoutNode: LayoutNode = {
          id: node.branchName,
          x: PADDING + depth * (NODE_WIDTH + HORIZONTAL_GAP),
          y: PADDING + row * (NODE_HEIGHT + VERTICAL_GAP),
          node,
          depth,
          row,
        };
        layoutNodes.push(layoutNode);
        nodeMap.set(node.branchName, layoutNode);
      }
    });

    // Create layout edges
    const layoutEdges: LayoutEdge[] = edges
      .map((edge) => {
        const from = nodeMap.get(edge.parent);
        const to = nodeMap.get(edge.child);
        if (from && to) {
          return { from, to, isDesigned: edge.isDesigned ?? false };
        }
        return null;
      })
      .filter(Boolean) as LayoutEdge[];

    // Calculate canvas size
    const maxX = Math.max(...layoutNodes.map((n) => n.x)) + NODE_WIDTH + PADDING;
    const maxY = Math.max(...layoutNodes.map((n) => n.y)) + NODE_HEIGHT + PADDING;

    return {
      layoutNodes,
      layoutEdges,
      width: Math.max(400, maxX),
      height: Math.max(150, maxY),
    };
  }, [nodes, edges, defaultBranch]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    // Horizontal edge: from right side of parent to left side of child
    const startX = edge.from.x + NODE_WIDTH;
    const startY = edge.from.y + NODE_HEIGHT / 2;
    const endX = edge.to.x;
    const endY = edge.to.y + NODE_HEIGHT / 2;

    // Simple right-angle path: go right, then vertical, then right to target
    const cornerX = startX + 20;
    const path = `M ${startX} ${startY} L ${cornerX} ${startY} L ${cornerX} ${endY} L ${endX} ${endY}`;

    return (
      <g key={`edge-${index}`}>
        <path
          d={path}
          fill="none"
          stroke={edge.isDesigned ? "#9c27b0" : "#ccc"}
          strokeWidth={edge.isDesigned ? 2 : 1.5}
        />
        {/* Arrow head pointing right */}
        <polygon
          points={`${endX},${endY} ${endX - 6},${endY - 3} ${endX - 6},${endY + 3}`}
          fill={edge.isDesigned ? "#9c27b0" : "#ccc"}
        />
      </g>
    );
  };

  const renderNode = (layoutNode: LayoutNode) => {
    const { id, x, y, node } = layoutNode;
    const isSelected = selectedBranch === id;
    const isDefault = id === defaultBranch;
    const hasWorktree = !!node.worktree;
    const hasPR = !!node.pr;

    // Determine node color
    let fillColor = "#fff";
    let strokeColor = "#ddd";

    if (isDefault) {
      fillColor = "#e3f2fd";
      strokeColor = "#2196f3";
    } else if (node.worktree?.isActive) {
      fillColor = "#e8f5e9";
      strokeColor = "#4caf50";
    } else if (hasPR) {
      if (node.pr?.state === "MERGED") {
        fillColor = "#f3e5f5";
        strokeColor = "#9c27b0";
      } else if (node.pr?.state === "OPEN") {
        fillColor = "#fff3e0";
        strokeColor = "#ff9800";
      }
    }

    if (isSelected) {
      strokeColor = "#1976d2";
    }

    // Truncate branch name if too long
    const displayName = id.length > 30 ? id.slice(0, 28) + "..." : id;

    return (
      <g
        key={id}
        onClick={() => onSelectBranch(id)}
        style={{ cursor: "pointer" }}
      >
        {/* Node rectangle */}
        <rect
          x={x}
          y={y}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={4}
          ry={4}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isSelected ? 2 : 1.5}
        />

        {/* Branch name */}
        <text
          x={x + 10}
          y={y + NODE_HEIGHT / 2 + 1}
          textAnchor="start"
          dominantBaseline="middle"
          fontSize={11}
          fontFamily="monospace"
          fontWeight={isDefault ? "bold" : "normal"}
          fill="#333"
        >
          {displayName}
        </text>

        {/* Status indicators on right side */}
        {hasWorktree && (
          <circle
            cx={x + NODE_WIDTH - 12}
            cy={y + NODE_HEIGHT / 2}
            r={5}
            fill={node.worktree?.isActive ? "#4caf50" : "#9e9e9e"}
          />
        )}

        {hasPR && (
          <g>
            <rect
              x={x + NODE_WIDTH - 28}
              y={y + 4}
              width={24}
              height={14}
              rx={2}
              fill={node.pr?.state === "MERGED" ? "#9c27b0" : node.pr?.state === "OPEN" ? "#2196f3" : "#9e9e9e"}
            />
            <text
              x={x + NODE_WIDTH - 16}
              y={y + 12}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={8}
              fill="white"
              fontWeight="bold"
            >
              PR
            </text>
          </g>
        )}

        {/* Ahead/Behind indicator below node */}
        {node.aheadBehind && (node.aheadBehind.ahead > 0 || node.aheadBehind.behind > 0) && (
          <g>
            {node.aheadBehind.ahead > 0 && (
              <>
                <rect
                  x={x + NODE_WIDTH / 2 - 24}
                  y={y + NODE_HEIGHT + 4}
                  width={22}
                  height={14}
                  rx={3}
                  fill="#4caf50"
                />
                <text
                  x={x + NODE_WIDTH / 2 - 13}
                  y={y + NODE_HEIGHT + 12}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="white"
                  fontWeight="bold"
                >
                  +{node.aheadBehind.ahead}
                </text>
              </>
            )}
            {node.aheadBehind.behind > 0 && (
              <>
                <rect
                  x={x + NODE_WIDTH / 2 + 2}
                  y={y + NODE_HEIGHT + 4}
                  width={22}
                  height={14}
                  rx={3}
                  fill="#f44336"
                />
                <text
                  x={x + NODE_WIDTH / 2 + 13}
                  y={y + NODE_HEIGHT + 12}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="white"
                  fontWeight="bold"
                >
                  -{node.aheadBehind.behind}
                </text>
              </>
            )}
          </g>
        )}
      </g>
    );
  };

  if (nodes.length === 0) {
    return (
      <div className="branch-graph branch-graph--empty">
        <p>No branches to display</p>
      </div>
    );
  }

  return (
    <div className="branch-graph">
      <svg width={width} height={height} className="branch-graph__svg">
        {/* Render edges first (behind nodes) */}
        <g className="branch-graph__edges">
          {layoutEdges.map((edge, i) => renderEdge(edge, i))}
        </g>

        {/* Render nodes */}
        <g className="branch-graph__nodes">
          {layoutNodes.map((node) => renderNode(node))}
        </g>
      </svg>
    </div>
  );
}
