import { useMemo, useState, useRef, useCallback } from "react";
import type { TreeNode, TreeEdge, TaskNode, TaskEdge } from "../lib/api";

interface BranchGraphProps {
  nodes: TreeNode[];
  edges: TreeEdge[];
  defaultBranch: string;
  selectedBranch: string | null;
  onSelectBranch: (branchName: string) => void;
  // Tentative nodes/edges from planning sessions
  tentativeNodes?: TaskNode[];
  tentativeEdges?: TaskEdge[];
  tentativeBaseBranch?: string;
  // Edge creation - only works when editMode is true
  editMode?: boolean;
  onEdgeCreate?: (parentBranch: string, childBranch: string) => void;
}

interface DragState {
  fromBranch: string;
  fromX: number;
  fromY: number;
  currentX: number;
  currentY: number;
}

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  node: TreeNode;
  depth: number;
  row: number;
  isTentative?: boolean;
  tentativeTitle?: string;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  isDesigned: boolean;
  isTentative?: boolean;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 40;
const TENTATIVE_NODE_HEIGHT = 52;
const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 28;
const PADDING = 20;

// Badge colors
const CI_COLORS: Record<string, string> = {
  SUCCESS: "#4caf50",
  FAILURE: "#f44336",
  PENDING: "#ff9800",
  NEUTRAL: "#9e9e9e",
};

const REVIEW_COLORS: Record<string, string> = {
  APPROVED: "#4caf50",
  CHANGES_REQUESTED: "#f44336",
  REVIEW_REQUIRED: "#ff9800",
};

export default function BranchGraph({
  nodes,
  edges,
  defaultBranch,
  selectedBranch,
  onSelectBranch,
  tentativeNodes = [],
  tentativeEdges = [],
  tentativeBaseBranch,
  editMode = false,
  onEdgeCreate,
}: BranchGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Get SVG coordinates from mouse event
  const getSVGCoords = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  // Handle drag start from node handle
  const handleDragStart = useCallback((branchName: string, handleX: number, handleY: number) => {
    setDragState({
      fromBranch: branchName,
      fromX: handleX,
      fromY: handleY,
      currentX: handleX,
      currentY: handleY,
    });
  }, []);

  // Handle drag move
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState) return;
    const coords = getSVGCoords(e);
    setDragState((prev) => prev ? { ...prev, currentX: coords.x, currentY: coords.y } : null);
  }, [dragState, getSVGCoords]);

  // Handle drag end
  const handleMouseUp = useCallback(() => {
    if (dragState && dropTarget && dropTarget !== dragState.fromBranch) {
      // Create edge: dragState.fromBranch becomes parent of dropTarget
      onEdgeCreate?.(dragState.fromBranch, dropTarget);
    }
    setDragState(null);
    setDropTarget(null);
  }, [dragState, dropTarget, onEdgeCreate]);

  // Handle mouse leave SVG
  const handleMouseLeave = useCallback(() => {
    setDragState(null);
    setDropTarget(null);
  }, []);

  const { layoutNodes, layoutEdges, width, height } = useMemo(() => {
    if (nodes.length === 0 && tentativeNodes.length === 0) {
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

    // Add tentative nodes from planning session
    const tentativeLayoutEdges: LayoutEdge[] = [];
    if (tentativeNodes.length > 0 && tentativeBaseBranch) {
      const baseBranchNode = nodeMap.get(tentativeBaseBranch);
      const baseDepth = baseBranchNode?.depth ?? 0;
      // baseX reserved for future horizontal positioning
      void (baseBranchNode?.x ?? PADDING);

      // Build tentative children map
      const tentChildrenMap = new Map<string, string[]>();
      tentativeEdges.forEach((edge) => {
        const children = tentChildrenMap.get(edge.parent) || [];
        children.push(edge.child);
        tentChildrenMap.set(edge.parent, children);
      });

      // Find tentative root tasks (not child of any task)
      const tentChildSet = new Set(tentativeEdges.map((e) => e.child));
      const tentRootTasks = tentativeNodes.filter((t) => !tentChildSet.has(t.id));

      // Helper to generate tentative branch name
      const generateTentBranchName = (title: string, id: string): string => {
        let slug = title
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 30);
        if (!slug) slug = id.substring(0, 8);
        return `task/${slug}`;
      };

      // Layout tentative subtree
      function layoutTentativeSubtree(
        taskId: string,
        parentLayoutNode: LayoutNode | null,
        depth: number,
        minRow: number
      ): number {
        const task = tentativeNodes.find((t) => t.id === taskId);
        if (!task) return minRow;

        const branchName = task.branchName || generateTentBranchName(task.title, task.id);
        if (nodeMap.has(branchName)) return minRow; // Already exists as real branch

        const row = minRow;
        const tentDummyNode: TreeNode = {
          branchName,
          badges: [],
          lastCommitAt: "",
        };

        const layoutNode: LayoutNode = {
          id: branchName,
          x: PADDING + depth * (NODE_WIDTH + HORIZONTAL_GAP),
          y: PADDING + row * (NODE_HEIGHT + VERTICAL_GAP),
          node: tentDummyNode,
          depth,
          row,
          isTentative: true,
          tentativeTitle: task.title,
        };

        layoutNodes.push(layoutNode);
        nodeMap.set(branchName, layoutNode);

        // Add edge from parent
        if (parentLayoutNode) {
          tentativeLayoutEdges.push({
            from: parentLayoutNode,
            to: layoutNode,
            isDesigned: false,
            isTentative: true,
          });
        }

        // Layout children
        const children = tentChildrenMap.get(taskId) || [];
        let currentRow = minRow + 1;
        children.forEach((childId) => {
          currentRow = layoutTentativeSubtree(childId, layoutNode, depth + 1, currentRow);
        });

        return Math.max(currentRow, minRow + 1);
      }

      // Layout from tentative roots, connected to base branch
      tentRootTasks.forEach((task) => {
        const fromNode = baseBranchNode || layoutNodes[0];
        if (fromNode) {
          nextRow = layoutTentativeSubtree(task.id, fromNode, baseDepth + 1, nextRow);
        }
      });
    }

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

    // Add tentative edges
    layoutEdges.push(...tentativeLayoutEdges);

    // Calculate canvas size
    const maxX = Math.max(...layoutNodes.map((n) => n.x), 0) + NODE_WIDTH + PADDING;
    const maxY = Math.max(
      ...layoutNodes.map((n) => n.y + (n.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT)),
      0
    ) + PADDING;

    return {
      layoutNodes,
      layoutEdges,
      width: Math.max(400, maxX),
      height: Math.max(150, maxY),
    };
  }, [nodes, edges, defaultBranch, tentativeNodes, tentativeEdges, tentativeBaseBranch]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    // Horizontal edge: from right side of parent to left side of child
    const fromHeight = edge.from.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;
    const toHeight = edge.to.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;
    const startX = edge.from.x + NODE_WIDTH;
    const startY = edge.from.y + fromHeight / 2;
    const endX = edge.to.x;
    const endY = edge.to.y + toHeight / 2;

    // Simple right-angle path: go right, then vertical, then right to target
    const cornerX = startX + 20;
    const path = `M ${startX} ${startY} L ${cornerX} ${startY} L ${cornerX} ${endY} L ${endX} ${endY}`;

    // Tentative edges use dashed lines with purple color
    const strokeColor = edge.isTentative ? "#9c27b0" : edge.isDesigned ? "#9c27b0" : "#4b5563";
    const strokeDash = edge.isTentative ? "4,4" : undefined;

    return (
      <g key={`edge-${index}`} opacity={edge.isTentative ? 0.7 : 1}>
        <path
          d={path}
          fill="none"
          stroke={strokeColor}
          strokeWidth={edge.isDesigned || edge.isTentative ? 2 : 1.5}
          strokeDasharray={strokeDash}
        />
        {/* Arrow head pointing right */}
        <polygon
          points={`${endX},${endY} ${endX - 6},${endY - 3} ${endX - 6},${endY + 3}`}
          fill={strokeColor}
        />
      </g>
    );
  };

  const renderNode = (layoutNode: LayoutNode) => {
    const { id, x, y, node, isTentative, tentativeTitle } = layoutNode;
    const isSelected = selectedBranch === id;
    const isDefault = id === defaultBranch;
    const hasWorktree = !!node.worktree;
    const hasPR = !!node.pr;
    const isMerged = node.pr?.state === "MERGED";
    const isDragging = dragState?.fromBranch === id;
    const isDropTarget = dropTarget === id && dragState && dragState.fromBranch !== id;

    // Determine node color (dark mode)
    let fillColor = "#1f2937";
    let strokeColor = "#4b5563";
    let strokeDash: string | undefined;

    if (isTentative) {
      // Tentative nodes have dashed purple border
      fillColor = "#2d1f3d";
      strokeColor = "#9c27b0";
      strokeDash = "4,4";
    } else if (isMerged) {
      // Merged PRs have muted purple appearance
      fillColor = "#1a1625";
      strokeColor = "#6b21a8";
      strokeDash = "2,2";
    } else if (isDefault) {
      fillColor = "#1e3a5f";
      strokeColor = "#3b82f6";
    } else if (node.worktree?.isActive) {
      fillColor = "#14532d";
      strokeColor = "#22c55e";
    } else if (hasPR) {
      if (node.pr?.state === "OPEN") {
        fillColor = "#14532d";
        strokeColor = "#22c55e";
      }
    }

    if (isSelected) {
      strokeColor = "#3b82f6";
    }

    // Highlight drop target
    if (isDropTarget) {
      strokeColor = "#22c55e";
    }

    // For tentative nodes, show task title; for real nodes, show branch name
    const displayText = isTentative && tentativeTitle ? tentativeTitle : id;
    // For tentative nodes, also show branch name
    const branchNameDisplay = isTentative ? id : null;
    const nodeHeight = isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;

    // Drag handle position (left side of node)
    const handleX = x;
    const handleY = y + nodeHeight / 2;

    return (
      <g
        key={id}
        style={{ cursor: isTentative ? "default" : "pointer" }}
        opacity={isTentative ? 0.8 : isDragging ? 0.5 : isMerged ? 0.6 : 1}
        onMouseEnter={() => {
          if (dragState && dragState.fromBranch !== id && !isTentative) {
            setDropTarget(id);
          }
        }}
        onMouseLeave={() => {
          if (dropTarget === id) {
            setDropTarget(null);
          }
        }}
      >
        {/* Node rectangle */}
        <rect
          x={x}
          y={y}
          width={NODE_WIDTH}
          height={nodeHeight}
          rx={6}
          ry={6}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isSelected || isDropTarget ? 2 : 1.5}
          strokeDasharray={strokeDash}
          onClick={() => !isTentative && !dragState && onSelectBranch(id)}
        />

        {/* Branch name or task title using foreignObject for proper wrapping */}
        <foreignObject
          x={x + 8}
          y={y + 2}
          width={NODE_WIDTH - 16}
          height={nodeHeight - 4}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                fontSize: isTentative ? 10 : 11,
                fontFamily: isTentative ? "sans-serif" : "monospace",
                fontWeight: isDefault ? "bold" : isTentative ? 500 : "normal",
                color: isTentative ? "#c084fc" : isMerged ? "#9ca3af" : "#e5e7eb",
                lineHeight: 1.3,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical" as const,
                wordBreak: "break-all",
              }}
            >
              {displayText}
            </div>
            {branchNameDisplay && (
              <div
                style={{
                  fontSize: 9,
                  fontFamily: "monospace",
                  color: "#9ca3af",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {branchNameDisplay}
              </div>
            )}
          </div>
        </foreignObject>

        {/* Status indicators on right side */}
        {hasWorktree && (
          <circle
            cx={x + NODE_WIDTH - 12}
            cy={y + nodeHeight / 2}
            r={5}
            fill={node.worktree?.isActive ? "#4caf50" : "#9e9e9e"}
          />
        )}

        {hasPR && (
          <g>
            {/* PR state badge */}
            <rect
              x={x + NODE_WIDTH - 28}
              y={y + 4}
              width={24}
              height={14}
              rx={2}
              fill={node.pr?.state === "MERGED" ? "#9c27b0" : node.pr?.state === "OPEN" ? "#22c55e" : "#9e9e9e"}
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

            {/* CI status badge */}
            {node.pr?.checks && (
              <g>
                <rect
                  x={x + NODE_WIDTH - 54}
                  y={y + 4}
                  width={22}
                  height={14}
                  rx={2}
                  fill={CI_COLORS[node.pr.checks] || CI_COLORS.NEUTRAL}
                />
                <text
                  x={x + NODE_WIDTH - 43}
                  y={y + 12}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={7}
                  fill="white"
                  fontWeight="bold"
                >
                  {node.pr.checks === "SUCCESS" ? "✓" : node.pr.checks === "FAILURE" ? "✗" : node.pr.checks === "PENDING" ? "…" : "−"}
                </text>
              </g>
            )}

            {/* Review decision badge */}
            {node.pr?.reviewDecision && (
              <g>
                <rect
                  x={x + NODE_WIDTH - (node.pr?.checks ? 78 : 54)}
                  y={y + 4}
                  width={20}
                  height={14}
                  rx={2}
                  fill={REVIEW_COLORS[node.pr.reviewDecision] || "#9e9e9e"}
                />
                <text
                  x={x + NODE_WIDTH - (node.pr?.checks ? 68 : 44)}
                  y={y + 12}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={7}
                  fill="white"
                  fontWeight="bold"
                >
                  {node.pr.reviewDecision === "APPROVED" ? "✓R" : node.pr.reviewDecision === "CHANGES_REQUESTED" ? "✗R" : "?R"}
                </text>
              </g>
            )}
          </g>
        )}

        {/* Ahead/Behind indicator below node */}
        {node.aheadBehind && (node.aheadBehind.ahead > 0 || node.aheadBehind.behind > 0) && (
          <g>
            {node.aheadBehind.ahead > 0 && (
              <>
                <rect
                  x={x + NODE_WIDTH / 2 - 24}
                  y={y + nodeHeight + 4}
                  width={22}
                  height={14}
                  rx={3}
                  fill="#4caf50"
                />
                <text
                  x={x + NODE_WIDTH / 2 - 13}
                  y={y + nodeHeight + 12}
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
                  y={y + nodeHeight + 4}
                  width={22}
                  height={14}
                  rx={3}
                  fill="#f44336"
                />
                <text
                  x={x + NODE_WIDTH / 2 + 13}
                  y={y + nodeHeight + 12}
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

        {/* Remote ahead/behind indicator (vs origin) - shown with cloud icon or different position */}
        {node.remoteAheadBehind && (node.remoteAheadBehind.ahead > 0 || node.remoteAheadBehind.behind > 0) && (
          <g>
            {node.remoteAheadBehind.ahead > 0 && (
              <>
                <rect
                  x={x - 28}
                  y={y + nodeHeight / 2 - 7}
                  width={24}
                  height={14}
                  rx={3}
                  fill="#3b82f6"
                />
                <text
                  x={x - 16}
                  y={y + nodeHeight / 2 + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="white"
                  fontWeight="bold"
                >
                  ↑{node.remoteAheadBehind.ahead}
                </text>
              </>
            )}
            {node.remoteAheadBehind.behind > 0 && (
              <>
                <rect
                  x={x - 28}
                  y={y + nodeHeight / 2 + (node.remoteAheadBehind.ahead > 0 ? 9 : -7)}
                  width={24}
                  height={14}
                  rx={3}
                  fill="#f59e0b"
                />
                <text
                  x={x - 16}
                  y={y + nodeHeight / 2 + (node.remoteAheadBehind.ahead > 0 ? 17 : 1)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="white"
                  fontWeight="bold"
                >
                  ↓{node.remoteAheadBehind.behind}
                </text>
              </>
            )}
          </g>
        )}

        {/* Drag handle (left side) - only in edit mode for non-default, non-tentative nodes */}
        {editMode && !isTentative && !isDefault && onEdgeCreate && (
          <g
            style={{ cursor: "grab" }}
            onMouseDown={(e) => {
              e.stopPropagation();
              handleDragStart(id, handleX, handleY);
            }}
          >
            <circle
              cx={handleX}
              cy={handleY}
              r={6}
              fill="#4b5563"
              stroke="#6b7280"
              strokeWidth={1}
            />
            <circle
              cx={handleX}
              cy={handleY}
              r={2}
              fill="#9ca3af"
            />
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
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="branch-graph__svg"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{
          cursor: dragState ? "grabbing" : undefined,
          userSelect: dragState ? "none" : undefined,
        }}
      >
        {/* Render edges first (behind nodes) */}
        <g className="branch-graph__edges">
          {layoutEdges.map((edge, i) => renderEdge(edge, i))}
        </g>

        {/* Render drag line while dragging */}
        {dragState && (
          <line
            x1={dragState.fromX}
            y1={dragState.fromY}
            x2={dragState.currentX}
            y2={dragState.currentY}
            stroke={dropTarget ? "#22c55e" : "#3b82f6"}
            strokeWidth={2}
            strokeDasharray="4,4"
            pointerEvents="none"
          />
        )}

        {/* Render nodes */}
        <g className="branch-graph__nodes">
          {layoutNodes.map((node) => renderNode(node))}
        </g>
      </svg>
    </div>
  );
}
