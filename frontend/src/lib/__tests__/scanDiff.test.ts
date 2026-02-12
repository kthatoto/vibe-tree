import { describe, it, expect } from "vitest";
import { summarize, diff, formatDiffSummary } from "../scanDiff";
import type { ScanSnapshot } from "../api";

// Helper to create a minimal snapshot for testing
function createSnapshot(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  return {
    repoId: "test/repo",
    defaultBranch: "main",
    branches: ["main"],
    nodes: [{ branchName: "main", badges: [], lastCommitAt: "" }],
    edges: [],
    warnings: [],
    worktrees: [],
    rules: { branchNaming: null },
    restart: null,
    ...overrides,
  };
}

describe("summarize", () => {
  it("returns zeros for null snapshot", () => {
    const result = summarize(null);
    expect(result).toEqual({
      branchCount: 0,
      edgeCount: 0,
      warningsCount: 0,
      dirtyWorktreesCount: 0,
    });
  });

  it("correctly summarizes a snapshot", () => {
    const snapshot = createSnapshot({
      branches: ["main", "feature-1", "feature-2"],
      edges: [
        { parent: "main", child: "feature-1", confidence: "high" },
        { parent: "main", child: "feature-2", confidence: "high" },
      ],
      warnings: [
        { code: "TEST", severity: "warning", message: "test", branchName: "main" },
      ],
      worktrees: [
        { path: "/path", branch: "main", commit: "abc", dirty: true },
        { path: "/path2", branch: "feature-1", commit: "def", dirty: false },
      ],
    });

    const result = summarize(snapshot);
    expect(result).toEqual({
      branchCount: 3,
      edgeCount: 2,
      warningsCount: 1,
      dirtyWorktreesCount: 1,
    });
  });
});

describe("diff", () => {
  it("detects new branches", () => {
    const before = createSnapshot({ branches: ["main"] });
    const after = createSnapshot({ branches: ["main", "feature-1", "feature-2"] });

    const result = diff(before, after);
    expect(result.newBranches).toEqual(["feature-1", "feature-2"]);
    expect(result.removedBranches).toEqual([]);
    expect(result.hasChanges).toBe(true);
  });

  it("detects removed branches", () => {
    const before = createSnapshot({ branches: ["main", "feature-1", "feature-2"] });
    const after = createSnapshot({ branches: ["main"] });

    const result = diff(before, after);
    expect(result.newBranches).toEqual([]);
    expect(result.removedBranches).toEqual(["feature-1", "feature-2"]);
    expect(result.hasChanges).toBe(true);
  });

  it("detects reparented edges", () => {
    const before = createSnapshot({
      branches: ["main", "develop", "feature-1"],
      edges: [
        { parent: "main", child: "develop", confidence: "high" },
        { parent: "main", child: "feature-1", confidence: "high" },
      ],
    });
    const after = createSnapshot({
      branches: ["main", "develop", "feature-1"],
      edges: [
        { parent: "main", child: "develop", confidence: "high" },
        { parent: "develop", child: "feature-1", confidence: "high" }, // Reparented
      ],
    });

    const result = diff(before, after);
    expect(result.reparentedEdges).toBe(1);
    expect(result.hasChanges).toBe(true);
  });

  it("detects warning changes", () => {
    const before = createSnapshot({ warnings: [] });
    const after = createSnapshot({
      warnings: [
        { code: "W1", severity: "warning", message: "test", branchName: "main" },
        { code: "W2", severity: "error", message: "test2", branchName: "main" },
      ],
    });

    const result = diff(before, after);
    expect(result.warningsDelta).toBe(2);
    expect(result.hasChanges).toBe(true);
  });

  it("returns hasChanges=false when snapshots are identical", () => {
    const snapshot = createSnapshot({
      branches: ["main", "feature-1"],
      edges: [{ parent: "main", child: "feature-1", confidence: "high" }],
      warnings: [{ code: "W1", severity: "warning", message: "test", branchName: "main" }],
    });

    const result = diff(snapshot, snapshot);
    expect(result.hasChanges).toBe(false);
    expect(result.newBranches).toEqual([]);
    expect(result.removedBranches).toEqual([]);
    expect(result.reparentedEdges).toBe(0);
    expect(result.warningsDelta).toBe(0);
  });

  it("handles null before snapshot", () => {
    const after = createSnapshot({ branches: ["main", "feature-1"] });
    const result = diff(null, after);
    expect(result.newBranches).toEqual(["main", "feature-1"]);
    expect(result.hasChanges).toBe(true);
  });

  it("handles null after snapshot", () => {
    const before = createSnapshot({ branches: ["main", "feature-1"] });
    const result = diff(before, null);
    expect(result.removedBranches).toEqual(["main", "feature-1"]);
    expect(result.hasChanges).toBe(true);
  });
});

describe("formatDiffSummary", () => {
  it("formats new branches", () => {
    const result = formatDiffSummary({
      newBranches: ["a", "b"],
      removedBranches: [],
      reparentedEdges: 0,
      warningsDelta: 0,
      hasChanges: true,
    });
    expect(result).toBe("+2 branches");
  });

  it("formats single new branch", () => {
    const result = formatDiffSummary({
      newBranches: ["a"],
      removedBranches: [],
      reparentedEdges: 0,
      warningsDelta: 0,
      hasChanges: true,
    });
    expect(result).toBe("+1 branch");
  });

  it("formats removed branches", () => {
    const result = formatDiffSummary({
      newBranches: [],
      removedBranches: ["a", "b", "c"],
      reparentedEdges: 0,
      warningsDelta: 0,
      hasChanges: true,
    });
    expect(result).toBe("-3 branches");
  });

  it("formats edge changes", () => {
    const result = formatDiffSummary({
      newBranches: [],
      removedBranches: [],
      reparentedEdges: 2,
      warningsDelta: 0,
      hasChanges: true,
    });
    expect(result).toBe("2 edges changed");
  });

  it("formats warning changes (positive)", () => {
    const result = formatDiffSummary({
      newBranches: [],
      removedBranches: [],
      reparentedEdges: 0,
      warningsDelta: 3,
      hasChanges: true,
    });
    expect(result).toBe("+3 warnings");
  });

  it("formats warning changes (negative)", () => {
    const result = formatDiffSummary({
      newBranches: [],
      removedBranches: [],
      reparentedEdges: 0,
      warningsDelta: -2,
      hasChanges: true,
    });
    expect(result).toBe("-2 warnings");
  });

  it("combines multiple changes", () => {
    const result = formatDiffSummary({
      newBranches: ["a"],
      removedBranches: ["b", "c"],
      reparentedEdges: 1,
      warningsDelta: 2,
      hasChanges: true,
    });
    expect(result).toBe("+1 branch, -2 branches, 1 edge changed, +2 warnings");
  });

  it("returns fallback for no specific changes", () => {
    const result = formatDiffSummary({
      newBranches: [],
      removedBranches: [],
      reparentedEdges: 0,
      warningsDelta: 0,
      hasChanges: true,
    });
    expect(result).toBe("Minor changes detected");
  });
});
