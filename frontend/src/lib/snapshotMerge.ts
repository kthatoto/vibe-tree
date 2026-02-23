/**
 * Snapshot merge utilities for smart updates
 *
 * Design principle:
 * - Safe (auto-merge): Node attributes that don't affect layout
 * - Unsafe (pending): Graph structure changes (edges, node deletion)
 */

import type { ScanSnapshot, TreeNode, TreeEdge } from "./api";

/**
 * Fields that are safe to auto-merge (don't affect graph layout)
 */
const SAFE_NODE_FIELDS = [
  "aheadBehind",
  "remoteAheadBehind",
  "worktree",
  "pr",
  "lastCommitAt",
  "badges",
  "description",
] as const;

/**
 * Pending changes that require user confirmation
 */
export interface PendingChanges {
  edgesChanged: boolean;
  nodesDeleted: string[]; // branch names of deleted nodes
  designedEdgesChanged: boolean;
  newBranches: string[]; // branch names of new branches
  version: number;
  snapshot: ScanSnapshot; // full snapshot for Apply
}

/**
 * Result of analyzing differences between snapshots
 */
export interface DiffAnalysis {
  hasSafeChanges: boolean;
  hasUnsafeChanges: boolean;
  pendingChanges: PendingChanges | null;
}

/**
 * Merge only safe node attributes from incoming snapshot
 * Preserves current edges and node order
 *
 * @param current - Current displayed snapshot
 * @param incoming - New snapshot from scan
 * @returns Merged snapshot with safe updates applied
 */
export function mergeNodeAttributes(
  current: ScanSnapshot,
  incoming: ScanSnapshot
): ScanSnapshot {
  // Build lookup map for incoming nodes: O(n)
  const incomingMap = new Map<string, TreeNode>();
  for (const node of incoming.nodes) {
    incomingMap.set(node.branchName, node);
  }

  // Merge safe fields into current nodes: O(n)
  const mergedNodes = current.nodes.map((currentNode) => {
    const incomingNode = incomingMap.get(currentNode.branchName);
    if (!incomingNode) {
      // Node exists in current but not in incoming - keep as is (deletion is unsafe)
      return currentNode;
    }

    // Merge only safe fields
    return {
      ...currentNode,
      aheadBehind: incomingNode.aheadBehind,
      remoteAheadBehind: incomingNode.remoteAheadBehind,
      worktree: incomingNode.worktree,
      pr: incomingNode.pr,
      lastCommitAt: incomingNode.lastCommitAt,
      badges: incomingNode.badges,
      description: incomingNode.description ?? currentNode.description,
    };
  });

  // Find new branches (exist in incoming but not in current)
  const currentBranches = new Set(current.nodes.map((n) => n.branchName));
  const newNodes: TreeNode[] = [];
  for (const incomingNode of incoming.nodes) {
    if (!currentBranches.has(incomingNode.branchName)) {
      newNodes.push(incomingNode);
    }
  }

  // Add new nodes at the end (with inferred edges - handled separately)
  const finalNodes = [...mergedNodes, ...newNodes];

  return {
    ...current,
    nodes: finalNodes,
    // Keep current edges - edge changes are unsafe
    edges: current.edges,
    // Explicitly keep treeSpec from current (preserves user edits)
    treeSpec: current.treeSpec,
    // Update other safe fields
    warnings: incoming.warnings,
    worktrees: incoming.worktrees,
    // Keep rules and restart from incoming
    rules: incoming.rules,
    restart: incoming.restart,
  };
}

/**
 * Create inferred edges for new branches
 * New branches get connected to defaultBranch with low confidence
 */
export function createInferredEdgesForNewBranches(
  currentEdges: TreeEdge[],
  newBranches: string[],
  incomingEdges: TreeEdge[],
  defaultBranch: string
): TreeEdge[] {
  const result = [...currentEdges];
  const existingChildren = new Set(currentEdges.map((e) => e.child));

  for (const branchName of newBranches) {
    if (existingChildren.has(branchName)) continue;
    if (branchName === defaultBranch) continue;

    // Check if incoming has an edge for this branch
    const incomingEdge = incomingEdges.find((e) => e.child === branchName);

    result.push({
      parent: incomingEdge?.parent ?? defaultBranch,
      child: branchName,
      confidence: "unknown" as const,
      isInferred: true,
    });
  }

  return result;
}

/**
 * Analyze differences between current and incoming snapshots
 * Determines what's safe to auto-merge vs what needs user confirmation
 */
export function analyzeChanges(
  current: ScanSnapshot,
  incoming: ScanSnapshot,
  version: number
): DiffAnalysis {
  const currentBranches = new Set(current.nodes.map((n) => n.branchName));
  const incomingBranches = new Set(incoming.nodes.map((n) => n.branchName));

  // Detect deleted nodes
  const nodesDeleted: string[] = [];
  for (const branch of currentBranches) {
    if (!incomingBranches.has(branch)) {
      nodesDeleted.push(branch);
    }
  }

  // Detect new branches
  const newBranches: string[] = [];
  for (const branch of incomingBranches) {
    if (!currentBranches.has(branch)) {
      newBranches.push(branch);
    }
  }

  // Detect edge changes (comparing child->parent mappings)
  const currentEdgeMap = new Map<string, string>();
  for (const edge of current.edges) {
    currentEdgeMap.set(edge.child, edge.parent);
  }

  const incomingEdgeMap = new Map<string, string>();
  for (const edge of incoming.edges) {
    incomingEdgeMap.set(edge.child, edge.parent);
  }

  let edgesChanged = false;
  // Check for changed or removed edges (only for existing branches)
  for (const [child, parent] of currentEdgeMap) {
    if (incomingBranches.has(child)) {
      const incomingParent = incomingEdgeMap.get(child);
      if (incomingParent !== parent) {
        edgesChanged = true;
        break;
      }
    }
  }

  // Check for new edges on existing branches
  if (!edgesChanged) {
    for (const [child, parent] of incomingEdgeMap) {
      if (currentBranches.has(child) && !currentEdgeMap.has(child)) {
        edgesChanged = true;
        break;
      }
    }
  }

  // Detect designed edge changes
  const currentDesigned = current.edges.filter((e) => e.isDesigned);
  const incomingDesigned = incoming.edges.filter((e) => e.isDesigned);
  let designedEdgesChanged = currentDesigned.length !== incomingDesigned.length;

  if (!designedEdgesChanged) {
    const currentDesignedMap = new Map(currentDesigned.map((e) => [e.child, e.parent]));
    for (const edge of incomingDesigned) {
      if (currentDesignedMap.get(edge.child) !== edge.parent) {
        designedEdgesChanged = true;
        break;
      }
    }
  }

  // Check for safe changes (node attribute updates)
  let hasSafeChanges = false;
  for (const incomingNode of incoming.nodes) {
    const currentNode = current.nodes.find((n) => n.branchName === incomingNode.branchName);
    if (currentNode) {
      // Check if any safe field changed
      if (
        JSON.stringify(currentNode.aheadBehind) !== JSON.stringify(incomingNode.aheadBehind) ||
        JSON.stringify(currentNode.remoteAheadBehind) !== JSON.stringify(incomingNode.remoteAheadBehind) ||
        JSON.stringify(currentNode.worktree) !== JSON.stringify(incomingNode.worktree) ||
        JSON.stringify(currentNode.pr) !== JSON.stringify(incomingNode.pr)
      ) {
        hasSafeChanges = true;
        break;
      }
    }
  }

  // New branches are also considered "safe" for node addition
  if (newBranches.length > 0) {
    hasSafeChanges = true;
  }

  const hasUnsafeChanges = edgesChanged || nodesDeleted.length > 0 || designedEdgesChanged;

  return {
    hasSafeChanges,
    hasUnsafeChanges,
    pendingChanges: hasUnsafeChanges
      ? {
          edgesChanged,
          nodesDeleted,
          designedEdgesChanged,
          newBranches,
          version,
          snapshot: incoming,
        }
      : null,
  };
}

/**
 * Format pending changes as a human-readable summary
 */
export function formatPendingChangesSummary(pending: PendingChanges): string {
  const parts: string[] = [];

  if (pending.edgesChanged) {
    parts.push("edge changes");
  }
  if (pending.nodesDeleted.length > 0) {
    parts.push(`${pending.nodesDeleted.length} branch${pending.nodesDeleted.length > 1 ? "es" : ""} deleted`);
  }
  if (pending.designedEdgesChanged) {
    parts.push("designed edges changed");
  }

  return parts.length > 0 ? parts.join(", ") : "structure changes";
}

/**
 * Timestamps for node fields that can be updated independently
 */
export interface NodeFieldTimestamps {
  aheadBehind?: number;
  remoteAheadBehind?: number;
  worktree?: number;
}

/**
 * Merge node attributes with timestamp-based conflict resolution.
 * Fields updated after scanStartTime are preserved (not overwritten by scan results).
 *
 * @param current - Current displayed snapshot
 * @param incoming - New snapshot from scan
 * @param fieldTimestamps - Map of branchName -> field timestamps
 * @param scanStartTime - When the current scan started (null = no protection)
 * @returns Merged snapshot with newer local updates preserved
 */
export function mergeNodeAttributesWithTimestamps(
  current: ScanSnapshot,
  incoming: ScanSnapshot,
  fieldTimestamps: Map<string, NodeFieldTimestamps>,
  scanStartTime: number | null
): ScanSnapshot {
  // Build lookup map for incoming nodes
  const incomingMap = new Map<string, TreeNode>();
  for (const node of incoming.nodes) {
    incomingMap.set(node.branchName, node);
  }

  // Merge with timestamp-based protection
  const mergedNodes = current.nodes.map((currentNode) => {
    const incomingNode = incomingMap.get(currentNode.branchName);
    if (!incomingNode) {
      return currentNode;
    }

    const timestamps = fieldTimestamps.get(currentNode.branchName);

    // Check if local update is newer than scan start
    const keepAheadBehind =
      scanStartTime &&
      timestamps?.aheadBehind &&
      timestamps.aheadBehind > scanStartTime;

    const keepRemoteAheadBehind =
      scanStartTime &&
      timestamps?.remoteAheadBehind &&
      timestamps.remoteAheadBehind > scanStartTime;

    const keepWorktree =
      scanStartTime &&
      timestamps?.worktree &&
      timestamps.worktree > scanStartTime;

    return {
      ...currentNode,
      // Protected fields: keep current if updated after scan start
      aheadBehind: keepAheadBehind
        ? currentNode.aheadBehind
        : incomingNode.aheadBehind,
      remoteAheadBehind: keepRemoteAheadBehind
        ? currentNode.remoteAheadBehind
        : incomingNode.remoteAheadBehind,
      worktree: keepWorktree
        ? currentNode.worktree
        : incomingNode.worktree,
      // Non-protected fields: always use incoming
      pr: incomingNode.pr,
      lastCommitAt: incomingNode.lastCommitAt,
      badges: incomingNode.badges,
      description: incomingNode.description ?? currentNode.description,
    };
  });

  // Find new branches
  const currentBranches = new Set(current.nodes.map((n) => n.branchName));
  const newNodes: TreeNode[] = [];
  for (const incomingNode of incoming.nodes) {
    if (!currentBranches.has(incomingNode.branchName)) {
      newNodes.push(incomingNode);
    }
  }

  const finalNodes = [...mergedNodes, ...newNodes];

  return {
    ...current,
    nodes: finalNodes,
    edges: current.edges,
    warnings: incoming.warnings,
    worktrees: incoming.worktrees,
    rules: incoming.rules,
    restart: incoming.restart,
    treeSpec: current.treeSpec,
  };
}
