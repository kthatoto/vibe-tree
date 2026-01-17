import { useMemo, useState, useCallback } from "react";
import type { TreeNode, TreeEdge } from "../lib/api";

interface ExecuteBranchSelectorProps {
  nodes: TreeNode[];
  edges: TreeEdge[];
  defaultBranch: string;
  selectedBranches: string[];
  onSelectionChange: (branches: string[]) => void;
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

const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;
const HORIZONTAL_GAP = 24;
const VERTICAL_GAP = 40;
const TOP_PADDING = 20;
const LEFT_PADDING = 12;

export default function ExecuteBranchSelector({
  nodes,
  edges,
  defaultBranch,
  selectedBranches,
  onSelectionChange,
}: ExecuteBranchSelectorProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Handle branch selection toggle
  const handleToggleBranch = useCallback((branchName: string) => {
    const index = selectedBranches.indexOf(branchName);
    if (index >= 0) {
      // Remove from selection
      const newSelection = [...selectedBranches];
      newSelection.splice(index, 1);
      onSelectionChange(newSelection);
    } else {
      // Add to selection
      onSelectionChange([...selectedBranches, branchName]);
    }
  }, [selectedBranches, onSelectionChange]);

  // Get selection order number (1-indexed)
  const getSelectionOrder = useCallback((branchName: string): number | null => {
    const index = selectedBranches.indexOf(branchName);
    return index >= 0 ? index + 1 : null;
  }, [selectedBranches]);

  // Handle drag start
  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = "move";
    setDraggedIndex(index);
  };

  // Handle drag over
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

  // Handle drop
  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== dropIndex) {
      const newSelection = [...selectedBranches];
      const [draggedItem] = newSelection.splice(draggedIndex, 1);
      newSelection.splice(dropIndex, 0, draggedItem);
      onSelectionChange(newSelection);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  // Handle drag end
  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

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

    // Find root nodes
    const childSet = new Set(edges.map((e) => e.child));
    const rootNodes = nodes.filter((n) => !childSet.has(n.branchName));

    // Sort roots: default branch first
    rootNodes.sort((a, b) => {
      if (a.branchName === defaultBranch) return -1;
      if (b.branchName === defaultBranch) return 1;
      return a.branchName.localeCompare(b.branchName);
    });

    const layoutNodes: LayoutNode[] = [];
    const nodeMap = new Map<string, LayoutNode>();

    function layoutSubtree(branchName: string, depth: number, minCol: number): number {
      const node = nodes.find((n) => n.branchName === branchName);
      if (!node || nodeMap.has(branchName)) return minCol;

      const children = childrenMap.get(branchName) || [];
      const col = minCol;

      const layoutNode: LayoutNode = {
        id: branchName,
        x: LEFT_PADDING + col * (NODE_WIDTH + HORIZONTAL_GAP),
        y: TOP_PADDING + depth * (NODE_HEIGHT + VERTICAL_GAP),
        node,
        depth,
        row: col,
      };

      layoutNodes.push(layoutNode);
      nodeMap.set(branchName, layoutNode);

      let currentCol = minCol;
      children.forEach((childName) => {
        currentCol = layoutSubtree(childName, depth + 1, currentCol);
      });

      return Math.max(currentCol, minCol + 1);
    }

    let nextCol = 0;
    rootNodes.forEach((root) => {
      nextCol = layoutSubtree(root.branchName, 0, nextCol);
    });

    // Handle orphan nodes
    nodes.forEach((node) => {
      if (!nodeMap.has(node.branchName)) {
        const depth = 0;
        const col = nextCol++;

        const layoutNode: LayoutNode = {
          id: node.branchName,
          x: LEFT_PADDING + col * (NODE_WIDTH + HORIZONTAL_GAP),
          y: TOP_PADDING + depth * (NODE_HEIGHT + VERTICAL_GAP),
          node,
          depth,
          row: col,
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

    const maxX = Math.max(...layoutNodes.map((n) => n.x), 0) + NODE_WIDTH + LEFT_PADDING;
    const maxY = Math.max(...layoutNodes.map((n) => n.y + NODE_HEIGHT), 0) + TOP_PADDING;

    return {
      layoutNodes,
      layoutEdges,
      width: Math.max(400, maxX),
      height: Math.max(150, maxY),
    };
  }, [nodes, edges, defaultBranch]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    const startX = edge.from.x + NODE_WIDTH / 2;
    const startY = edge.from.y + NODE_HEIGHT;
    const endX = edge.to.x + NODE_WIDTH / 2;
    const endY = edge.to.y;

    const cornerY = startY + 15;
    const path = `M ${startX} ${startY} L ${startX} ${cornerY} L ${endX} ${cornerY} L ${endX} ${endY}`;

    return (
      <g key={`edge-${index}`}>
        <path
          d={path}
          fill="none"
          stroke="#4b5563"
          strokeWidth={1.5}
        />
        <polygon
          points={`${endX},${endY} ${endX - 4},${endY - 6} ${endX + 4},${endY - 6}`}
          fill="#4b5563"
        />
      </g>
    );
  };

  const renderNode = (layoutNode: LayoutNode) => {
    const { id, x, y, node } = layoutNode;
    const isDefault = id === defaultBranch;
    const selectionOrder = getSelectionOrder(id);
    const isSelected = selectionOrder !== null;
    const isMerged = node.pr?.state === "MERGED";

    // Determine node color
    let fillColor = "#1f2937";
    let strokeColor = isSelected ? "#3b82f6" : "#4b5563";

    if (isMerged) {
      fillColor = "#1a1625";
      strokeColor = isSelected ? "#3b82f6" : "#6b21a8";
    }

    return (
      <g
        key={id}
        style={{ cursor: isDefault ? "not-allowed" : "pointer" }}
        opacity={isMerged ? 0.6 : 1}
        onClick={() => !isDefault && handleToggleBranch(id)}
      >
        {/* Node rectangle */}
        <rect
          x={x}
          y={y}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={6}
          ry={6}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isSelected ? 2 : 1.5}
        />

        {/* Selection order badge */}
        {isSelected && (
          <g>
            <circle
              cx={x + NODE_WIDTH - 12}
              cy={y + 12}
              r={10}
              fill="#3b82f6"
            />
            <text
              x={x + NODE_WIDTH - 12}
              y={y + 13}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill="white"
              fontWeight="bold"
            >
              {selectionOrder}
            </text>
          </g>
        )}

        {/* Branch name */}
        <foreignObject
          x={x + 8}
          y={y + 4}
          width={NODE_WIDTH - (isSelected ? 32 : 16)}
          height={NODE_HEIGHT - 8}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: isDefault ? "bold" : "normal",
                color: isMerged ? "#9ca3af" : "#e5e7eb",
                wordBreak: "break-all",
                lineHeight: 1.2,
              }}
            >
              {id}
            </span>
          </div>
        </foreignObject>

        {/* Default branch indicator */}
        {isDefault && (
          <text
            x={x + NODE_WIDTH / 2}
            y={y + NODE_HEIGHT + 12}
            textAnchor="middle"
            fontSize={9}
            fill="#6b7280"
          >
            (base)
          </text>
        )}
      </g>
    );
  };

  if (nodes.length === 0) {
    return (
      <div className="execute-branch-selector execute-branch-selector--empty">
        <p>No branches available</p>
      </div>
    );
  }

  return (
    <div className="execute-branch-selector" style={{ display: "flex", gap: 16 }}>
      {/* Graph view */}
      <div style={{ flex: 1, overflow: "auto", maxHeight: 400 }}>
        <svg
          width={width}
          height={height}
          style={{ minWidth: "100%" }}
        >
          <g className="edges">
            {layoutEdges.map((edge, i) => renderEdge(edge, i))}
          </g>
          <g className="nodes">
            {layoutNodes.map((node) => renderNode(node))}
          </g>
        </svg>
      </div>

      {/* Selected branches list */}
      <div style={{
        width: 200,
        borderLeft: "1px solid #374151",
        paddingLeft: 16,
      }}>
        <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#9ca3af" }}>
          Selected Branches ({selectedBranches.length})
        </h4>
        {selectedBranches.length === 0 ? (
          <p style={{ fontSize: 12, color: "#6b7280" }}>
            Click branches to select execution order
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {selectedBranches.map((branch, index) => (
              <li
                key={branch}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                style={{
                  padding: "8px 10px",
                  marginBottom: 6,
                  background: dragOverIndex === index ? "#2563eb" : "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: 4,
                  cursor: "grab",
                  opacity: draggedIndex === index ? 0.5 : 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#3b82f6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: "bold",
                  color: "white",
                  flexShrink: 0,
                }}>
                  {index + 1}
                </span>
                <span style={{
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: "#e5e7eb",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}>
                  {branch}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleBranch(branch);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9ca3af",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
