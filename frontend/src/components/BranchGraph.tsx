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

const NODE_WIDTH = 220;
const NODE_HEIGHT = 68; // Taller for multi-line layout (labels + branch name with wrap)
const TENTATIVE_NODE_HEIGHT = 64;
const HORIZONTAL_GAP = 40; // Gap between sibling nodes (horizontal)
const VERTICAL_GAP = 70; // Gap between parent-child levels (vertical) - includes space for indicators
const TOP_PADDING = 40; // Top padding for worktree labels
const LEFT_PADDING = 20; // Left padding


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

  // Handle drag start from node
  const handleDragStart = useCallback((
    branchName: string,
    startX: number,
    startY: number
  ) => {
    setDragState({
      fromBranch: branchName,
      fromX: startX,
      fromY: startY,
      currentX: startX,
      currentY: startY,
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
      // Create edge: dropTarget becomes parent of dragState.fromBranch
      // (User drags a branch TO its new parent)
      onEdgeCreate?.(dropTarget, dragState.fromBranch);
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

    // Layout nodes - vertical tree (root on top-left, children below)
    const layoutNodes: LayoutNode[] = [];
    const nodeMap = new Map<string, LayoutNode>();

    // Track max column used at each depth for left-aligned layout
    const maxColAtDepth = new Map<number, number>();

    function layoutSubtree(branchName: string, depth: number, minCol: number): number {
      const node = nodes.find((n) => n.branchName === branchName);
      if (!node || nodeMap.has(branchName)) return minCol;

      const children = childrenMap.get(branchName) || [];

      // Left-aligned: use minCol directly
      const col = minCol;

      // Vertical layout: depth controls Y, col controls X
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

      // Track max column at this depth
      const currentMax = maxColAtDepth.get(depth) ?? -1;
      maxColAtDepth.set(depth, Math.max(currentMax, col));

      // Layout children below, each child gets its own column
      let currentCol = minCol;
      children.forEach((childName) => {
        currentCol = layoutSubtree(childName, depth + 1, currentCol);
      });

      // Return the next available column
      return Math.max(currentCol, minCol + 1);
    }

    // Layout from each root
    let nextCol = 0;
    rootNodes.forEach((root) => {
      nextCol = layoutSubtree(root.branchName, 0, nextCol);
    });

    // Handle orphan nodes (not connected to any root)
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

    // Add tentative nodes from planning session
    const tentativeLayoutEdges: LayoutEdge[] = [];
    if (tentativeNodes.length > 0 && tentativeBaseBranch) {
      const baseBranchNode = nodeMap.get(tentativeBaseBranch);
      const baseDepth = baseBranchNode?.depth ?? 0;

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

      // Layout tentative subtree (vertical)
      function layoutTentativeSubtree(
        taskId: string,
        parentLayoutNode: LayoutNode | null,
        depth: number,
        minCol: number
      ): number {
        const task = tentativeNodes.find((t) => t.id === taskId);
        if (!task) return minCol;

        const branchName = task.branchName || generateTentBranchName(task.title, task.id);
        if (nodeMap.has(branchName)) return minCol; // Already exists as real branch

        const col = minCol;
        const tentDummyNode: TreeNode = {
          branchName,
          badges: [],
          lastCommitAt: "",
        };

        const layoutNode: LayoutNode = {
          id: branchName,
          x: LEFT_PADDING + col * (NODE_WIDTH + HORIZONTAL_GAP),
          y: TOP_PADDING + depth * (NODE_HEIGHT + VERTICAL_GAP),
          node: tentDummyNode,
          depth,
          row: col,
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

        // Layout children below
        const children = tentChildrenMap.get(taskId) || [];
        let currentCol = minCol + 1;
        children.forEach((childId) => {
          currentCol = layoutTentativeSubtree(childId, layoutNode, depth + 1, currentCol);
        });

        return Math.max(currentCol, minCol + 1);
      }

      // Layout from tentative roots, connected to base branch
      tentRootTasks.forEach((task) => {
        const fromNode = baseBranchNode || layoutNodes[0];
        if (fromNode) {
          nextCol = layoutTentativeSubtree(task.id, fromNode, baseDepth + 1, nextCol);
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
    const maxX = Math.max(...layoutNodes.map((n) => n.x), 0) + NODE_WIDTH + LEFT_PADDING;
    const maxY = Math.max(
      ...layoutNodes.map((n) => n.y + (n.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT)),
      0
    ) + TOP_PADDING;

    return {
      layoutNodes,
      layoutEdges,
      width: Math.max(400, maxX),
      height: Math.max(150, maxY),
    };
  }, [nodes, edges, defaultBranch, tentativeNodes, tentativeEdges, tentativeBaseBranch]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    // Vertical edge: from bottom of parent to top of child
    const fromHeight = edge.from.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;
    const startX = edge.from.x + NODE_WIDTH / 2;
    const startY = edge.from.y + fromHeight;
    const endX = edge.to.x + NODE_WIDTH / 2;
    const endY = edge.to.y;

    // Simple path: go down, then horizontal, then down to target
    const cornerY = startY + 20;
    const path = `M ${startX} ${startY} L ${startX} ${cornerY} L ${endX} ${cornerY} L ${endX} ${endY}`;

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
        {/* Arrow head pointing down */}
        <polygon
          points={`${endX},${endY} ${endX - 4},${endY - 6} ${endX + 4},${endY - 6}`}
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
    const canDrag = editMode && !isTentative && !isDefault && onEdgeCreate;

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
      strokeDash = undefined; // Solid border when selected
    }

    // In edit mode, highlight draggable nodes
    if (editMode && canDrag && !isSelected && !isMerged) {
      strokeColor = "#6366f1";
    }

    // Highlight drop target
    if (isDropTarget) {
      fillColor = "#14532d";
      strokeColor = "#22c55e";
    }

    // For tentative nodes, show task title; for real nodes, show branch name
    const displayText = isTentative && tentativeTitle ? tentativeTitle : id;
    // For tentative nodes, also show branch name
    const branchNameDisplay = isTentative ? id : null;
    const nodeHeight = isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;

    // In edit mode, the whole node is draggable (line starts from top edge of node for vertical layout)
    const handleNodeMouseDown = canDrag ? (e: React.MouseEvent) => {
      e.stopPropagation();
      handleDragStart(id, x + NODE_WIDTH / 2, y);
    } : undefined;

    return (
      <g
        key={id}
        style={{ cursor: canDrag ? (isDragging ? "grabbing" : "grab") : (isTentative ? "default" : "pointer") }}
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
        onMouseDown={handleNodeMouseDown}
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

        {/* Node content using foreignObject */}
        <foreignObject
          x={x + 8}
          y={y + 4}
          width={NODE_WIDTH - 16}
          height={nodeHeight - 8}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-around",
              overflow: "hidden",
            }}
          >
            {/* Line 1: Status labels - right aligned */}
            {hasPR && (
              <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", justifyContent: "flex-end" }}>
                {/* Review status */}
                {node.pr?.reviewDecision === "APPROVED" && (
                  <span style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "transparent",
                    border: "1px solid #22c55e",
                    color: "#4ade80",
                    whiteSpace: "nowrap",
                  }}>Approved ✔</span>
                )}
                {node.pr?.reviewDecision === "CHANGES_REQUESTED" && (
                  <span style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "transparent",
                    border: "1px solid #ef4444",
                    color: "#f87171",
                    whiteSpace: "nowrap",
                  }}>Changes ✗</span>
                )}
                {node.pr?.reviewDecision === "REVIEW_REQUIRED" && (
                  <span style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "transparent",
                    border: "1px solid #f59e0b",
                    color: "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>Review?</span>
                )}
                {/* CI status */}
                {node.pr?.checks === "SUCCESS" && (
                  <span style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "#14532d",
                    border: "1px solid #22c55e",
                    color: "#4ade80",
                    whiteSpace: "nowrap",
                  }}>CI ✔</span>
                )}
                {node.pr?.checks === "FAILURE" && (
                  <span style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "#7f1d1d",
                    border: "1px solid #ef4444",
                    color: "#f87171",
                    whiteSpace: "nowrap",
                  }}>CI ✗</span>
                )}
                {node.pr?.checks === "PENDING" && (
                  <span style={{
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "#78350f",
                    border: "1px solid #f59e0b",
                    color: "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>CI …</span>
                )}
                {/* PR indicator - with background */}
                <span style={{
                  fontSize: 11,
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: node.pr?.state === "MERGED" ? "#3b0764" : "#374151",
                  border: node.pr?.state === "MERGED" ? "1px solid #9333ea" : "1px solid #4b5563",
                  color: node.pr?.state === "MERGED" ? "#c084fc" : "#e5e7eb",
                  whiteSpace: "nowrap",
                }}>PR</span>
              </div>
            )}

            {/* Line 2: Branch name - allow wrapping */}
            <div
              style={{
                fontSize: isTentative ? 12 : 13,
                fontFamily: isTentative ? "sans-serif" : "monospace",
                fontWeight: isDefault ? "bold" : isTentative ? 500 : "normal",
                color: isTentative ? "#c084fc" : isMerged ? "#9ca3af" : "#e5e7eb",
                lineHeight: 1.3,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical" as const,
                wordBreak: "break-all",
              }}
            >
              {displayText}
            </div>
            {/* Tentative: also show branch name */}
            {branchNameDisplay && (
              <div
                style={{
                  fontSize: 10,
                  fontFamily: "monospace",
                  color: "#9ca3af",
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

        {/* Worktree label on top + active border effect */}
        {hasWorktree && (() => {
          const worktreeName = node.worktree?.path?.split("/").pop() || "worktree";
          const isActive = node.worktree?.isActive;
          const labelWidth = Math.min(worktreeName.length * 7 + 20, NODE_WIDTH);
          return (
            <g>
              {/* Active glow effect */}
              {isActive && (
                <rect
                  x={x - 2}
                  y={y - 2}
                  width={NODE_WIDTH + 4}
                  height={nodeHeight + 4}
                  rx={8}
                  ry={8}
                  fill="none"
                  stroke="#22c55e"
                  strokeWidth={2}
                  opacity={0.6}
                />
              )}
              {/* Worktree folder name label - positioned above node */}
              <rect
                x={x}
                y={y - 22}
                width={labelWidth}
                height={20}
                rx={4}
                fill={isActive ? "#166534" : "#1e293b"}
                stroke={isActive ? "#22c55e" : "#475569"}
                strokeWidth={isActive ? 2 : 1}
              />
              {/* Folder icon */}
              <text
                x={x + 6}
                y={y - 11}
                dominantBaseline="middle"
                fontSize={11}
              >
                📁
              </text>
              <text
                x={x + 22}
                y={y - 11}
                textAnchor="start"
                dominantBaseline="middle"
                fontSize={11}
                fill={isActive ? "#4ade80" : "#94a3b8"}
                fontWeight={isActive ? "bold" : "600"}
              >
                {worktreeName.length > 20 ? worktreeName.substring(0, 18) + "…" : worktreeName}
              </text>
            </g>
          );
        })()}


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

        {/* Remote ahead/behind indicator (vs origin) - shown below local indicators */}
        {node.remoteAheadBehind && (node.remoteAheadBehind.ahead > 0 || node.remoteAheadBehind.behind > 0) && (() => {
          // Position below local indicators if they exist
          const hasLocalIndicator = node.aheadBehind && (node.aheadBehind.ahead > 0 || node.aheadBehind.behind > 0);
          const remoteY = y + nodeHeight + (hasLocalIndicator ? 22 : 4);
          return (
          <g>
            {node.remoteAheadBehind.ahead > 0 && (
              <>
                <rect
                  x={x + NODE_WIDTH / 2 - 24}
                  y={remoteY}
                  width={22}
                  height={14}
                  rx={3}
                  fill="#3b82f6"
                />
                <text
                  x={x + NODE_WIDTH / 2 - 13}
                  y={remoteY + 8}
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
                  x={x + NODE_WIDTH / 2 + 2}
                  y={remoteY}
                  width={22}
                  height={14}
                  rx={3}
                  fill="#f59e0b"
                />
                <text
                  x={x + NODE_WIDTH / 2 + 13}
                  y={remoteY + 8}
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
          );
        })()}

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
          <g pointerEvents="none">
            {/* Glow effect */}
            <line
              x1={dragState.fromX}
              y1={dragState.fromY}
              x2={dragState.currentX}
              y2={dragState.currentY}
              stroke={dropTarget ? "#22c55e" : "#6366f1"}
              strokeWidth={6}
              opacity={0.3}
            />
            {/* Main line */}
            <line
              x1={dragState.fromX}
              y1={dragState.fromY}
              x2={dragState.currentX}
              y2={dragState.currentY}
              stroke={dropTarget ? "#22c55e" : "#6366f1"}
              strokeWidth={2}
              strokeDasharray={dropTarget ? undefined : "6,4"}
            />
            {/* Arrow head at end */}
            {dropTarget && (() => {
              const dx = dragState.currentX - dragState.fromX;
              const dy = dragState.currentY - dragState.fromY;
              const angle = Math.atan2(dy, dx);
              const arrowSize = 10;
              return (
                <polygon
                  points={`
                    ${dragState.currentX},${dragState.currentY}
                    ${dragState.currentX - arrowSize * Math.cos(angle - Math.PI / 6)},${dragState.currentY - arrowSize * Math.sin(angle - Math.PI / 6)}
                    ${dragState.currentX - arrowSize * Math.cos(angle + Math.PI / 6)},${dragState.currentY - arrowSize * Math.sin(angle + Math.PI / 6)}
                  `}
                  fill="#22c55e"
                />
              );
            })()}
            {/* Instruction text */}
            <text
              x={dragState.currentX + 10}
              y={dragState.currentY - 10}
              fontSize={11}
              fill={dropTarget ? "#22c55e" : "#9ca3af"}
              fontWeight={500}
            >
              {dropTarget ? `Set parent: ${dropTarget}` : "Drop on new parent"}
            </text>
          </g>
        )}

        {/* Render nodes */}
        <g className="branch-graph__nodes">
          {layoutNodes.map((node) => renderNode(node))}
        </g>
      </svg>
    </div>
  );
}
