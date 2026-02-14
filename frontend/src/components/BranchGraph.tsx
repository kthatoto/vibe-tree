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
  // Sibling order for column reordering (parent branchName -> ordered child branchNames)
  siblingOrder?: Record<string, string[]>;
  onSiblingOrderChange?: (siblingOrder: Record<string, string[]>) => void;
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
const TENTATIVE_NODE_HEIGHT = 60;
const HORIZONTAL_GAP = 28;
const VERTICAL_GAP = 50;
const TOP_PADDING = 30;
const LEFT_PADDING = 16;


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
  siblingOrder = {},
  onSiblingOrderChange,
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
  } | null>(null);

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

  // Helper to check if a node should be minimized
  // Checkbox logic is inverted: checked = minimized (hidden), unchecked = visible
  const isMinimized = useCallback((branchName: string) => {
    if (branchName === defaultBranch) return false; // Default branch is never minimized
    return filterEnabled && checkedBranches.has(branchName);
  }, [filterEnabled, checkedBranches, defaultBranch]);

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
    nodeWidth: number
  ) => {
    const nodeCenterX = nodeX + nodeWidth / 2;
    setColumnDragState({
      draggingBranch: branchName,
      parentBranch,
      siblings,
      startX,
      currentX: startX,
      offsetX: startX - nodeCenterX,
    });
  }, []);

  const { layoutNodes, layoutEdges, width, height } = useMemo(() => {
    if (nodes.length === 0 && tentativeNodes.length === 0) {
      return { layoutNodes: [], layoutEdges: [], width: 400, height: 200 };
    }

    // Helper to check if a branch should be minimized (for layout calculation)
    const shouldMinimize = (branchName: string) => {
      if (branchName === defaultBranch) return false;
      return filterEnabled && checkedBranches.has(branchName);
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
      parentBranch?: string,
      siblings?: string[]
    ): number {
      const node = nodes.find((n) => n.branchName === branchName);
      if (!node || nodeMap.has(branchName)) return minCol;

      const children = childrenMap.get(branchName) || [];

      // Left-aligned: use minCol directly
      const col = minCol;

      // Determine node width based on minimized state
      const nodeWidth = shouldMinimize(branchName) ? MINIMIZED_NODE_WIDTH : NODE_WIDTH;

      // Vertical layout: depth controls Y, col controls X (X will be recalculated later)
      const layoutNode: LayoutNode = {
        id: branchName,
        x: 0, // Will be calculated in Phase 2
        y: TOP_PADDING + depth * (NODE_HEIGHT + VERTICAL_GAP),
        width: nodeWidth,
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
        currentCol = layoutSubtree(childName, depth + 1, currentCol, branchName, sortedChildren);
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
      nextCol = layoutSubtree(
        root.branchName,
        0,
        nextCol,
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

        const layoutNode: LayoutNode = {
          id: node.branchName,
          x: 0, // Will be calculated in Phase 2
          y: TOP_PADDING + depth * (NODE_HEIGHT + VERTICAL_GAP),
          width: nodeWidth,
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
      // defaultBranch is positioned at column start (not centered)
      if (n.id === defaultBranch) {
        n.x = colX;
      } else {
        // Center the node within the column
        n.x = colX + (colWidth - n.width) / 2;
      }
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
    const maxX = Math.max(...layoutNodes.map((n) => n.x + n.width), 0) + LEFT_PADDING;
    const maxY = Math.max(
      ...layoutNodes.map((n) => n.y + (n.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT) + BADGE_HEIGHT),
      0
    ) + TOP_PADDING;

    return {
      layoutNodes,
      layoutEdges,
      width: Math.max(400, maxX),
      height: Math.max(150, maxY),
    };
  }, [nodes, edges, defaultBranch, tentativeNodes, tentativeEdges, tentativeBaseBranch, checkedBranches, filterEnabled, siblingOrder]);

  // Handle column drag movement and drop (must be after layoutNodes is defined)
  useEffect(() => {
    if (!columnDragState) return;

    // Disable text selection during drag
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      const coords = getSVGCoords(e);
      setColumnDragState(prev => prev ? { ...prev, currentX: coords.x } : null);
    };

    const handleMouseUp = () => {
      if (columnDragState && onSiblingOrderChange) {
        // Find all sibling layout nodes and their X positions
        const siblingPositions = columnDragState.siblings.map(sibling => {
          const node = layoutNodes.find(n => n.id === sibling);
          return { branchName: sibling, x: node?.x ?? 0 };
        });

        // Sort by X position to get new order
        siblingPositions.sort((a, b) => a.x - b.x);

        // Calculate new position based on drag position
        let newIndex = 0;
        for (let i = 0; i < siblingPositions.length; i++) {
          if (siblingPositions[i].branchName === columnDragState.draggingBranch) continue;
          const midX = siblingPositions[i].x + (NODE_WIDTH / 2);
          if (columnDragState.currentX > midX) {
            newIndex = i + 1;
          }
        }

        // Remove dragged item and insert at new position
        const reordered = columnDragState.siblings.filter(
          s => s !== columnDragState.draggingBranch
        );
        reordered.splice(Math.min(newIndex, reordered.length), 0, columnDragState.draggingBranch);

        // Only update if order changed
        if (JSON.stringify(reordered) !== JSON.stringify(columnDragState.siblings)) {
          const newSiblingOrder = { ...siblingOrder };
          newSiblingOrder[columnDragState.parentBranch] = reordered;
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
  }, [columnDragState, getSVGCoords, layoutNodes, onSiblingOrderChange, siblingOrder]);

  const renderEdge = (edge: LayoutEdge, index: number) => {
    // Vertical edge: from bottom of parent to top of child
    const fromHeight = edge.from.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;
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

  // Helper to check if a node belongs to a specific sibling's column
  const getColumnRoot = useCallback((nodeId: string): string | null => {
    if (!columnDragState) return null;
    const { siblings } = columnDragState;

    // If this node is a sibling root, return it
    if (siblings.includes(nodeId)) return nodeId;

    // Check ancestors to find which sibling column this belongs to
    const getAncestors = (id: string): string[] => {
      const parent = edges.find(e => e.child === id)?.parent;
      if (!parent) return [];
      return [parent, ...getAncestors(parent)];
    };
    const ancestors = getAncestors(nodeId);
    return siblings.find(s => ancestors.includes(s)) ?? null;
  }, [columnDragState, edges]);

  // Helper to check if a node is in the dragging column
  const isInDraggingColumn = useCallback((nodeId: string): boolean => {
    if (!columnDragState) return false;
    return getColumnRoot(nodeId) === columnDragState.draggingBranch;
  }, [columnDragState, getColumnRoot]);

  // Calculate column offsets for swapping animation
  const columnOffsets = useMemo(() => {
    if (!columnDragState) return new Map<string, number>();

    const { draggingBranch, siblings, currentX, offsetX } = columnDragState;

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

    // Get column bounds (including all descendants)
    const getColumnBounds = (branchId: string) => {
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
    };

    // Get column bounds for all siblings, sorted by left edge
    const siblingBounds = siblings.map(s => {
      const bounds = getColumnBounds(s);
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
    const draggingOriginalCenterX = draggingInfo?.centerX ?? 0;
    const draggingWidth = draggingInfo?.width ?? NODE_WIDTH;

    // Original index of dragging column
    const originalIndex = siblingBounds.findIndex(s => s.id === draggingBranch);

    // Iteratively find insert position - boundaries update after each swap
    let insertIndex = originalIndex;
    let iterations = 0;
    const maxIterations = siblingBounds.length; // Prevent infinite loop

    while (iterations < maxIterations) {
      iterations++;

      // Build current order with dragging item at insertIndex
      const currentOrder = siblingBounds.filter(s => s.id !== draggingBranch);
      currentOrder.splice(insertIndex, 0, draggingInfo!);

      // Calculate positions in current order (layout from left to right)
      let currentX_layout = siblingBounds[0].left; // Start from leftmost original position
      const positions: { id: string; left: number; right: number; centerX: number }[] = [];

      for (const col of currentOrder) {
        const left = currentX_layout;
        const right = left + col.width;
        positions.push({ id: col.id, left, right, centerX: (left + right) / 2 });
        currentX_layout = right + HORIZONTAL_GAP;
      }

      // Calculate boundaries based on current positions
      const boundaries: number[] = [];
      for (let i = 0; i < positions.length - 1; i++) {
        boundaries.push((positions[i].right + positions[i + 1].left) / 2);
      }

      // Check if drag position crosses any boundary
      let newInsertIndex = insertIndex;
      const draggingPos = positions.find(p => p.id === draggingBranch);

      if (insertIndex > 0 && dragCenterX < boundaries[insertIndex - 1]) {
        // Move left
        newInsertIndex = insertIndex - 1;
      } else if (insertIndex < boundaries.length && dragCenterX > boundaries[insertIndex]) {
        // Move right
        newInsertIndex = insertIndex + 1;
      }

      if (newInsertIndex === insertIndex) {
        // No more swaps needed
        break;
      }
      insertIndex = newInsertIndex;
    }

    // Calculate final offsets based on insertIndex
    const offsets = new Map<string, number>();
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

    return offsets;
  }, [columnDragState, layoutNodes, edges]);

  // Get offset for a specific node based on its column
  const getNodeOffset = useCallback((nodeId: string): number => {
    const columnRoot = getColumnRoot(nodeId);
    if (!columnRoot) return 0;
    return columnOffsets.get(columnRoot) ?? 0;
  }, [getColumnRoot, columnOffsets]);

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
    // Height stays the same even when minimized (only width changes)
    const nodeHeight = isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;
    const isChecked = checkedBranches.has(id);

    // Get description label (first word/token before whitespace)
    const fullDescription = branchDescriptions.get(id);
    const descriptionLabel = fullDescription?.split(/\s+/)[0] || null;

    // In edit mode, the whole node is draggable (line starts from top edge of node for vertical layout)
    const handleNodeMouseDown = canDrag ? (e: React.MouseEvent) => {
      e.stopPropagation();
      handleDragStart(id, x + nodeWidth / 2, y);
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
          width={nodeWidth}
          height={nodeHeight}
          rx={6}
          ry={6}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isSelected || isDropTarget ? 2 : 1.5}
          strokeDasharray={strokeDash}
          onClick={() => !isTentative && !dragState && onSelectBranch(id)}
        />

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
                justifyContent: "flex-start",
                gap: 4,
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
              {/* Row 2: R + CI + PR badges (no wrap, may overflow) */}
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
                {/* CI badge */}
                {prLink?.checksStatus && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: prLink.checksStatus === "success" ? "#14532d" : prLink.checksStatus === "failure" ? "#7f1d1d" : "#78350f",
                    border: `1px solid ${prLink.checksStatus === "success" ? "#22c55e" : prLink.checksStatus === "failure" ? "#ef4444" : "#f59e0b"}`,
                    color: prLink.checksStatus === "success" ? "#4ade80" : prLink.checksStatus === "failure" ? "#f87171" : "#fbbf24",
                    whiteSpace: "nowrap",
                  }}>{prLink.checksStatus === "success" ? "CI✔" : prLink.checksStatus === "failure" ? "CI✗" : "CI"}</span>
                )}
                {/* PR badge */}
                {hasPR && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: isMerged ? "#3b0764" : "#374151",
                    border: isMerged ? "1px solid #9333ea" : "1px solid #4b5563",
                    color: isMerged ? "#c084fc" : "#e5e7eb",
                    whiteSpace: "nowrap",
                  }}>PR</span>
                )}
              </div>
              {/* Row 3: Branch name (single line, no ellipsis) */}
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
            {/* Line 1: Description label (left) + Status labels (right) */}
            {(descriptionLabel || hasPR) && (
              <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", justifyContent: "space-between", alignItems: "center" }}>
                {/* Description label - left */}
                {descriptionLabel ? (
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
                ) : <span />}
                {/* PR status badges - right */}
                {hasPR && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "nowrap" }}>
                {/* Review status - based on reviewDecision from branchLinks (only show if human reviewers exist) */}
                {prLink?.reviewDecision === "APPROVED" && prLink?.reviewers && (() => {
                  const reviewers = JSON.parse(prLink.reviewers) as string[];
                  return reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]")).length > 0;
                })() && (
                  <span style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "#14532d",
                    border: "1px solid #22c55e",
                    color: "#4ade80",
                    whiteSpace: "nowrap",
                  }}>Approved ✔</span>
                )}
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
                {/* CI status */}
                {prLink?.checksStatus === "success" && (
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
                {prLink?.checksStatus === "failure" && (
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
                {prLink?.checksStatus === "pending" && (
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
                {/* PR indicator - with background */}
                <span style={{
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: isMerged ? "#3b0764" : "#374151",
                  border: isMerged ? "1px solid #9333ea" : "1px solid #4b5563",
                  color: isMerged ? "#c084fc" : "#e5e7eb",
                  whiteSpace: "nowrap",
                }}>PR</span>
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

        {/* Add branch button - positioned at bottom right of node */}
        {onBranchCreate && !isTentative && !isMerged && (
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
          cursor: dragState ? "grabbing" : undefined,
          userSelect: dragState ? "none" : undefined,
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

          {/* Render nodes */}
          <g className="branch-graph__nodes">
            {layoutNodes.map((node) => renderNode(node))}
          </g>

          {/* Column reorder drag handles - rendered last to be on top */}
          {editMode && !columnDragState && (
            <g className="branch-graph__drag-handles">
              {layoutNodes.map((node) => {
                const { id, x, y, width: nodeWidth = NODE_WIDTH, isTentative, parentBranch, siblings } = node;
                const isDefault = id === defaultBranch;
                const canReorder = !isTentative && !isDefault && parentBranch && siblings && siblings.length > 1;

                if (!canReorder) return null;

                return (
                  <g
                    key={`drag-handle-${id}`}
                    style={{ cursor: "grab" }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const coords = getSVGCoords(e);
                      handleColumnDragStart(id, parentBranch!, siblings!, coords.x, x, nodeWidth);
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
          {editMode && columnDragState && (() => {
            const { draggingBranch, siblings } = columnDragState;

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

            // Get bounding box for a column (with offset applied)
            const getColumnBounds = (branchId: string) => {
              const columnNodes = getColumnNodes(branchId);
              if (columnNodes.length === 0) return null;
              const offset = columnOffsets.get(branchId) ?? 0;
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const node of columnNodes) {
                const w = node.width ?? NODE_WIDTH;
                const h = node.isTentative ? TENTATIVE_NODE_HEIGHT : NODE_HEIGHT;
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
        </g>
      </svg>
    </div>
  );
}
