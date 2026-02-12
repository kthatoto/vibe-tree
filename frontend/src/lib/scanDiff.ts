// Scan diff utilities for comparing snapshots
import type { ScanSnapshot, TreeEdge } from "./api";

export interface SnapshotSummary {
  branchCount: number;
  edgeCount: number;
  warningsCount: number;
  dirtyWorktreesCount: number;
}

export interface DiffResult {
  newBranches: string[];
  removedBranches: string[];
  reparentedEdges: number; // edges where parent changed
  warningsDelta: number;
  hasChanges: boolean;
}

/**
 * Create a lightweight summary of a snapshot for quick comparison
 */
export function summarize(snapshot: ScanSnapshot | null): SnapshotSummary {
  if (!snapshot) {
    return { branchCount: 0, edgeCount: 0, warningsCount: 0, dirtyWorktreesCount: 0 };
  }
  return {
    branchCount: snapshot.branches.length,
    edgeCount: snapshot.edges.length,
    warningsCount: snapshot.warnings.length,
    dirtyWorktreesCount: snapshot.worktrees.filter((w) => w.dirty).length,
  };
}

/**
 * Compare two snapshots and return a diff summary
 * Uses O(N) Map/Set comparisons instead of JSON stringify
 */
export function diff(before: ScanSnapshot | null, after: ScanSnapshot | null): DiffResult {
  if (!before || !after) {
    return {
      newBranches: after?.branches ?? [],
      removedBranches: before?.branches ?? [],
      reparentedEdges: 0,
      warningsDelta: (after?.warnings.length ?? 0) - (before?.warnings.length ?? 0),
      hasChanges: true,
    };
  }

  const beforeBranches = new Set(before.branches);
  const afterBranches = new Set(after.branches);

  // Find new and removed branches
  const newBranches = after.branches.filter((b) => !beforeBranches.has(b));
  const removedBranches = before.branches.filter((b) => !afterBranches.has(b));

  // Compare edges using child->parent Map
  const beforeEdgeMap = new Map<string, string>();
  for (const edge of before.edges) {
    beforeEdgeMap.set(edge.child, edge.parent);
  }

  const afterEdgeMap = new Map<string, string>();
  for (const edge of after.edges) {
    afterEdgeMap.set(edge.child, edge.parent);
  }

  // Count reparented edges (edges where parent changed)
  let reparentedEdges = 0;
  for (const [child, afterParent] of afterEdgeMap) {
    const beforeParent = beforeEdgeMap.get(child);
    if (beforeParent !== undefined && beforeParent !== afterParent) {
      reparentedEdges++;
    }
  }

  const warningsDelta = after.warnings.length - before.warnings.length;

  const hasChanges =
    newBranches.length > 0 ||
    removedBranches.length > 0 ||
    reparentedEdges > 0 ||
    warningsDelta !== 0;

  return {
    newBranches,
    removedBranches,
    reparentedEdges,
    warningsDelta,
    hasChanges,
  };
}

/**
 * Format diff result as a short summary string
 */
export function formatDiffSummary(result: DiffResult): string {
  const parts: string[] = [];

  if (result.newBranches.length > 0) {
    parts.push(`+${result.newBranches.length} branch${result.newBranches.length > 1 ? "es" : ""}`);
  }
  if (result.removedBranches.length > 0) {
    parts.push(`-${result.removedBranches.length} branch${result.removedBranches.length > 1 ? "es" : ""}`);
  }
  if (result.reparentedEdges > 0) {
    parts.push(`${result.reparentedEdges} edge${result.reparentedEdges > 1 ? "s" : ""} changed`);
  }
  if (result.warningsDelta !== 0) {
    const sign = result.warningsDelta > 0 ? "+" : "";
    parts.push(`${sign}${result.warningsDelta} warning${Math.abs(result.warningsDelta) > 1 ? "s" : ""}`);
  }

  return parts.length > 0 ? parts.join(", ") : "Minor changes detected";
}
