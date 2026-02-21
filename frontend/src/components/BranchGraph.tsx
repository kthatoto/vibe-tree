import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import type { TreeNode, TreeEdge, TaskNode, TaskEdge, BranchLink } from "../lib/api";

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
  // Branch creation
  onBranchCreate?: (baseBranch: string) => void;
  // Branch links for PR info (single source of truth)
  branchLinks?: Map<string, BranchLink[]>;
  // Branch descriptions (first word shown as label)
  branchDescriptions?: Map<string, string>;
  // Zoom control (external)
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  // Filter control
  checkedBranches?: Set<string>;
  onCheckedChange?: (branchName: string, checked: boolean) => void;
  filterEnabled?: boolean;
  // Paint mode (Pattern C: paint mode)
  paintMode?: "check" | "uncheck" | null;
  onExitPaintMode?: () => void;
  // Sibling order for column reordering (parent branchName -> ordered child branchNames)
  siblingOrder?: Record<string, string[]>;
  onSiblingOrderChange?: (siblingOrder: Record<string, string[]>) => void;
  // Focus separator - divides focused (left) from unfocused (right) items
  // Index indicates separator position in root siblings (0 = before first, 1 = after first, etc.)
  focusSeparatorIndex?: number | null; // null means no separator
  onFocusSeparatorIndexChange?: (index: number | null) => void;
  // Highlighted branch (for log hover effect with rotating dashed border)
  highlightedBranch?: string | null;
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
  width: number;
  height: number;
  node: TreeNode;
  depth: number;
  row: number;
  isTentative?: boolean;
  tentativeTitle?: string;
  taskId?: string; // For tentative nodes, stores the task ID for edge creation
  parentBranch?: string; // Parent branch name for sibling reordering
  siblings?: string[]; // Sibling branch names in current order
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  isDesigned: boolean;
  isTentative?: boolean;
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const MINIMIZED_NODE_WIDTH = 90;
const MINIMIZED_NODE_HEIGHT = 40;
const TENTATIVE_NODE_HEIGHT = 60;
const HORIZONTAL_GAP = 28;
const VERTICAL_GAP = 50;
const TOP_PADDING = 30;
const LEFT_PADDING = 16;
const RIGHT_PADDING = 32; // Extra space on right for scrolling
const SEPARATOR_HALF_WIDTH = 12; // Half width of separator zone (total width = 24px)


// Zoom constraints (exported for external use)
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 1;
export const ZOOM_STEP = 0.1;

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
  onBranchCreate,
  branchLinks = new Map(),
  branchDescriptions = new Map(),
  zoom = 1,
  onZoomChange,
  checkedBranches = new Set(),
  onCheckedChange,
  filterEnabled = false,
  paintMode = null,
  onExitPaintMode,
  siblingOrder = {},
  onSiblingOrderChange,
  focusSeparatorIndex = null,
  onFocusSeparatorIndexChange,
  highlightedBranch = null,
}: BranchGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Column reorder drag state
  const [columnDragState, setColumnDragState] = useState<{
    draggingBranch: string;
    parentBranch: string;
    siblings: string[];
    startX: number;
    currentX: number;
    offsetX: number; // offset from node center to mouse position
    currentInsertIndex: number; // current swap position (updates on swap)
  } | null>(null);

  // Ref for columnDragState to avoid useEffect dependency issues
  const columnDragStateRef = useRef(columnDragState);
  columnDragStateRef.current = columnDragState;

  // Separator drag state
  const [separatorDragState, setSeparatorDragState] = useState<{
    startX: number;
    currentX: number;
    currentIndex: number; // current position during drag (updates on swap)
  } | null>(null);

  // Paint mode range selection drag state
  const [paintModeDragState, setPaintModeDragState] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // ESC key handler to exit paint mode
  useEffect(() => {
    if (!paintMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onExitPaintMode?.();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [paintMode, onExitPaintMode]);

  // Store refs for paint mode drag handlers
  const paintModeDragStateRef = useRef(paintModeDragState);
  paintModeDragStateRef.current = paintModeDragState;

  // Prevent browser back/forward gesture on horizontal scroll (only when at scroll boundary)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const handleWheel = (e: WheelEvent) => {
      // Only prevent default at scroll boundaries to avoid browser gestures
      // while still allowing normal scrolling
      const container = svg.closest(".graph-container") as HTMLElement | null;
      if (!container) return;

      const { scrollLeft, scrollWidth, clientWidth } = container;
      const atLeftEdge = scrollLeft <= 0;
      const atRightEdge = scrollLeft >= scrollWidth - clientWidth - 1;

      // Prevent browser back/forward only when scrolling beyond boundaries
      if (e.deltaX < 0 && atLeftEdge) {
        e.preventDefault();
      } else if (e.deltaX > 0 && atRightEdge) {
        e.preventDefault();
      }
    };

    // Use non-passive listener to allow preventDefault
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, []);

  // Helper to check if a branch is always minimized (develop/defaultBranch)
  const isAlwaysMinimized = useCallback((branchName: string) => {
    return branchName === defaultBranch || branchName === "develop";
  }, [defaultBranch]);

  // Helper to check if a node should be minimized (width only for filter, both for always-minimized)
  // Checkbox logic is inverted: checked = minimized (hidden), unchecked = visible
  const isMinimized = useCallback((branchName: string) => {
    if (isAlwaysMinimized(branchName)) return true;
    return filterEnabled && checkedBranches.has(branchName);
  }, [filterEnabled, checkedBranches, isAlwaysMinimized]);

  // Get SVG coordinates from mouse event (accounting for zoom)
  const getSVGCoords = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom,
    };
  }, [zoom]);

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

  // Store refs for use in document event handlers to avoid stale closures
  const dropTargetRef = useRef<string | null>(null);
  dropTargetRef.current = dropTarget;

  const dragStateRef = useRef<DragState | null>(null);
  dragStateRef.current = dragState;

  const onEdgeCreateRef = useRef(onEdgeCreate);
  onEdgeCreateRef.current = onEdgeCreate;

  // Handle drag with document-level events for better UX
  useEffect(() => {
    if (!dragState) return;

    const handleDocumentMouseMove = (e: MouseEvent) => {
      const coords = getSVGCoords(e);
      setDragState((prev) => prev ? { ...prev, currentX: coords.x, currentY: coords.y } : null);
    };

    const handleDocumentMouseUp = () => {
      const currentDragState = dragStateRef.current;
      const currentDropTarget = dropTargetRef.current;
      if (currentDragState && currentDropTarget && currentDropTarget !== currentDragState.fromBranch) {
        onEdgeCreateRef.current?.(currentDropTarget, currentDragState.fromBranch);
      }
      setDragState(null);
      setDropTarget(null);
    };

    document.addEventListener("mousemove", handleDocumentMouseMove);
    document.addEventListener("mouseup", handleDocumentMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleDocumentMouseMove);
      document.removeEventListener("mouseup", handleDocumentMouseUp);
    };
  }, [dragState, getSVGCoords]);

  // Column reorder drag handlers
  const handleColumnDragStart = useCallback((
    branchName: string,
    parentBranch: string,
    siblings: string[],
    startX: number,
    nodeX: number,
    nodeWidth: number,
    originalIndex: number
  ) => {
    const nodeCenterX = nodeX + nodeWidth / 2;
    setColumnDragState({
      draggingBranch: branchName,
      parentBranch,
      siblings,
      startX,
      currentX: startX,
      offsetX: startX - nodeCenterX,
      currentInsertIndex: originalIndex,
    });
  }, []);

  const { layoutNodes, layoutEdges, width, height } = useMemo(() => {
    if (nodes.length === 0 && tentativeNodes.length === 0) {
      return { layoutNodes: [], layoutEdges: [], width: 400, height: 200 };
    }

    // Helper to check if a branch is always minimized (develop/defaultBranch)
    const isAlwaysMinimizedLayout = (branchName: string) => {
      return branchName === defaultBranch || branchName === "develop";
    };

    // Helper to check if a branch should be minimized (for layout calculation)
    const shouldMinimize = (branchName: string) => {
      if (isAlwaysMinimizedLayout(branchName)) return true;
      return filterEnabled && checkedBranches.has(branchName);
    };

    // Helper to check if height should be reduced (only for always-minimized branches)
    const shouldReduceHeight = (branchName: string) => {
      return isAlwaysMinimizedLayout(branchName);
    };

    // Build adjacency map (parent -> children)
    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string>();

    edges.forEach((edge) => {
      const children = childrenMap.get(edge.parent) || [];
      children.push(edge.child);
      childrenMap.set(edge.parent, children);
      parentMap.set(edge.child, edge.parent);
    });

    // Helper to sort children using siblingOrder if available
    const sortChildren = (parentBranch: string, children: string[]): string[] => {
      const order = siblingOrder[parentBranch];
      if (!order || order.length === 0) {
        // No custom order, sort alphabetically
        return [...children].sort((a, b) => a.localeCompare(b));
      }
      // Sort by custom order, unknown children go to the end
      return [...children].sort((a, b) => {
        const indexA = order.indexOf(a);
        const indexB = order.indexOf(b);
        if (indexA === -1 && indexB === -1) return a.localeCompare(b);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    };

    // Find root nodes (nodes that are not children of any other node)
    const childSet = new Set(edges.map((e) => e.child));
    const rootNodes = nodes.filter((n) => !childSet.has(n.branchName));

    // Sort roots: default branch first, then by siblingOrder["__roots__"] if available
    const rootOrder = siblingOrder["__roots__"];
    rootNodes.sort((a, b) => {
      if (a.branchName === defaultBranch) return -1;
      if (b.branchName === defaultBranch) return 1;
      if (rootOrder && rootOrder.length > 0) {
        const indexA = rootOrder.indexOf(a.branchName);
        const indexB = rootOrder.indexOf(b.branchName);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
      }
      return a.branchName.localeCompare(b.branchName);
    });

    // Phase 1: Assign columns to all nodes (without X positions yet)
    const layoutNodes: LayoutNode[] = [];
    const nodeMap = new Map<string, LayoutNode>();

    // Track max column used at each depth for left-aligned layout
    const maxColAtDepth = new Map<number, number>();

    function layoutSubtree(
      branchName: string,
      depth: number,
      minCol: number,
      parentY: number,
      parentHeight: number,
      parentBranch?: string,
      siblings?: string[]
    ): number {
      const node = nodes.find((n) => n.branchName === branchName);
      if (!node || nodeMap.has(branchName)) return minCol;

      const children = childrenMap.get(branchName) || [];

      // Left-aligned: use minCol directly
      const col = minCol;

      // Determine node width and height based on minimized state
      const nodeWidth = shouldMinimize(branchName) ? MINIMIZED_NODE_WIDTH : NODE_WIDTH;
      const nodeHeight = shouldReduceHeight(branchName) ? MINIMIZED_NODE_HEIGHT : NODE_HEIGHT;

      // Vertical layout: Y is based on parent's bottom + gap
      const y = parentY + parentHeight + VERTICAL_GAP;

      const layoutNode: LayoutNode = {
        id: branchName,
        x: 0, // Will be calculated in Phase 2
        y,
        width: nodeWidth,
        height: nodeHeight,
        node,
        depth,
        row: col,
        parentBranch,
        siblings,
      };

      layoutNodes.push(layoutNode);
      nodeMap.set(branchName, layoutNode);

      // Track max column at this depth
      const currentMax = maxColAtDepth.get(depth) ?? -1;
      maxColAtDepth.set(depth, Math.max(currentMax, col));

      // Layout children below, each child gets its own column
      // Sort children using siblingOrder if available
      const sortedChildren = sortChildren(branchName, children);
      let currentCol = minCol;
      sortedChildren.forEach((childName) => {
        currentCol = layoutSubtree(childName, depth + 1, currentCol, y, nodeHeight, branchName, sortedChildren);
      });

      // Return the next available column
      return Math.max(currentCol, minCol + 1);
    }

    // Sort root nodes (non-default roots are siblings)
    const nonDefaultRoots = rootNodes.filter(r => r.branchName !== defaultBranch).map(r => r.branchName);

    // Layout from each root
    let nextCol = 0;
    rootNodes.forEach((root) => {
      const isDefaultRoot = root.branchName === defaultBranch;
      // For roots, parent is "__roots__" and siblings are other non-default roots
      // Initial Y: parentY + parentHeight + VERTICAL_GAP = TOP_PADDING
      // So: parentY = TOP_PADDING - VERTICAL_GAP, parentHeight = 0
      nextCol = layoutSubtree(
        root.branchName,
        0,
        nextCol,
        TOP_PADDING - VERTICAL_GAP, // parentY
        0, // parentHeight
        isDefaultRoot ? undefined : "__roots__",
        isDefaultRoot ? undefined : nonDefaultRoots
      );
    });

    // Handle orphan nodes (not connected to any root)
    nodes.forEach((node) => {
      if (!nodeMap.has(node.branchName)) {
        const depth = 0;
        const col = nextCol++;

        const nodeWidth = shouldMinimize(node.branchName) ? MINIMIZED_NODE_WIDTH : NODE_WIDTH;
        const nodeHeight = shouldReduceHeight(node.branchName) ? MINIMIZED_NODE_HEIGHT : NODE_HEIGHT;

        const layoutNode: LayoutNode = {
          id: node.branchName,
          x: 0, // Will be calculated in Phase 2
          y: TOP_PADDING,
          width: nodeWidth,
          height: nodeHeight,
          node,
          depth,
          row: col,
        };
        layoutNodes.push(layoutNode);
        nodeMap.set(node.branchName, layoutNode);
      }
    });

    // Phase 2: Calculate column max widths and X positions
    // Find max width for each column (excluding defaultBranch from width calculation)
    const columnMaxWidths = new Map<number, number>();
    layoutNodes.forEach((n) => {
      // defaultBranch is excluded from column width calculation (special treatment)
      if (n.id === defaultBranch) return;
      const currentMax = columnMaxWidths.get(n.row) ?? 0;
      columnMaxWidths.set(n.row, Math.max(currentMax, n.width));
    });

    // Calculate cumulative X positions for each column
    const columnXPositions = new Map<number, number>();
    let currentX = LEFT_PADDING;
    const maxColumn = Math.max(...layoutNodes.map((n) => n.row), 0);
    for (let col = 0; col <= maxColumn; col++) {
      columnXPositions.set(col, currentX);
      const colWidth = columnMaxWidths.get(col) ?? NODE_WIDTH;
      currentX += colWidth + HORIZONTAL_GAP;
    }

    // Update X positions for all nodes (centered within column)
    layoutNodes.forEach((n) => {
      const colX = columnXPositions.get(n.row) ?? LEFT_PADDING;
      const colWidth = columnMaxWidths.get(n.row) ?? NODE_WIDTH;
      // Center the node within the column
      n.x = colX + (colWidth - n.width) / 2;
    });

    // Add tentative nodes from planning session
    const tentativeLayoutEdges: LayoutEdge[] = [];
    if (tentativeNodes.length > 0 && tentativeBaseBranch) {
      const baseBranchNode = nodeMap.get(tentativeBaseBranch);
      const baseDepth = baseBranchNode?.depth ?? 0;

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

      // Build parent-child map from tentativeEdges
      const tentativeParentMap = new Map<string, string>(); // childId -> parentId
      console.log("[BranchGraph] tentativeEdges:", tentativeEdges);
      tentativeEdges.forEach((edge) => {
        console.log("[BranchGraph] Edge:", edge.parent, "->", edge.child);
        tentativeParentMap.set(edge.child, edge.parent);
      });

      // Build task ID to branch name map
      const taskIdToBranchMap = new Map<string, string>();
      tentativeNodes.forEach((task) => {
        const branchName = task.branchName || generateTentBranchName(task.title, task.id);
        taskIdToBranchMap.set(task.id, branchName);
      });

      // Calculate depth for each tentative node based on parent-child relationships
      const tentativeDepths = new Map<string, number>();
      const getDepth = (taskId: string): number => {
        if (tentativeDepths.has(taskId)) return tentativeDepths.get(taskId)!;
        const parentId = tentativeParentMap.get(taskId);
        if (parentId) {
          // Has a parent task - depth is parent depth + 1
          const parentDepth = getDepth(parentId);
          const depth = parentDepth + 1;
          tentativeDepths.set(taskId, depth);
          return depth;
        }
        // No parent task - depth is base depth + 1
        const depth = baseDepth + 1;
        tentativeDepths.set(taskId, depth);
        return depth;
      };

      // Calculate depths for all tasks
      tentativeNodes.forEach((task) => getDepth(task.id));
      console.log("[BranchGraph] tentativeDepths:", Object.fromEntries(tentativeDepths));

      // Build children map for tentative nodes
      const tentativeChildrenMap = new Map<string, string[]>(); // parentId -> childIds
      tentativeEdges.forEach((edge) => {
        if (!tentativeChildrenMap.has(edge.parent)) {
          tentativeChildrenMap.set(edge.parent, []);
        }
        tentativeChildrenMap.get(edge.parent)!.push(edge.child);
      });
      console.log("[BranchGraph] tentativeChildrenMap:", Object.fromEntries(tentativeChildrenMap));

      // Group tasks by depth for horizontal positioning
      const tasksByDepth = new Map<number, typeof tentativeNodes>();
      tentativeNodes.forEach((task) => {
        const depth = tentativeDepths.get(task.id)!;
        if (!tasksByDepth.has(depth)) tasksByDepth.set(depth, []);
        tasksByDepth.get(depth)!.push(task);
      });

      // Find root tentative nodes (no parent in tentativeEdges)
      const rootTentativeNodes = tentativeNodes.filter(
        (task) => !tentativeParentMap.has(task.id)
      );
      console.log("[BranchGraph] tentativeNodes count:", tentativeNodes.length);
      console.log("[BranchGraph] rootTentativeNodes count:", rootTentativeNodes.length);
      console.log("[BranchGraph] rootTentativeNodes:", rootTentativeNodes.map(t => t.title));

      // Track column assignments for tentative nodes
      const taskIdToCol = new Map<string, number>();

      // Layout tentative tree recursively - children are placed below parent in same column
      const layoutTentativeSubtree = (taskId: string, col: number): number => {
        const task = tentativeNodes.find((t) => t.id === taskId);
        if (!task) {
          console.log("[BranchGraph] layoutTentativeSubtree: task not found for", taskId);
          return col;
        }

        const branchName = taskIdToBranchMap.get(task.id)!;
        if (nodeMap.has(branchName)) {
          console.log("[BranchGraph] layoutTentativeSubtree: branch already exists", branchName);
          return col;
        }

        const tentDepth = tentativeDepths.get(task.id)!;
        const children = tentativeChildrenMap.get(taskId) || [];
        console.log("[BranchGraph] layoutTentativeSubtree:", task.title, "depth:", tentDepth, "col:", col, "children:", children.length);
        taskIdToCol.set(taskId, col);

        const tentDummyNode: TreeNode = {
          branchName,
          badges: [],
          lastCommitAt: "",
        };

        const layoutNode: LayoutNode = {
          id: branchName,
          x: 0, // Will be recalculated after all nodes are placed
          y: TOP_PADDING + tentDepth * (NODE_HEIGHT + VERTICAL_GAP),
          width: NODE_WIDTH, // Tentative nodes always use full width
          height: TENTATIVE_NODE_HEIGHT,
          node: tentDummyNode,
          depth: tentDepth,
          row: col,
          isTentative: true,
          tentativeTitle: task.title,
          taskId: task.id,
        };

        layoutNodes.push(layoutNode);
        nodeMap.set(branchName, layoutNode);

        // Layout children - first child uses same column, additional children get new columns
        let currentCol = col;
        children.forEach((childId, index) => {
          if (index === 0) {
            // First child stays in same column (vertical line)
            layoutTentativeSubtree(childId, col);
          } else {
            // Additional children get new columns
            currentCol++;
            layoutTentativeSubtree(childId, currentCol);
          }
        });

        return Math.max(col, currentCol);
      };

      // Layout each root tentative node tree - start AFTER all existing branches to avoid overlap
      // Calculate max column used by existing nodes
      const maxExistingCol = layoutNodes.reduce((max, n) => Math.max(max, n.row), -1);
      let tentativeCol = maxExistingCol + 1; // Start tentative nodes after all existing branches
      rootTentativeNodes.forEach((task) => {
        tentativeCol = layoutTentativeSubtree(task.id, tentativeCol) + 1;
      });

      // Recalculate column widths and X positions after adding tentative nodes
      columnMaxWidths.clear();
      layoutNodes.forEach((n) => {
        // defaultBranch is excluded from column width calculation
        if (n.id === defaultBranch) return;
        const curMax = columnMaxWidths.get(n.row) ?? 0;
        columnMaxWidths.set(n.row, Math.max(curMax, n.width));
      });

      columnXPositions.clear();
      let recalcX = LEFT_PADDING;
      const newMaxColumn = Math.max(...layoutNodes.map((n) => n.row), 0);
      for (let col = 0; col <= newMaxColumn; col++) {
        columnXPositions.set(col, recalcX);
        const colWidth = columnMaxWidths.get(col) ?? NODE_WIDTH;
        recalcX += colWidth + HORIZONTAL_GAP;
      }

      layoutNodes.forEach((n) => {
        const colX = columnXPositions.get(n.row) ?? LEFT_PADDING;
        const colWidth = columnMaxWidths.get(n.row) ?? NODE_WIDTH;
        // defaultBranch is positioned at column start (not centered)
        if (n.id === defaultBranch) {
          n.x = colX;
        } else {
          // Center the node within the column
          n.x = colX + (colWidth - n.width) / 2;
        }
      });

      // Create edges for tentative nodes
      tentativeNodes.forEach((task) => {
        const branchName = taskIdToBranchMap.get(task.id)!;
        const toNode = nodeMap.get(branchName);
        if (!toNode) return;

        const parentTaskId = tentativeParentMap.get(task.id);
        let fromNode: LayoutNode | undefined;

        if (parentTaskId) {
          // Has a parent task - find the parent's layout node
          const parentBranchName = taskIdToBranchMap.get(parentTaskId);
          if (parentBranchName) {
            fromNode = nodeMap.get(parentBranchName);
          }
        }

        if (!fromNode) {
          // No parent task or parent not found - connect to base branch
          fromNode = baseBranchNode || layoutNodes[0];
        }

        if (fromNode) {
          tentativeLayoutEdges.push({
            from: fromNode,
            to: toNode,
            isDesigned: false,
            isTentative: true,
          });
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

    // Calculate canvas size (add extra space for badges below nodes)
    const BADGE_HEIGHT = 20; // Space for badges below nodes
    const maxX = Math.max(...layoutNodes.map((n) => n.x + n.width), 0) + RIGHT_PADDING;
    const maxY = Math.max(
      ...layoutNodes.map((n) => n.y + n.height + BADGE_HEIGHT),
      0
    ) + TOP_PADDING;

    return {
      layoutNodes,
      layoutEdges,
      width: Math.max(400, maxX),
      height: Math.max(150, maxY),
    };
  }, [nodes, edges, defaultBranch, tentativeNodes, tentativeEdges, tentativeBaseBranch, checkedBranches, filterEnabled, siblingOrder]);

  // Helper to get column bounds (used in multiple places)
  const getColumnBoundsHelper = useCallback((branchId: string) => {
    const getDescendants = (id: string): string[] => {
      const children = edges.filter(e => e.parent === id).map(e => e.child);
      const descendants: string[] = [];
      for (const child of children) {
        descendants.push(child);
        descendants.push(...getDescendants(child));
      }
      return descendants;
    };

    const ids = [branchId, ...getDescendants(branchId)];
    const columnNodes = layoutNodes.filter(n => ids.includes(n.id));
    if (columnNodes.length === 0) return null;

    let minX = Infinity, maxX = -Infinity;
    for (const node of columnNodes) {
      const w = node.width ?? NODE_WIDTH;
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x + w);
    }
    return { left: minX, right: maxX, width: maxX - minX, centerX: (minX + maxX) / 2 };
  }, [layoutNodes, edges]);

  // Handle column drag movement and drop (must be after layoutNodes is defined)
  // Use ref to avoid re-running effect on every state update during drag
  useEffect(() => {
    if (!columnDragState) return;

    // Disable text selection during drag
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      const dragState = columnDragStateRef.current;
      if (!dragState) return;

      const coords = getSVGCoords(e);
      const newX = coords.x;

      // Calculate drag center position
      const dragCenterX = newX - dragState.offsetX;

      // Get column bounds for all siblings, sorted by left edge
      const siblingBounds = dragState.siblings.map(s => {
        const bounds = getColumnBoundsHelper(s);
        return {
          id: s,
          left: bounds?.left ?? 0,
          right: bounds?.right ?? NODE_WIDTH,
          width: bounds?.width ?? NODE_WIDTH,
          centerX: bounds?.centerX ?? NODE_WIDTH / 2,
        };
      }).sort((a, b) => a.left - b.left);

      const draggingInfo = siblingBounds.find(s => s.id === dragState.draggingBranch);
      if (!draggingInfo) return;

      const currentInsertIndex = dragState.currentInsertIndex;

      // Build current order with dragging item at currentInsertIndex
      const currentOrder = siblingBounds.filter(s => s.id !== dragState.draggingBranch);
      currentOrder.splice(currentInsertIndex, 0, draggingInfo);

      // Calculate visual positions based on current swap state
      const startX = siblingBounds[0].left;
      let layoutX = startX;
      const visualPositions: { id: string; left: number; right: number; centerX: number }[] = [];

      for (const col of currentOrder) {
        const left = layoutX;
        const right = left + col.width;
        visualPositions.push({ id: col.id, left, right, centerX: (left + right) / 2 });
        layoutX = right + HORIZONTAL_GAP;
      }

      // Calculate dragging column's visual edges
      const dragLeftEdge = dragCenterX - draggingInfo.width / 2;
      const dragRightEdge = dragCenterX + draggingInfo.width / 2;

      // For root siblings, include separator as a virtual element
      const isRootSiblings = dragState.parentBranch === defaultBranch;
      const currentSepIndex = focusSeparatorIndex ?? dragState.siblings.length;

      // Build positions including separator as a virtual element
      type PositionItem = { id: string; left: number; right: number; centerX: number; isSeparator?: boolean };
      let positionsWithSeparator: PositionItem[] = visualPositions.map(p => ({ ...p }));
      let adjustedInsertIndex = currentInsertIndex;

      if (isRootSiblings) {
        // Insert separator at its current position
        const SEPARATOR_WIDTH = SEPARATOR_HALF_WIDTH * 2; // Full width of separator zone
        // Find where separator should be inserted visually
        let sepVisualLeft: number;
        if (currentSepIndex <= 0) {
          sepVisualLeft = (positionsWithSeparator[0]?.left ?? 0) - HORIZONTAL_GAP - SEPARATOR_WIDTH;
        } else if (currentSepIndex >= positionsWithSeparator.length) {
          const lastPos = positionsWithSeparator[positionsWithSeparator.length - 1];
          sepVisualLeft = (lastPos?.right ?? 0) + HORIZONTAL_GAP;
        } else {
          // Between two columns
          const leftCol = positionsWithSeparator[currentSepIndex - 1];
          const rightCol = positionsWithSeparator[currentSepIndex];
          sepVisualLeft = ((leftCol?.right ?? 0) + (rightCol?.left ?? 0)) / 2 - SEPARATOR_WIDTH / 2;
        }

        const separatorItem: PositionItem = {
          id: "__separator__",
          left: sepVisualLeft,
          right: sepVisualLeft + SEPARATOR_WIDTH,
          centerX: sepVisualLeft + SEPARATOR_WIDTH / 2,
          isSeparator: true,
        };

        // Insert separator at the right position
        positionsWithSeparator.splice(currentSepIndex, 0, separatorItem);

        // Adjust insert index if dragging column is after separator
        if (currentInsertIndex >= currentSepIndex) {
          adjustedInsertIndex = currentInsertIndex + 1;
        }
      }

      // Swap detection based on edge overlap (now including separator)
      let newAdjustedInsertIndex = adjustedInsertIndex;

      // Left swap
      if (adjustedInsertIndex > 0) {
        const leftNeighbor = positionsWithSeparator[adjustedInsertIndex - 1];
        if (dragLeftEdge < leftNeighbor.left) {
          newAdjustedInsertIndex = adjustedInsertIndex - 1;
        }
      }

      // Right swap
      if (adjustedInsertIndex < positionsWithSeparator.length - 1) {
        const rightNeighbor = positionsWithSeparator[adjustedInsertIndex + 1];
        if (dragRightEdge > rightNeighbor.right) {
          newAdjustedInsertIndex = adjustedInsertIndex + 1;
        }
      }

      // Convert back to column-only index and update separator if needed
      let newInsertIndex = newAdjustedInsertIndex;
      if (isRootSiblings) {
        // Check if we swapped with separator
        if (newAdjustedInsertIndex !== adjustedInsertIndex) {
          const swappedWith = positionsWithSeparator[
            newAdjustedInsertIndex < adjustedInsertIndex
              ? adjustedInsertIndex - 1
              : adjustedInsertIndex + 1
          ];
          if (swappedWith?.isSeparator && onFocusSeparatorIndexChange) {
            // Swapped with separator - update separator index
            if (newAdjustedInsertIndex < adjustedInsertIndex) {
              // Moved left past separator - separator moves right
              onFocusSeparatorIndexChange(currentSepIndex + 1);
            } else {
              // Moved right past separator - separator moves left
              onFocusSeparatorIndexChange(currentSepIndex - 1);
            }
          }
        }

        // Convert adjusted index back to column-only index
        const newSepIndex = focusSeparatorIndex ?? dragState.siblings.length;
        if (newAdjustedInsertIndex > newSepIndex) {
          newInsertIndex = newAdjustedInsertIndex - 1;
        } else {
          newInsertIndex = newAdjustedInsertIndex;
        }
      }

      // Update state
      setColumnDragState(prev => prev ? {
        ...prev,
        currentX: newX,
        currentInsertIndex: newInsertIndex,
      } : null);
    };

    const handleMouseUp = () => {
      const dragState = columnDragStateRef.current;
      if (dragState && onSiblingOrderChange) {
        // Get column bounds sorted by left edge
        const siblingBounds = dragState.siblings.map(s => {
          const bounds = getColumnBoundsHelper(s);
          return { id: s, left: bounds?.left ?? 0 };
        }).sort((a, b) => a.left - b.left);

        const insertIndex = dragState.currentInsertIndex;

        // Build new order based on currentInsertIndex
        const sorted = siblingBounds.map(s => s.id);
        const reordered = sorted.filter(s => s !== dragState.draggingBranch);
        reordered.splice(insertIndex, 0, dragState.draggingBranch);

        // Debug: log the drag result
        console.log("[BranchGraph] Column drag result:", {
          draggingBranch: dragState.draggingBranch,
          insertIndex,
          siblingBounds: siblingBounds.map(s => ({ id: s.id, left: s.left })),
          sorted,
          reordered,
          changed: JSON.stringify(reordered) !== JSON.stringify(sorted),
        });

        // Only update if order changed
        if (JSON.stringify(reordered) !== JSON.stringify(sorted)) {
          const newSiblingOrder = { ...siblingOrder };
          newSiblingOrder[dragState.parentBranch] = reordered;
          onSiblingOrderChange(newSiblingOrder);
        }
      }
      setColumnDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = originalUserSelect;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!columnDragState, getSVGCoords, onSiblingOrderChange, siblingOrder, getColumnBoundsHelper, focusSeparatorIndex, onFocusSeparatorIndexChange, defaultBranch]);

  // Handle separator drag
  useEffect(() => {
    if (!separatorDragState) return;

    const originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      const coords = getSVGCoords(e);
      const newX = coords.x;

      // Get root siblings for boundary calculation
      const children = edges.filter(e => e.parent === defaultBranch).map(e => e.child);
      const childNodes = layoutNodes.filter(n => children.includes(n.id));
      const sortedSiblings = childNodes.sort((a, b) => a.x - b.x);

      const currentIndex = separatorDragState.currentIndex;
      let newIndex = currentIndex;

      // Calculate visual positions for boundary checking
      // Separator is between column at currentIndex-1 and currentIndex

      // Check if we should move left (drag passed left column's left edge)
      if (currentIndex > 0) {
        const leftSibling = sortedSiblings[currentIndex - 1];
        if (leftSibling) {
          const leftBounds = getColumnBoundsHelper(leftSibling.id);
          const leftEdge = leftBounds?.left ?? leftSibling.x;
          if (newX < leftEdge) {
            newIndex = currentIndex - 1;
          }
        }
      }

      // Check if we should move right (drag passed right column's right edge)
      if (currentIndex < sortedSiblings.length) {
        const rightSibling = sortedSiblings[currentIndex];
        if (rightSibling) {
          const rightBounds = getColumnBoundsHelper(rightSibling.id);
          const rightEdge = rightBounds?.right ?? (rightSibling.x + NODE_WIDTH);
          if (newX > rightEdge) {
            newIndex = currentIndex + 1;
          }
        }
      }

      // Only update if index changed
      if (newIndex !== currentIndex) {
        setSeparatorDragState(prev => prev ? {
          ...prev,
          currentX: newX,
          currentIndex: newIndex,
        } : null);

        if (onFocusSeparatorIndexChange) {
          onFocusSeparatorIndexChange(newIndex);
        }
      } else {
        setSeparatorDragState(prev => prev ? {
          ...prev,
          currentX: newX,
        } : null);
      }
    };

    const handleMouseUp = () => {
      setSeparatorDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = originalUserSelect;
    };
  }, [separatorDragState, getSVGCoords, edges, defaultBranch, layoutNodes, getColumnBoundsHelper, onFocusSeparatorIndexChange]);

  // Handle paint mode range selection drag
  useEffect(() => {
    if (!paintModeDragState) return;

    const originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      const coords = getSVGCoords(e);
      setPaintModeDragState(prev => prev ? {
        ...prev,
        currentX: coords.x,
        currentY: coords.y,
      } : null);
    };

    const handleMouseUp = () => {
      const dragState = paintModeDragStateRef.current;
      if (dragState && paintMode && onCheckedChange) {
        // Calculate selection rectangle bounds
        const minX = Math.min(dragState.startX, dragState.currentX);
        const maxX = Math.max(dragState.startX, dragState.currentX);
        const minY = Math.min(dragState.startY, dragState.currentY);
        const maxY = Math.max(dragState.startY, dragState.currentY);

        // Find all nodes within the selection rectangle
        const selectedNodes = layoutNodes.filter(node => {
          if (node.id === defaultBranch || node.isTentative) return false;
          const nodeX = node.x;
          const nodeY = node.y;
          const nodeRight = nodeX + node.width;
          const nodeBottom = nodeY + node.height;

          // Check if node overlaps with selection rectangle
          return !(nodeRight < minX || nodeX > maxX || nodeBottom < minY || nodeY > maxY);
        });

        // Apply paint action to all selected nodes
        const shouldCheck = paintMode === "check";
        selectedNodes.forEach(node => {
          onCheckedChange(node.id, shouldCheck);
        });
      }
      setPaintModeDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = originalUserSelect;
    };
  }, [paintModeDragState, getSVGCoords, layoutNodes, defaultBranch, paintMode, onCheckedChange]);

  // Get root siblings (children of default branch) sorted by X position
  const rootSiblings = useMemo(() => {
    const children = edges.filter(e => e.parent === defaultBranch).map(e => e.child);
    const childNodes = layoutNodes.filter(n => children.includes(n.id));
    return childNodes.sort((a, b) => a.x - b.x).map(n => n.id);
  }, [edges, defaultBranch, layoutNodes]);

  // Effective separator index: if null, place at the end (all items focused)
  const effectiveSeparatorIndex = focusSeparatorIndex ?? rootSiblings.length;

  // Helper to check if a branch is on the unfocused (right) side of separator
  const isUnfocusedBranch = useCallback((branchId: string): boolean => {
    // Find which root sibling this branch belongs to
    const findRootSibling = (id: string, visited: Set<string> = new Set()): string | null => {
      if (rootSiblings.includes(id)) return id;
      if (visited.has(id)) return null; // Prevent infinite loop on cycles
      visited.add(id);
      const parent = edges.find(e => e.child === id)?.parent;
      if (!parent || parent === defaultBranch || parent === id) return null;
      return findRootSibling(parent, visited);
    };

    const rootSibling = findRootSibling(branchId);
    if (!rootSibling) return false;

    const siblingIndex = rootSiblings.indexOf(rootSibling);
    return siblingIndex >= effectiveSeparatorIndex;
  }, [effectiveSeparatorIndex, rootSiblings, edges, defaultBranch]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    // Vertical edge: from bottom of parent to top of child
    const fromHeight = edge.from.height;
    const fromWidth = edge.from.width ?? NODE_WIDTH;
    const toWidth = edge.to.width ?? NODE_WIDTH;

    // Apply drag offset based on which column each node belongs to
    const fromOffsetX = getNodeOffset(edge.from.id);
    const toOffsetX = getNodeOffset(edge.to.id);

    const startX = edge.from.x + fromWidth / 2 + fromOffsetX;
    const startY = edge.from.y + fromHeight;
    const endX = edge.to.x + toWidth / 2 + toOffsetX;
    const endY = edge.to.y;

    // Simple path: go down, then horizontal, then down to target
    const cornerY = startY + 20;
    const path = `M ${startX} ${startY} L ${startX} ${cornerY} L ${endX} ${cornerY} L ${endX} ${endY}`;

    // Tentative edges use dashed lines with purple color
    const strokeColor = edge.isTentative ? "#9c27b0" : edge.isDesigned ? "#9c27b0" : "#4b5563";
    const strokeDash = edge.isTentative ? "4,4" : undefined;

    // Check if edge is unfocused (either endpoint is on the right side of separator)
    const edgeUnfocused = isUnfocusedBranch(edge.from.id) || isUnfocusedBranch(edge.to.id);
    const baseOpacity = edge.isTentative ? 0.7 : 1;
    const edgeOpacity = edgeUnfocused ? baseOpacity * 0.3 : baseOpacity;

    return (
      <g key={`edge-${index}`} opacity={edgeOpacity}>
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

  // Helper to check if a node belongs to a specific sibling's column
  const getColumnRoot = useCallback((nodeId: string): string | null => {
    if (!columnDragState) return null;
    const { siblings } = columnDragState;

    // If this node is a sibling root, return it
    if (siblings.includes(nodeId)) return nodeId;

    // Check ancestors to find which sibling column this belongs to
    const ancestors: string[] = [];
    let currentId = nodeId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(currentId)) break; // Cycle detection
      visited.add(currentId);
      const parent = edges.find(e => e.child === currentId)?.parent;
      if (!parent || parent === currentId) break;
      ancestors.push(parent);
      currentId = parent;
    }
    return siblings.find(s => ancestors.includes(s)) ?? null;
  }, [columnDragState, edges]);

  // Helper to check if a node is in the dragging column
  const isInDraggingColumn = useCallback((nodeId: string): boolean => {
    if (!columnDragState) return false;
    return getColumnRoot(nodeId) === columnDragState.draggingBranch;
  }, [columnDragState, getColumnRoot]);

  // Calculate column offsets for swapping animation (works for both column drag and separator drag)
  const columnOffsets = useMemo(() => {
    const offsets = new Map<string, number>();

    // Handle column drag
    if (columnDragState) {
      const { draggingBranch, siblings, currentX, offsetX, currentInsertIndex } = columnDragState;

      // Get column bounds for all siblings, sorted by left edge
      const siblingBounds = siblings.map(s => {
        const bounds = getColumnBoundsHelper(s);
        return {
          id: s,
          left: bounds?.left ?? 0,
          right: bounds?.right ?? NODE_WIDTH,
          width: bounds?.width ?? NODE_WIDTH,
          centerX: bounds?.centerX ?? NODE_WIDTH / 2,
        };
      }).sort((a, b) => a.left - b.left);

      // Current drag position (center of dragging column)
      const dragCenterX = currentX - offsetX;
      const draggingInfo = siblingBounds.find(s => s.id === draggingBranch);
      if (!draggingInfo) return offsets;

      const draggingOriginalCenterX = draggingInfo.centerX;
      const draggingWidth = draggingInfo.width;

      // Original index of dragging column
      const originalIndex = siblingBounds.findIndex(s => s.id === draggingBranch);
      const insertIndex = currentInsertIndex;

      // Calculate offsets based on insertIndex (from state)
      const shiftAmount = draggingWidth + HORIZONTAL_GAP;

      for (let i = 0; i < siblingBounds.length; i++) {
        const sibling = siblingBounds[i];
        if (sibling.id === draggingBranch) {
          // Dragging column follows mouse
          offsets.set(sibling.id, dragCenterX - draggingOriginalCenterX);
        } else {
          // Other columns shift based on insert position
          let offset = 0;
          if (i < originalIndex && i >= insertIndex) {
            // Columns between insert and original: shift right
            offset = shiftAmount;
          } else if (i > originalIndex && i <= insertIndex) {
            // Columns between original and insert: shift left
            offset = -shiftAmount;
          }
          offsets.set(sibling.id, offset);
        }
      }
    }

    // Note: During separator drag, columns don't shift - the separator follows the mouse
    // and only updates its index when crossing column boundaries

    return offsets;
  }, [columnDragState, getColumnBoundsHelper]);

  // Get offset for a specific node based on its column and separator position
  const getNodeOffset = useCallback((nodeId: string): number => {
    let offset = 0;

    // Drag offset
    const columnRoot = getColumnRoot(nodeId);
    if (columnRoot) {
      offset += columnOffsets.get(columnRoot) ?? 0;
    }

    // Separator spacing offset - unfocused branches (right of separator) are shifted right
    if (isUnfocusedBranch(nodeId)) {
      offset += SEPARATOR_HALF_WIDTH * 2;
    }

    return offset;
  }, [getColumnRoot, columnOffsets, isUnfocusedBranch]);

  // For backwards compatibility
  const columnDragOffset = useMemo(() => {
    if (!columnDragState) return 0;
    return columnOffsets.get(columnDragState.draggingBranch) ?? 0;
  }, [columnDragState, columnOffsets]);

  const renderNode = (layoutNode: LayoutNode) => {
    const { id, x: originalX, y, node, isTentative, tentativeTitle, parentBranch, siblings } = layoutNode;

    // Apply drag offset based on which column this node belongs to
    const nodeOffset = getNodeOffset(id);
    const x = originalX + nodeOffset;

    const isSelected = selectedBranch === id;
    const isDefault = id === defaultBranch;
    const hasWorktree = !!node.worktree;
    // Use branchLinks as single source of truth for PR info
    const prLink = branchLinks.get(id)?.find(l => l.linkType === "pr");
    const hasPR = !!prLink;
    const isMerged = prLink?.status === "merged";

    // Calculate checksStatus from checks array (more reliable than checksStatus field)
    const computedChecksStatus = (() => {
      if (!prLink?.checks) return prLink?.checksStatus ?? null;
      try {
        const checks = JSON.parse(prLink.checks) as { conclusion: string | null }[];
        if (checks.length === 0) return prLink?.checksStatus ?? null;
        const hasFailure = checks.some(c => c.conclusion === "FAILURE" || c.conclusion === "ERROR");
        const hasPending = checks.some(c => c.conclusion === null);
        const allSuccess = checks.every(c => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED");
        if (hasFailure) return "failure";
        if (hasPending) return "pending";
        if (allSuccess) return "success";
        return prLink?.checksStatus ?? null;
      } catch {
        return prLink?.checksStatus ?? null;
      }
    })();

    // Check if PR base branch matches graph parent
    const graphParent = edges.find(e => e.child === id)?.parent;
    const prBaseBranch = prLink?.baseBranch;
    const hasPRBaseMismatch = hasPR && prBaseBranch && graphParent && prBaseBranch !== graphParent;
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
      if (prLink?.status === "open") {
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

    // Check if this node should be minimized
    const nodeIsMinimized = !isTentative && isMinimized(id);
    const nodeWidth = nodeIsMinimized ? MINIMIZED_NODE_WIDTH : NODE_WIDTH;
    // Only defaultBranch gets reduced height
    const nodeHeight = isTentative ? TENTATIVE_NODE_HEIGHT : (isDefault ? MINIMIZED_NODE_HEIGHT : NODE_HEIGHT);
    const isChecked = checkedBranches.has(id);

    // Get description label (first word/token before whitespace)
    const fullDescription = branchDescriptions.get(id);
    const descriptionLabel = fullDescription?.split(/\s+/)[0] || null;

    // In edit mode, the whole node is draggable (line starts from top edge of node for vertical layout)
    const handleNodeMouseDown = canDrag ? (e: React.MouseEvent) => {
      e.stopPropagation();
      handleDragStart(id, x + nodeWidth / 2, y);
    } : undefined;

    // Check if node is unfocused (to the right of separator)
    const nodeUnfocused = isUnfocusedBranch(id);
    const baseNodeOpacity = isTentative ? 0.8 : isDragging ? 0.5 : isMerged ? 0.6 : 1;
    const nodeOpacity = nodeUnfocused ? baseNodeOpacity * 0.3 : baseNodeOpacity;

    // Determine cursor style
    const getCursorStyle = () => {
      if (paintMode && !isDefault && !isTentative) return "pointer";
      if (canDrag) return isDragging ? "grabbing" : "grab";
      if (isTentative) return "default";
      return "pointer";
    };

    return (
      <g
        key={id}
        style={{ cursor: getCursorStyle() }}
        opacity={nodeOpacity}
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
          width={nodeWidth}
          height={nodeHeight}
          rx={6}
          ry={6}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isSelected || isDropTarget ? 2 : 1.5}
          strokeDasharray={strokeDash}
          onClick={() => {
            if (isTentative || dragState) return;
            if (paintMode && !isDefault) {
              // In paint mode, apply the paint action
              onCheckedChange?.(id, paintMode === "check");
            } else {
              onSelectBranch(id);
            }
          }}
        />
        {/* Highlighted overlay with rotating dashed border */}
        {highlightedBranch === id && (
          <rect
            x={x - 3}
            y={y - 3}
            width={nodeWidth + 6}
            height={nodeHeight + 6}
            rx={9}
            ry={9}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={2}
            strokeDasharray="8,4"
            style={{ pointerEvents: "none" }}
          >
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to="24"
              dur="1.5s"
              repeatCount="indefinite"
            />
          </rect>
        )}

        {/* Checkbox for filtering - only for non-tentative, non-default nodes (including minimized) */}
        {!isTentative && !isDefault && (
          <foreignObject
            x={x + 4}
            y={y + nodeHeight - 20}
            width={20}
            height={20}
            style={{ overflow: "visible" }}
          >
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => {
                e.stopPropagation();
                onCheckedChange?.(id, e.target.checked);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 14,
                height: 14,
                cursor: "pointer",
                accentColor: "#3b82f6",
              }}
            />
          </foreignObject>
        )}

        {/* Node content using foreignObject */}
        <foreignObject
          x={x + 8}
          y={y + 4}
          width={nodeWidth - 16}
          height={nodeHeight - 8}
          style={{ pointerEvents: "none", overflow: "visible" }}
        >
          {nodeIsMinimized ? (
            /* Minimized view - description label, CI, and branch name */
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: isDefault ? "center" : "flex-start",
                gap: isDefault ? 1 : 4,
                overflow: "hidden",
              }}
            >
              {/* Row 1: Description label */}
              {descriptionLabel && (
                <span style={{
                  fontSize: 10,
                  padding: "1px 4px",
                  borderRadius: 3,
                  background: "#1e3a5f",
                  border: "1px solid #3b82f6",
                  color: "#93c5fd",
                  whiteSpace: "nowrap",
                }}>{descriptionLabel}</span>
              )}
              {/* Row 2: R + CI + PR badges (no wrap, may overflow) - only render if there's content */}
              {(hasPR || computedChecksStatus || (prLink?.reviewers && (() => {
                const reviewers = JSON.parse(prLink.reviewers) as string[];
                return reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]")).length > 0;
              })())) && (
              <div style={{ display: "flex", gap: 3, flexWrap: "nowrap" }}>
                {/* R (Review) badge - only show if human reviewers exist */}
                {prLink?.reviewers && (() => {
                  const reviewers = JSON.parse(prLink.reviewers) as string[];
                  return reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]")).length > 0;
                })() && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: prLink?.reviewDecision === "APPROVED" ? "#14532d" : prLink?.reviewDecision === "CHANGES_REQUESTED" ? "#7f1d1d" : "#78350f",
                    border: `1px solid ${prLink?.reviewDecision === "APPROVED" ? "#22c55e" : prLink?.reviewDecision === "CHANGES_REQUESTED" ? "#ef4444" : "#f59e0b"}`,
                    color: prLink?.reviewDecision === "APPROVED" ? "#4ade80" : prLink?.reviewDecision === "CHANGES_REQUESTED" ? "#f87171" : "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>{prLink?.reviewDecision === "APPROVED" ? "R✔" : prLink?.reviewDecision === "CHANGES_REQUESTED" ? "R✗" : "R"}</span>
                )}
                {/* CI badge - use computed status from checks array */}
                {computedChecksStatus && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: computedChecksStatus === "success" ? "#14532d" : computedChecksStatus === "failure" ? "#7f1d1d" : "#78350f",
                    border: `1px solid ${computedChecksStatus === "success" ? "#22c55e" : computedChecksStatus === "failure" ? "#ef4444" : "#f59e0b"}`,
                    color: computedChecksStatus === "success" ? "#4ade80" : computedChecksStatus === "failure" ? "#f87171" : "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>{computedChecksStatus === "success" ? "CI✔" : computedChecksStatus === "failure" ? "CI✗" : "CI"}</span>
                )}
                {/* PR badge - shows ✓ when approved by human reviewer */}
                {hasPR && (() => {
                  const isApproved = prLink?.reviewDecision === "APPROVED" && prLink?.reviewers && (() => {
                    const reviewers = JSON.parse(prLink.reviewers) as string[];
                    return reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]")).length > 0;
                  })();
                  return (
                    <span style={{
                      fontSize: 10,
                      padding: "1px 4px",
                      borderRadius: 3,
                      background: isMerged ? "#3b0764" : isApproved ? "#14532d" : "#374151",
                      border: isMerged ? "1px solid #9333ea" : isApproved ? "1px solid #22c55e" : "1px solid #4b5563",
                      color: isMerged ? "#c084fc" : isApproved ? "#4ade80" : "#e5e7eb",
                      whiteSpace: "nowrap",
                    }}>{isApproved ? "PR ✓" : "PR"}</span>
                  );
                })()}
              </div>
              )}
              {/* Row 3: (default) label */}
              {isDefault && (
                <div style={{
                  fontSize: 9,
                  color: "#6b7280",
                }}>(default)</div>
              )}
              {/* Row 4: Branch name */}
              <div style={{
                fontSize: 10,
                fontFamily: "monospace",
                color: "#9ca3af",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}>{id}</div>
            </div>
          ) : (
          <div
            style={{
              width: nodeWidth - 16,
              height: "100%",
              display: "flex",
              flexDirection: "column",
              justifyContent: hasPR ? "flex-start" : "center",
              gap: 4,
              overflow: "hidden",
            }}
          >
            {/* Line 1: Description label (left) + Status labels (right) - only if content exists */}
            {(descriptionLabel || hasPR) && (
              <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", justifyContent: descriptionLabel ? "space-between" : "flex-end", alignItems: "center" }}>
                {/* Description label - left */}
                {descriptionLabel && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#1e3a5f",
                    border: "1px solid #3b82f6",
                    color: "#93c5fd",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 80,
                  }}>{descriptionLabel}</span>
                )}
                {/* PR status badges - right */}
                {hasPR && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "nowrap" }}>
                {/* Review status - based on reviewDecision from branchLinks (only show if human reviewers exist) */}
                {/* Approved status is now shown in the PR badge */}
                {prLink?.reviewDecision === "CHANGES_REQUESTED" && prLink?.reviewers && (() => {
                  const reviewers = JSON.parse(prLink.reviewers) as string[];
                  return reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]")).length > 0;
                })() && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#7f1d1d",
                    border: "1px solid #ef4444",
                    color: "#f87171",
                    whiteSpace: "nowrap",
                  }}>Changes ✗</span>
                )}
                {prLink?.reviewDecision === "REVIEW_REQUIRED" && prLink?.reviewers && (() => {
                  const reviewers = JSON.parse(prLink.reviewers) as string[];
                  const humanReviewers = reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]"));
                  return humanReviewers.length > 0;
                })() && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#78350f",
                    border: "1px solid #f59e0b",
                    color: "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>Review</span>
                )}
                {/* Reviewers requested but no decision yet */}
                {!prLink?.reviewDecision && prLink?.reviewers && (() => {
                  const reviewers = JSON.parse(prLink.reviewers) as string[];
                  const humanReviewers = reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]"));
                  return humanReviewers.length > 0;
                })() && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#78350f",
                    border: "1px solid #f59e0b",
                    color: "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>Review</span>
                )}
                {/* CI status - use computed status from checks array */}
                {computedChecksStatus === "success" && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#14532d",
                    border: "1px solid #22c55e",
                    color: "#4ade80",
                    whiteSpace: "nowrap",
                  }}>CI ✔</span>
                )}
                {computedChecksStatus === "failure" && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#7f1d1d",
                    border: "1px solid #ef4444",
                    color: "#f87171",
                    whiteSpace: "nowrap",
                  }}>CI ✗</span>
                )}
                {computedChecksStatus === "pending" && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#78350f",
                    border: "1px solid #f59e0b",
                    color: "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>CI …</span>
                )}
                {/* PR indicator - shows ✓ when approved by human reviewer */}
                {(() => {
                  const isApproved = prLink?.reviewDecision === "APPROVED" && prLink?.reviewers && (() => {
                    const reviewers = JSON.parse(prLink.reviewers) as string[];
                    return reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]")).length > 0;
                  })();
                  return (
                    <span style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: isMerged ? "#3b0764" : isApproved ? "#14532d" : "#374151",
                      border: isMerged ? "1px solid #9333ea" : isApproved ? "1px solid #22c55e" : "1px solid #4b5563",
                      color: isMerged ? "#c084fc" : isApproved ? "#4ade80" : "#e5e7eb",
                      whiteSpace: "nowrap",
                    }}>{isApproved ? "PR ✓" : "PR"}</span>
                  );
                })()}
                    {/* Warning if PR base doesn't match graph parent */}
                    {hasPRBaseMismatch && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 5px",
                          borderRadius: 3,
                          background: "#78350f",
                          border: "1px solid #f59e0b",
                          color: "#fbbf24",
                          whiteSpace: "nowrap",
                          cursor: "help",
                        }}
                        title={`PR targets "${prBaseBranch}" but graph shows parent as "${graphParent}"`}
                      >
                        ⚠
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Line 2: Branch name - allow wrapping */}
            <div
              style={{
                width: "100%",
                fontSize: isTentative ? 11 : 12,
                fontFamily: isTentative ? "sans-serif" : "monospace",
                fontWeight: isDefault ? "bold" : isTentative ? 500 : "normal",
                color: isTentative ? "#c084fc" : isMerged ? "#9ca3af" : "#e5e7eb",
                lineHeight: 1.3,
                wordBreak: "break-all",
                overflow: "hidden",
                textAlign: "left",
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
          )}
        </foreignObject>

        {/* Worktree label on top + active border effect */}
        {hasWorktree && (() => {
          const worktreeName = node.worktree?.path?.split("/").pop() || "worktree";
          const isActive = node.worktree?.isActive;
          const labelWidth = Math.min(worktreeName.length * 7 + 16, nodeWidth);
          return (
            <g>
              {/* Active glow effect */}
              {isActive && (
                <rect
                  x={x - 2}
                  y={y - 2}
                  width={nodeWidth + 4}
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
                fill={isActive ? "#14532d" : "#1e3a5f"}
                stroke={isActive ? "#22c55e" : "#3b82f6"}
                strokeWidth={1.5}
              />
              <text
                x={x + 6}
                y={y - 11}
                textAnchor="start"
                dominantBaseline="middle"
                fontSize={11}
                fill={isActive ? "#4ade80" : "#60a5fa"}
                fontWeight="600"
              >
                {worktreeName.length > 22 ? worktreeName.substring(0, 20) + "…" : worktreeName}
              </text>
            </g>
          );
        })()}


        {/* All badges in a single horizontal row below the node */}
        {(() => {
          const badges: Array<{ label: string; color: string }> = [];
          // Local ahead/behind (vs parent branch)
          if (node.aheadBehind?.ahead && node.aheadBehind.ahead > 0) {
            badges.push({ label: `+${node.aheadBehind.ahead}`, color: "#4caf50" });
          }
          if (node.aheadBehind?.behind && node.aheadBehind.behind > 0) {
            badges.push({ label: `-${node.aheadBehind.behind}`, color: "#f44336" });
          }
          // Remote ahead/behind (vs origin)
          if (node.remoteAheadBehind?.ahead && node.remoteAheadBehind.ahead > 0) {
            badges.push({ label: `↑${node.remoteAheadBehind.ahead}`, color: "#3b82f6" });
          }
          if (node.remoteAheadBehind?.behind && node.remoteAheadBehind.behind > 0) {
            badges.push({ label: `↓${node.remoteAheadBehind.behind}`, color: "#f59e0b" });
          }
          if (badges.length === 0) return null;
          const badgeWidth = 22;
          const badgeGap = 2;
          const startX = x + 4; // Left-aligned
          return (
            <g>
              {badges.map((badge, i) => (
                <g key={i}>
                  <rect
                    x={startX + i * (badgeWidth + badgeGap)}
                    y={y + nodeHeight + 3}
                    width={badgeWidth}
                    height={14}
                    rx={3}
                    fill={badge.color}
                  />
                  <text
                    x={startX + i * (badgeWidth + badgeGap) + badgeWidth / 2}
                    y={y + nodeHeight + 11}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={9}
                    fill="white"
                    fontWeight="bold"
                  >
                    {badge.label}
                  </text>
                </g>
              ))}
            </g>
          );
        })()}

        {/* Add branch button - positioned at bottom right of node (hidden in paint mode) */}
        {onBranchCreate && !isTentative && !isMerged && !paintMode && (
          <g
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              onBranchCreate(id);
            }}
          >
            <rect
              x={x + nodeWidth - 18}
              y={y + nodeHeight - 16}
              width={14}
              height={14}
              rx={3}
              fill="#374151"
              stroke="#6b7280"
              strokeWidth={1}
            />
            <text
              x={x + nodeWidth - 11}
              y={y + nodeHeight - 9}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill="#9ca3af"
              fontWeight="bold"
            >
              +
            </text>
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
    <div className="branch-graph" style={{ width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        className="branch-graph__svg"
        style={{
          width: "100%",
          height: "100%",
          minWidth: width * zoom,
          minHeight: height * zoom,
          cursor: paintModeDragState ? "crosshair" : dragState ? "grabbing" : paintMode ? "crosshair" : undefined,
          userSelect: (dragState || paintModeDragState) ? "none" : undefined,
        }}
        onMouseDown={(e) => {
          // Start range selection in paint mode
          if (paintMode && !paintModeDragState) {
            const coords = getSVGCoords(e);
            setPaintModeDragState({
              startX: coords.x,
              startY: coords.y,
              currentX: coords.x,
              currentY: coords.y,
            });
          }
        }}
      >
        {/* Zoom wrapper */}
        <g transform={`scale(${zoom})`}>
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

          {/* Render paint mode range selection rectangle */}
          {paintModeDragState && (
            <rect
              x={Math.min(paintModeDragState.startX, paintModeDragState.currentX)}
              y={Math.min(paintModeDragState.startY, paintModeDragState.currentY)}
              width={Math.abs(paintModeDragState.currentX - paintModeDragState.startX)}
              height={Math.abs(paintModeDragState.currentY - paintModeDragState.startY)}
              fill={paintMode === "check" ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)"}
              stroke={paintMode === "check" ? "#22c55e" : "#ef4444"}
              strokeWidth={1}
              strokeDasharray="4,4"
              pointerEvents="none"
            />
          )}

          {/* Render nodes */}
          <g className="branch-graph__nodes">
            {layoutNodes.map((node) => renderNode(node))}
          </g>

          {/* Column reorder drag handles - rendered last to be on top */}
          {editMode && !columnDragState && (
            <g className="branch-graph__drag-handles">
              {layoutNodes.map((node) => {
                const { id, x: originalX, y, width: nodeWidth = NODE_WIDTH, isTentative, parentBranch, siblings } = node;
                const isDefault = id === defaultBranch;
                const canReorder = !isTentative && !isDefault && parentBranch && siblings && siblings.length > 1;

                if (!canReorder) return null;

                // Apply separator offset for unfocused branches
                const separatorOffset = isUnfocusedBranch(id) ? SEPARATOR_HALF_WIDTH * 2 : 0;
                const x = originalX + separatorOffset;

                // Calculate original index by sorting siblings by X position
                const siblingPositions = siblings!.map(s => {
                  const sNode = layoutNodes.find(n => n.id === s);
                  return { id: s, x: sNode?.x ?? 0 };
                }).sort((a, b) => a.x - b.x);
                const originalIndex = siblingPositions.findIndex(s => s.id === id);

                return (
                  <g
                    key={`drag-handle-${id}`}
                    style={{ cursor: "grab" }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const coords = getSVGCoords(e);
                      handleColumnDragStart(id, parentBranch!, siblings!, coords.x, x, nodeWidth, originalIndex);
                    }}
                  >
                    <rect
                      x={x + nodeWidth / 2 - 20}
                      y={y - 16}
                      width={40}
                      height={12}
                      rx={3}
                      ry={3}
                      fill="#374151"
                      stroke="#4b5563"
                      strokeWidth={1}
                    />
                    <circle cx={x + nodeWidth / 2 - 8} cy={y - 10} r={2} fill="#9ca3af" />
                    <circle cx={x + nodeWidth / 2} cy={y - 10} r={2} fill="#9ca3af" />
                    <circle cx={x + nodeWidth / 2 + 8} cy={y - 10} r={2} fill="#9ca3af" />
                  </g>
                );
              })}
            </g>
          )}

          {/* Column drag overlay - shows borders around all sibling columns */}
          {/* Also show during separator drag for root siblings */}
          {editMode && (columnDragState || separatorDragState) && (() => {
            // During column drag, use the drag state siblings
            // During separator drag, show root siblings
            const siblings = columnDragState
              ? columnDragState.siblings
              : rootSiblings;
            const draggingBranch = columnDragState?.draggingBranch ?? null;

            // Helper to get all descendants of a branch
            const getDescendants = (branchId: string): string[] => {
              const children = edges.filter(e => e.parent === branchId).map(e => e.child);
              const descendants: string[] = [];
              for (const child of children) {
                descendants.push(child);
                descendants.push(...getDescendants(child));
              }
              return descendants;
            };

            // Get column nodes (branch + all descendants)
            const getColumnNodes = (branchId: string) => {
              const ids = [branchId, ...getDescendants(branchId)];
              return layoutNodes.filter(n => ids.includes(n.id));
            };

            // Get bounding box for a column (with offset applied including separator spacing)
            const getColumnBounds = (branchId: string) => {
              const columnNodes = getColumnNodes(branchId);
              if (columnNodes.length === 0) return null;
              // Include both drag offset and separator spacing
              const dragOffset = columnOffsets.get(branchId) ?? 0;
              const separatorOffset = isUnfocusedBranch(branchId) ? SEPARATOR_HALF_WIDTH * 2 : 0;
              const offset = dragOffset + separatorOffset;
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const node of columnNodes) {
                const w = node.width ?? NODE_WIDTH;
                const h = node.height ?? NODE_HEIGHT;
                minX = Math.min(minX, node.x + offset);
                minY = Math.min(minY, node.y);
                maxX = Math.max(maxX, node.x + offset + w);
                maxY = Math.max(maxY, node.y + h);
              }
              return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            };

            return (
              <g className="branch-graph__column-drag">
                {/* Borders around all sibling columns */}
                {siblings.map((siblingId) => {
                  const bounds = getColumnBounds(siblingId);
                  if (!bounds) return null;
                  const isDragging = siblingId === draggingBranch;

                  return (
                    <rect
                      key={`column-border-${siblingId}`}
                      x={bounds.x - 6}
                      y={bounds.y - 6}
                      width={bounds.width + 12}
                      height={bounds.height + 12}
                      rx={8}
                      ry={8}
                      fill={isDragging ? "rgba(99, 102, 241, 0.15)" : "rgba(75, 85, 99, 0.1)"}
                      stroke={isDragging ? "#818cf8" : "#6b7280"}
                      strokeWidth={isDragging ? 3 : 2}
                      style={{ pointerEvents: "none" }}
                    />
                  );
                })}
              </g>
            );
          })()}

          {/* Focus separator line - always show if there are root siblings */}
          {rootSiblings.length > 0 && (() => {
            let separatorX: number;

            // During separator drag, follow the mouse position
            if (separatorDragState) {
              separatorX = separatorDragState.currentX;
            } else {
              // Calculate separator X position based on effective index
              // During column drag, use static positions (no offsets) so separator stays fixed
              // Separator appears between column at index-1 and index (or at the start if index is 0)
              if (effectiveSeparatorIndex <= 0) {
                // Before first column
                const firstSibling = rootSiblings[0];
                const firstBounds = getColumnBoundsHelper(firstSibling);
                separatorX = (firstBounds?.left ?? LEFT_PADDING) - HORIZONTAL_GAP / 2;
              } else if (effectiveSeparatorIndex >= rootSiblings.length) {
                // After last column - use rightmost edge of last column
                const lastSibling = rootSiblings[rootSiblings.length - 1];
                const lastBounds = getColumnBoundsHelper(lastSibling);
                separatorX = (lastBounds?.right ?? width - 50) + HORIZONTAL_GAP / 2;
              } else {
                // Between two columns - separator is in the middle of the total gap
                // Total gap = HORIZONTAL_GAP + SEPARATOR_HALF_WIDTH * 2
                // Unfocused (right) columns are shifted right by SEPARATOR_HALF_WIDTH * 2
                const leftSibling = rootSiblings[effectiveSeparatorIndex - 1];
                const leftBounds = getColumnBoundsHelper(leftSibling);
                const leftRight = leftBounds?.right ?? 0;
                // Separator is at the center: leftRight + (HORIZONTAL_GAP + separator width) / 2
                separatorX = leftRight + (HORIZONTAL_GAP + SEPARATOR_HALF_WIDTH * 2) / 2;
              }
            }

            return (
              <g className="branch-graph__focus-separator">
                {/* Separator line */}
                <line
                  x1={separatorX}
                  y1={0}
                  x2={separatorX}
                  y2={9999}
                  stroke="#6b7280"
                  strokeWidth={2}
                  strokeDasharray="6,4"
                  opacity={0.6}
                />
                {/* Draggable handle - only in edit mode */}
                {editMode && (
                  <>
                    <rect
                      x={separatorX - 8}
                      y={height / 2 - 30}
                      width={16}
                      height={60}
                      rx={4}
                      fill={separatorDragState ? "#6b7280" : "#4b5563"}
                      stroke="#9ca3af"
                      strokeWidth={separatorDragState ? 2 : 1}
                      style={{ cursor: "ew-resize" }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const coords = getSVGCoords(e);
                        setSeparatorDragState({
                          startX: coords.x,
                          currentX: coords.x,
                          currentIndex: effectiveSeparatorIndex,
                        });
                      }}
                    />
                    {/* Handle grip dots */}
                    <circle cx={separatorX} cy={height / 2 - 12} r={2} fill="#9ca3af" style={{ pointerEvents: "none" }} />
                    <circle cx={separatorX} cy={height / 2} r={2} fill="#9ca3af" style={{ pointerEvents: "none" }} />
                    <circle cx={separatorX} cy={height / 2 + 12} r={2} fill="#9ca3af" style={{ pointerEvents: "none" }} />
                  </>
                )}
              </g>
            );
          })()}
        </g>
      </svg>
    </div>
  );
}
