import { useMemo, useState, useCallback } from "react";
import type { TreeNode, TreeEdge } from "../lib/api";

interface ExecuteBranchSelectorProps {
  nodes: TreeNode[];
  edges: TreeEdge[];
  defaultBranch: string;
  selectedBranches: string[];
  onSelectionChange: (branches: string[]) => void;
  onStartExecution?: () => void;
  executeLoading?: boolean;
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

const NODE_WIDTH = 140;
const NODE_HEIGHT = 36;
const HORIZONTAL_GAP = 16;
const VERTICAL_GAP = 44; // Increased to make room for "select descendants" button
const TOP_PADDING = 12;
const LEFT_PADDING = 8;

export default function ExecuteBranchSelector({
  nodes,
  edges,
  defaultBranch,
  selectedBranches,
  onSelectionChange,
  onStartExecution,
  executeLoading = false,
}: ExecuteBranchSelectorProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; branchName: string } | null>(null);

  // Build children map for subtree selection
  const childrenMap = useMemo(() => {
    const map = new Map<string, string[]>();
    edges.forEach((edge) => {
      const children = map.get(edge.parent) || [];
      children.push(edge.child);
      map.set(edge.parent, children);
    });
    return map;
  }, [edges]);

  // Get all descendants of a branch (depth-first order)
  const getDescendants = useCallback((branchName: string): string[] => {
    const result: string[] = [];
    const stack = [branchName];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);

      const children = childrenMap.get(current) || [];
      // Add children in reverse order so they come out in order
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
    return result;
  }, [childrenMap]);

  const handleToggleBranch = useCallback((branchName: string) => {
    const index = selectedBranches.indexOf(branchName);
    if (index >= 0) {
      const newSelection = [...selectedBranches];
      newSelection.splice(index, 1);
      onSelectionChange(newSelection);
    } else {
      onSelectionChange([...selectedBranches, branchName]);
    }
  }, [selectedBranches, onSelectionChange]);

  // Select branch and all its descendants
  const handleSelectSubtree = useCallback((branchName: string) => {
    const descendants = getDescendants(branchName);
    // Add only branches that are not already selected, maintaining order
    const newBranches = descendants.filter(b => !selectedBranches.includes(b) && b !== defaultBranch);
    if (newBranches.length > 0) {
      onSelectionChange([...selectedBranches, ...newBranches]);
    }
  }, [getDescendants, selectedBranches, onSelectionChange, defaultBranch]);

  const getSelectionOrder = useCallback((branchName: string): number | null => {
    const index = selectedBranches.indexOf(branchName);
    return index >= 0 ? index + 1 : null;
  }, [selectedBranches]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = "move";
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

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

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const { layoutNodes, layoutEdges, width, height } = useMemo(() => {
    if (nodes.length === 0) {
      return { layoutNodes: [], layoutEdges: [], width: 300, height: 100 };
    }

    const childrenMap = new Map<string, string[]>();
    edges.forEach((edge) => {
      const children = childrenMap.get(edge.parent) || [];
      children.push(edge.child);
      childrenMap.set(edge.parent, children);
    });

    const childSet = new Set(edges.map((e) => e.child));
    const rootNodes = nodes.filter((n) => !childSet.has(n.branchName));

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
      width: Math.max(300, maxX),
      height: Math.max(80, maxY),
    };
  }, [nodes, edges, defaultBranch]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    const startX = edge.from.x + NODE_WIDTH / 2;
    const startY = edge.from.y + NODE_HEIGHT;
    const endX = edge.to.x + NODE_WIDTH / 2;
    const endY = edge.to.y;
    const cornerY = startY + 10;
    const path = `M ${startX} ${startY} L ${startX} ${cornerY} L ${endX} ${cornerY} L ${endX} ${endY}`;

    return (
      <g key={`edge-${index}`}>
        <path d={path} fill="none" stroke="#4b5563" strokeWidth={1} />
        <polygon
          points={`${endX},${endY} ${endX - 3},${endY - 5} ${endX + 3},${endY - 5}`}
          fill="#4b5563"
        />
      </g>
    );
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, branchName: string) => {
    e.preventDefault();
    if (branchName === defaultBranch) return;
    setContextMenu({ x: e.clientX, y: e.clientY, branchName });
  }, [defaultBranch]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const renderNode = (layoutNode: LayoutNode) => {
    const { id, x, y, node } = layoutNode;
    const isDefault = id === defaultBranch;
    const selectionOrder = getSelectionOrder(id);
    const isSelected = selectionOrder !== null;
    const isMerged = node.pr?.state === "MERGED";
    const hasChildren = (childrenMap.get(id) || []).length > 0;

    let fillColor = "#1f2937";
    let strokeColor = isSelected ? "#f59e0b" : "#4b5563";

    if (isMerged) {
      fillColor = "#1a1625";
      strokeColor = isSelected ? "#f59e0b" : "#6b21a8";
    }

    return (
      <g
        key={id}
        style={{ cursor: isDefault ? "not-allowed" : "pointer" }}
        opacity={isMerged ? 0.5 : 1}
        onClick={() => !isDefault && handleToggleBranch(id)}
        onContextMenu={(e) => handleContextMenu(e, id)}
      >
        <rect
          x={x}
          y={y}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={4}
          ry={4}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isSelected ? 2 : 1}
        />
        {isSelected && (
          <g>
            <circle cx={x + NODE_WIDTH - 10} cy={y + 10} r={8} fill="#f59e0b" />
            <text
              x={x + NODE_WIDTH - 10}
              y={y + 11}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10}
              fill="#1f2937"
              fontWeight="bold"
            >
              {selectionOrder}
            </text>
          </g>
        )}
        <foreignObject
          x={x + 6}
          y={y + 2}
          width={NODE_WIDTH - (isSelected ? 26 : 12)}
          height={NODE_HEIGHT - 4}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            overflow: "hidden",
          }}>
            <span style={{
              fontSize: 10,
              fontFamily: "monospace",
              fontWeight: isDefault ? "bold" : "normal",
              color: isMerged ? "#6b7280" : "#d1d5db",
              wordBreak: "break-all",
              lineHeight: 1.2,
            }}>
              {id}
            </span>
          </div>
        </foreignObject>
        {/* "Select descendants" button - show when selected and has children */}
        {isSelected && hasChildren && (
          <g
            onClick={(e) => {
              e.stopPropagation();
              handleSelectSubtree(id);
            }}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={x + NODE_WIDTH / 2 - 28}
              y={y + NODE_HEIGHT + 2}
              width={56}
              height={16}
              rx={3}
              fill="#3b82f6"
            />
            <text
              x={x + NODE_WIDTH / 2}
              y={y + NODE_HEIGHT + 11}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={9}
              fill="#fff"
              fontWeight="500"
            >
  + children
            </text>
          </g>
        )}
      </g>
    );
  };

  if (nodes.length === 0) {
    return (
      <div className="execute-branch-selector" style={{ padding: 16, color: "#6b7280", textAlign: "center" }}>
        No branches available
      </div>
    );
  }

  return (
    <div
      className="execute-branch-selector"
      style={{ display: "flex", height: "100%" }}
      onClick={closeContextMenu}
    >
      {/* Graph */}
      <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <svg width={width} height={height} style={{ display: "block" }}>
          <g className="edges">{layoutEdges.map((edge, i) => renderEdge(edge, i))}</g>
          <g className="nodes">{layoutNodes.map((node) => renderNode(node))}</g>
        </svg>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: 4,
            padding: "4px 0",
            zIndex: 1000,
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              handleToggleBranch(contextMenu.branchName);
              closeContextMenu();
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: "#d1d5db",
              fontSize: 12,
              textAlign: "left",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#374151")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          >
            {selectedBranches.includes(contextMenu.branchName) ? "Remove" : "Select"}
          </button>
          {(childrenMap.get(contextMenu.branchName) || []).length > 0 && (
            <button
              onClick={() => {
                handleSelectSubtree(contextMenu.branchName);
                closeContextMenu();
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "6px 12px",
                background: "none",
                border: "none",
                color: "#3b82f6",
                fontSize: 12,
                textAlign: "left",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#374151")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              Select with descendants ↓
            </button>
          )}
        </div>
      )}

      {/* Selection Panel */}
      <div style={{
        width: 180,
        borderLeft: "1px solid #374151",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}>
        <div style={{
          padding: "8px 12px",
          borderBottom: "1px solid #374151",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            Queue ({selectedBranches.length})
          </span>
          {selectedBranches.length > 0 && (
            <button
              onClick={() => onSelectionChange([])}
              style={{
                background: "none",
                border: "none",
                color: "#6b7280",
                cursor: "pointer",
                fontSize: 10,
                padding: "2px 4px",
              }}
            >
              Clear
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "6px" }}>
          {selectedBranches.length === 0 ? (
            <div style={{ fontSize: 10, color: "#6b7280", padding: "8px", textAlign: "center" }}>
              Click branches to add
            </div>
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
                    padding: "4px 6px",
                    marginBottom: 4,
                    background: dragOverIndex === index ? "#2563eb" : "#0f172a",
                    border: "1px solid #374151",
                    borderRadius: 3,
                    cursor: "grab",
                    opacity: draggedIndex === index ? 0.5 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: "#f59e0b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    fontWeight: "bold",
                    color: "#1f2937",
                    flexShrink: 0,
                  }}>
                    {index + 1}
                  </span>
                  <span style={{
                    fontSize: 10,
                    fontFamily: "monospace",
                    color: "#d1d5db",
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
                      color: "#6b7280",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 12,
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

        {onStartExecution && (
          <div style={{ padding: "8px", borderTop: "1px solid #374151" }}>
            <button
              onClick={onStartExecution}
              disabled={selectedBranches.length === 0 || executeLoading}
              style={{
                width: "100%",
                padding: "8px 12px",
                background: selectedBranches.length === 0 ? "#78350f" : "#f59e0b",
                color: selectedBranches.length === 0 ? "#9ca3af" : "#1f2937",
                border: "none",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 600,
                cursor: selectedBranches.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              {executeLoading ? "Starting..." : "Start"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
