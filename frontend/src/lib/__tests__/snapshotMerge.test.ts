import { describe, it, expect } from "vitest";
import {
  mergeNodeAttributes,
  createInferredEdgesForNewBranches,
  analyzeChanges,
  formatPendingChangesSummary,
} from "../snapshotMerge";
import type { ScanSnapshot, TreeNode, TreeEdge } from "../api";

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

describe("mergeNodeAttributes", () => {
  it("merges safe attributes from incoming nodes", () => {
    const current = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "", aheadBehind: { ahead: 0, behind: 0 } },
        { branchName: "feature", badges: [], lastCommitAt: "", aheadBehind: { ahead: 0, behind: 0 } },
      ],
    });

    const incoming = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "2024-01-01", aheadBehind: { ahead: 1, behind: 2 } },
        { branchName: "feature", badges: [], lastCommitAt: "2024-01-02", aheadBehind: { ahead: 3, behind: 0 } },
      ],
    });

    const merged = mergeNodeAttributes(current, incoming);

    expect(merged.nodes[0].aheadBehind).toEqual({ ahead: 1, behind: 2 });
    expect(merged.nodes[0].lastCommitAt).toBe("2024-01-01");
    expect(merged.nodes[1].aheadBehind).toEqual({ ahead: 3, behind: 0 });
  });

  it("preserves current edges (does not merge)", () => {
    const current = createSnapshot({
      edges: [{ parent: "main", child: "feature", confidence: "high" }],
    });

    const incoming = createSnapshot({
      edges: [{ parent: "develop", child: "feature", confidence: "high" }],
    });

    const merged = mergeNodeAttributes(current, incoming);

    expect(merged.edges).toEqual(current.edges);
  });

  it("adds new nodes from incoming", () => {
    const current = createSnapshot({
      nodes: [{ branchName: "main", badges: [], lastCommitAt: "" }],
    });

    const incoming = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "" },
        { branchName: "new-branch", badges: [], lastCommitAt: "2024-01-01" },
      ],
    });

    const merged = mergeNodeAttributes(current, incoming);

    expect(merged.nodes.length).toBe(2);
    expect(merged.nodes[1].branchName).toBe("new-branch");
  });

  it("does not delete nodes that are missing in incoming", () => {
    const current = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "" },
        { branchName: "old-branch", badges: [], lastCommitAt: "" },
      ],
    });

    const incoming = createSnapshot({
      nodes: [{ branchName: "main", badges: [], lastCommitAt: "" }],
    });

    const merged = mergeNodeAttributes(current, incoming);

    expect(merged.nodes.length).toBe(2);
    expect(merged.nodes[1].branchName).toBe("old-branch");
  });
});

describe("createInferredEdgesForNewBranches", () => {
  it("creates inferred edges for new branches", () => {
    const currentEdges: TreeEdge[] = [
      { parent: "main", child: "feature-1", confidence: "high" },
    ];

    const result = createInferredEdgesForNewBranches(
      currentEdges,
      ["feature-2", "feature-3"],
      [],
      "main"
    );

    expect(result.length).toBe(3);
    expect(result[1]).toEqual({
      parent: "main",
      child: "feature-2",
      confidence: "unknown",
      isInferred: true,
    });
    expect(result[2]).toEqual({
      parent: "main",
      child: "feature-3",
      confidence: "unknown",
      isInferred: true,
    });
  });

  it("uses parent from incoming edges if available", () => {
    const currentEdges: TreeEdge[] = [];
    const incomingEdges: TreeEdge[] = [
      { parent: "develop", child: "feature-1", confidence: "high" },
    ];

    const result = createInferredEdgesForNewBranches(
      currentEdges,
      ["feature-1"],
      incomingEdges,
      "main"
    );

    expect(result[0].parent).toBe("develop");
    expect(result[0].isInferred).toBe(true);
  });

  it("skips default branch", () => {
    const result = createInferredEdgesForNewBranches(
      [],
      ["main"],
      [],
      "main"
    );

    expect(result.length).toBe(0);
  });
});

describe("analyzeChanges", () => {
  it("detects safe changes (node attribute updates)", () => {
    const current = createSnapshot({
      nodes: [{ branchName: "main", badges: [], lastCommitAt: "", aheadBehind: { ahead: 0, behind: 0 } }],
    });

    const incoming = createSnapshot({
      nodes: [{ branchName: "main", badges: [], lastCommitAt: "", aheadBehind: { ahead: 1, behind: 0 } }],
    });

    const analysis = analyzeChanges(current, incoming, 1);

    expect(analysis.hasSafeChanges).toBe(true);
    expect(analysis.hasUnsafeChanges).toBe(false);
    expect(analysis.pendingChanges).toBeNull();
  });

  it("detects unsafe changes (edge modifications)", () => {
    const current = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "" },
        { branchName: "feature", badges: [], lastCommitAt: "" },
      ],
      branches: ["main", "feature"],
      edges: [{ parent: "main", child: "feature", confidence: "high" }],
    });

    const incoming = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "" },
        { branchName: "feature", badges: [], lastCommitAt: "" },
      ],
      branches: ["main", "feature"],
      edges: [{ parent: "develop", child: "feature", confidence: "high" }],
    });

    const analysis = analyzeChanges(current, incoming, 1);

    expect(analysis.hasUnsafeChanges).toBe(true);
    expect(analysis.pendingChanges?.edgesChanged).toBe(true);
  });

  it("detects deleted nodes as unsafe", () => {
    const current = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "" },
        { branchName: "to-delete", badges: [], lastCommitAt: "" },
      ],
      branches: ["main", "to-delete"],
    });

    const incoming = createSnapshot({
      nodes: [{ branchName: "main", badges: [], lastCommitAt: "" }],
      branches: ["main"],
    });

    const analysis = analyzeChanges(current, incoming, 1);

    expect(analysis.hasUnsafeChanges).toBe(true);
    expect(analysis.pendingChanges?.nodesDeleted).toContain("to-delete");
  });

  it("detects new branches as safe", () => {
    const current = createSnapshot({
      nodes: [{ branchName: "main", badges: [], lastCommitAt: "" }],
      branches: ["main"],
    });

    const incoming = createSnapshot({
      nodes: [
        { branchName: "main", badges: [], lastCommitAt: "" },
        { branchName: "new-branch", badges: [], lastCommitAt: "" },
      ],
      branches: ["main", "new-branch"],
    });

    const analysis = analyzeChanges(current, incoming, 1);

    expect(analysis.hasSafeChanges).toBe(true);
    // New branches are safe but tracked in pendingChanges for edge creation
  });
});

describe("formatPendingChangesSummary", () => {
  it("formats edge changes", () => {
    const summary = formatPendingChangesSummary({
      edgesChanged: true,
      nodesDeleted: [],
      designedEdgesChanged: false,
      newBranches: [],
      version: 1,
      snapshot: createSnapshot(),
    });

    expect(summary).toBe("edge changes");
  });

  it("formats node deletions", () => {
    const summary = formatPendingChangesSummary({
      edgesChanged: false,
      nodesDeleted: ["branch1", "branch2"],
      designedEdgesChanged: false,
      newBranches: [],
      version: 1,
      snapshot: createSnapshot(),
    });

    expect(summary).toBe("2 branches deleted");
  });

  it("combines multiple changes", () => {
    const summary = formatPendingChangesSummary({
      edgesChanged: true,
      nodesDeleted: ["branch1"],
      designedEdgesChanged: true,
      newBranches: [],
      version: 1,
      snapshot: createSnapshot(),
    });

    expect(summary).toBe("edge changes, 1 branch deleted, designed edges changed");
  });
});
