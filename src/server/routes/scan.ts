import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, notInArray, inArray } from "drizzle-orm";
import { existsSync } from "fs";
import { broadcast } from "../ws";
import { expandTilde, getRepoId, execAsync } from "../utils";
import {
  scanSchema,
  restartPromptQuerySchema,
  validateOrThrow,
} from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";
import type { BranchNamingRule, ScanSnapshot, TreeSpec } from "../../shared/types";
import {
  getDefaultBranch,
  getBranches,
  getWorktrees,
  getPRs,
  buildTree,
  calculateAheadBehind,
  calculateRemoteAheadBehind,
  calculateWarnings,
  generateRestartInfo,
} from "../lib/git-helpers";

export const scanRouter = new Hono();

// GET /api/scan/snapshot/:pinId - Return cached data from DB immediately (no git commands)
scanRouter.get("/snapshot/:pinId", async (c) => {
  const pinId = parseInt(c.req.param("pinId"), 10);
  if (isNaN(pinId)) {
    throw new BadRequestError("Invalid pinId");
  }

  const [repoPin] = await db.select().from(schema.repoPins).where(eq(schema.repoPins.id, pinId));
  if (!repoPin) {
    throw new BadRequestError("Pin not found");
  }

  const repoId = repoPin.repoId;
  const savedBaseBranch = repoPin.baseBranch ?? "main";

  // SSOT: If cachedSnapshotJson exists, use it as the primary source (fast path)
  if (repoPin.cachedSnapshotJson) {
    try {
      const cachedSnapshot = JSON.parse(repoPin.cachedSnapshotJson) as ScanSnapshot;

      // Overlay designed edges from treeSpec and planningSessions
      const [treeSpecs, confirmedSessions] = await Promise.all([
        db.select().from(schema.treeSpecs).where(eq(schema.treeSpecs.repoId, repoId)),
        db.select().from(schema.planningSessions).where(
          and(
            eq(schema.planningSessions.repoId, repoId),
            eq(schema.planningSessions.status, "confirmed")
          )
        ),
      ]);

      const branchSet = new Set(cachedSnapshot.branches);

      // Merge planning session edges
      for (const session of confirmedSessions) {
        const sessionNodes = JSON.parse(session.nodesJson) as Array<{ id: string; branchName?: string }>;
        const sessionEdges = JSON.parse(session.edgesJson) as Array<{ parent: string; child: string }>;
        const taskToBranch = new Map<string, string>();
        for (const node of sessionNodes) {
          if (node.branchName) taskToBranch.set(node.id, node.branchName);
        }
        const effectiveBaseBranch = branchSet.has(session.baseBranch) ? session.baseBranch : cachedSnapshot.defaultBranch;
        for (const edge of sessionEdges) {
          let parentBranch = taskToBranch.get(edge.parent) ?? edge.parent;
          const childBranch = taskToBranch.get(edge.child) ?? edge.child;
          if (!branchSet.has(parentBranch)) parentBranch = effectiveBaseBranch;
          if (parentBranch && childBranch && branchSet.has(childBranch)) {
            const idx = cachedSnapshot.edges.findIndex((e) => e.child === childBranch);
            if (idx >= 0) cachedSnapshot.edges[idx] = { parent: parentBranch, child: childBranch, confidence: "high", isDesigned: true };
            else cachedSnapshot.edges.push({ parent: parentBranch, child: childBranch, confidence: "high", isDesigned: true });
          }
        }
        const childTaskIds = new Set(sessionEdges.map((e) => e.child));
        for (const node of sessionNodes) {
          if (node.branchName && !childTaskIds.has(node.id) && branchSet.has(node.branchName)) {
            const idx = cachedSnapshot.edges.findIndex((e) => e.child === node.branchName);
            if (idx >= 0) cachedSnapshot.edges[idx] = { parent: effectiveBaseBranch, child: node.branchName, confidence: "high", isDesigned: true };
            else cachedSnapshot.edges.push({ parent: effectiveBaseBranch, child: node.branchName, confidence: "high", isDesigned: true });
          }
        }
      }

      // Merge treeSpec edges
      if (treeSpecs[0]) {
        const treeSpec = {
          id: treeSpecs[0].id,
          repoId: treeSpecs[0].repoId,
          baseBranch: treeSpecs[0].baseBranch ?? savedBaseBranch,
          status: (treeSpecs[0].status ?? "draft") as TreeSpec["status"],
          specJson: JSON.parse(treeSpecs[0].specJson),
          createdAt: treeSpecs[0].createdAt,
          updatedAt: treeSpecs[0].updatedAt,
        };
        cachedSnapshot.treeSpec = treeSpec;

        for (const designedEdge of treeSpec.specJson.edges as Array<{ parent: string; child: string }>) {
          const parentBranch = branchSet.has(designedEdge.parent) ? designedEdge.parent : cachedSnapshot.defaultBranch;
          if (branchSet.has(designedEdge.child)) {
            const idx = cachedSnapshot.edges.findIndex((e) => e.child === designedEdge.child);
            if (idx >= 0) cachedSnapshot.edges[idx] = { parent: parentBranch, child: designedEdge.child, confidence: "high", isDesigned: true };
            else cachedSnapshot.edges.push({ parent: parentBranch, child: designedEdge.child, confidence: "high", isDesigned: true });
          }
        }
      }

      // Return snapshot with version metadata
      return c.json({
        snapshot: cachedSnapshot,
        version: repoPin.cachedSnapshotVersion ?? 0,
      });
    } catch {
      // Fall through to build from DB tables
      console.log(`[Snapshot] Failed to parse cachedSnapshotJson for pin ${pinId}, falling back`);
    }
  }

  // Fallback: Build snapshot from DB tables (slower path, used when no cached snapshot)
  // Use cached branches from last scan if available
  let cachedBranchNames: Set<string>;
  if (repoPin.cachedBranchesJson) {
    try {
      const branches = JSON.parse(repoPin.cachedBranchesJson) as string[];
      cachedBranchNames = new Set(branches);
    } catch {
      cachedBranchNames = new Set<string>();
    }
  } else {
    cachedBranchNames = new Set<string>();
  }

  const [cachedBranchLinks, rules, treeSpecs, confirmedSessions, worktreeActivities] = await Promise.all([
    db.select().from(schema.branchLinks).where(eq(schema.branchLinks.repoId, repoId)),
    db.select().from(schema.projectRules).where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    ),
    db.select().from(schema.treeSpecs).where(eq(schema.treeSpecs.repoId, repoId)),
    db.select().from(schema.planningSessions).where(
      and(
        eq(schema.planningSessions.repoId, repoId),
        eq(schema.planningSessions.status, "confirmed")
      )
    ),
    db.select().from(schema.worktreeActivity).where(eq(schema.worktreeActivity.repoId, repoId)),
  ]);

  // Build PR info from cached branch links (only for branches that exist in cache)
  const cachedPrs: import("../../shared/types").PRInfo[] = [];
  for (const link of cachedBranchLinks) {
    if (link.linkType === "pr" && cachedBranchNames.has(link.branchName)) {
      cachedPrs.push({
        branch: link.branchName,
        number: link.number ?? 0,
        title: link.title ?? "",
        url: link.url,
        state: (link.status?.toUpperCase() ?? "OPEN") as "OPEN" | "MERGED" | "CLOSED",
        checks: link.checksStatus?.toUpperCase() as "PENDING" | "SUCCESS" | "FAILURE" | undefined,
        reviewDecision: link.reviewDecision as "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | undefined,
        reviewStatus: link.reviewStatus as "none" | "requested" | "reviewed" | "approved" | undefined,
        labels: link.labels ? JSON.parse(link.labels) : undefined,
        reviewers: link.reviewers ? JSON.parse(link.reviewers) : undefined,
      });
    }
  }

  // If no cached branches, fall back to building from DB tables
  if (cachedBranchNames.size === 0) {
    for (const link of cachedBranchLinks) {
      cachedBranchNames.add(link.branchName);
    }
    for (const wt of worktreeActivities) {
      if (wt.branchName) cachedBranchNames.add(wt.branchName);
    }
    for (const session of confirmedSessions) {
      const sessionNodes = JSON.parse(session.nodesJson) as Array<{ branchName?: string }>;
      for (const node of sessionNodes) {
        if (node.branchName) cachedBranchNames.add(node.branchName);
      }
    }
    if (treeSpecs[0]) {
      const specJson = JSON.parse(treeSpecs[0].specJson) as { nodes?: Array<{ branchName: string }>; edges?: Array<{ parent: string; child: string }> };
      if (specJson.nodes) {
        for (const node of specJson.nodes) {
          if (node.branchName) cachedBranchNames.add(node.branchName);
        }
      }
      if (specJson.edges) {
        for (const edge of specJson.edges) {
          if (edge.parent) cachedBranchNames.add(edge.parent);
          if (edge.child) cachedBranchNames.add(edge.child);
        }
      }
    }
    cachedBranchNames.add(savedBaseBranch);
  }

  // Build cached nodes (minimal info from DB)
  const cachedNodes: import("../../shared/types").TreeNode[] = Array.from(cachedBranchNames).map((branchName) => {
    const pr = cachedPrs.find((p) => p.branch === branchName);
    const wt = worktreeActivities.find((w) => w.branchName === branchName);
    return {
      branchName,
      badges: [],
      pr,
      worktree: wt ? {
        path: wt.worktreePath,
        branch: wt.branchName ?? "",
        commit: "",
        dirty: false,
        isActive: wt.activeAgent !== null,
        activeAgent: wt.activeAgent ?? undefined,
      } : undefined,
      lastCommitAt: "",
    };
  });

  // Use cached edges from last scan if available, otherwise build from DB
  let cachedEdges: import("../../shared/types").TreeEdge[] = [];
  if (repoPin.cachedEdgesJson) {
    try {
      const rawCachedEdges = JSON.parse(repoPin.cachedEdgesJson) as import("../../shared/types").TreeEdge[];
      // Remap cached edges: keep edges for existing children, remap parent to savedBaseBranch if parent doesn't exist
      cachedEdges = rawCachedEdges
        .filter((e) => cachedBranchNames.has(e.child))
        .map((e) => ({
          ...e,
          parent: (cachedBranchNames.has(e.parent) || e.parent === savedBaseBranch)
            ? e.parent
            : savedBaseBranch,
        }));
    } catch {
      // Fallback to building from DB below
    }
  }

  // Build treeSpec (needed for response regardless of cache)
  const treeSpec: import("../../shared/types").TreeSpec | undefined = treeSpecs[0]
    ? {
        id: treeSpecs[0].id,
        repoId: treeSpecs[0].repoId,
        baseBranch: treeSpecs[0].baseBranch ?? savedBaseBranch,
        status: (treeSpecs[0].status ?? "draft") as import("../../shared/types").TreeSpec["status"],
        specJson: JSON.parse(treeSpecs[0].specJson),
        createdAt: treeSpecs[0].createdAt,
        updatedAt: treeSpecs[0].updatedAt,
      }
    : undefined;

  // If no cached edges, build from planning sessions and treeSpecs
  if (cachedEdges.length === 0) {
    for (const session of confirmedSessions) {
      const sessionNodes = JSON.parse(session.nodesJson) as Array<{ id: string; branchName?: string }>;
      const sessionEdges = JSON.parse(session.edgesJson) as Array<{ parent: string; child: string }>;

      const taskToBranch = new Map<string, string>();
      for (const node of sessionNodes) {
        if (node.branchName) taskToBranch.set(node.id, node.branchName);
      }

      for (const edge of sessionEdges) {
        const parentBranch = taskToBranch.get(edge.parent) ?? edge.parent;
        const childBranch = taskToBranch.get(edge.child) ?? edge.child;
        if (parentBranch && childBranch && cachedBranchNames.has(parentBranch) && cachedBranchNames.has(childBranch)) {
          cachedEdges.push({
            parent: parentBranch,
            child: childBranch,
            confidence: "high" as const,
            isDesigned: true,
          });
        }
      }

      // Root tasks connect to base branch
      const effectiveBaseBranch = cachedBranchNames.has(session.baseBranch) ? session.baseBranch : savedBaseBranch;
      const childTaskIds = new Set(sessionEdges.map((e) => e.child));
      for (const node of sessionNodes) {
        if (node.branchName && !childTaskIds.has(node.id)) {
          cachedEdges.push({
            parent: effectiveBaseBranch,
            child: node.branchName,
            confidence: "high" as const,
            isDesigned: true,
          });
        }
      }
    }

    // Add edges from treeSpecs
    if (treeSpec) {
      for (const designedEdge of treeSpec.specJson.edges as Array<{ parent: string; child: string }>) {
        const parentBranch = cachedBranchNames.has(designedEdge.parent) ? designedEdge.parent : savedBaseBranch;
        if (cachedBranchNames.has(designedEdge.child)) {
          const existingIndex = cachedEdges.findIndex((e) => e.child === designedEdge.child);
          if (existingIndex >= 0) {
            cachedEdges[existingIndex] = {
              parent: parentBranch,
              child: designedEdge.child,
              confidence: "high" as const,
              isDesigned: true,
            };
          } else {
            cachedEdges.push({
              parent: parentBranch,
              child: designedEdge.child,
              confidence: "high" as const,
              isDesigned: true,
            });
          }
        }
      }
    }
  }

  const ruleRecord = rules[0];
  const branchNaming = ruleRecord ? (JSON.parse(ruleRecord.ruleJson) as BranchNamingRule) : null;

  // Build cached worktrees from DB
  const cachedWorktrees: import("../../shared/types").WorktreeInfo[] = worktreeActivities.map((wt) => ({
    path: wt.worktreePath,
    branch: wt.branchName ?? "",
    commit: "",
    dirty: false,
    isActive: wt.activeAgent !== null,
    activeAgent: wt.activeAgent ?? undefined,
  }));

  const cachedSnapshot: ScanSnapshot = {
    repoId,
    defaultBranch: savedBaseBranch,
    branches: Array.from(cachedBranchNames),
    nodes: cachedNodes,
    edges: cachedEdges,
    warnings: [],
    worktrees: cachedWorktrees,
    rules: { branchNaming },
    restart: null,
    ...(treeSpec && { treeSpec }),
  };

  // Return snapshot with version metadata (fallback path has version 0)
  return c.json({
    snapshot: cachedSnapshot,
    version: repoPin.cachedSnapshotVersion ?? 0,
  });
});

// POST /api/scan - Start background scan, return immediately
scanRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(scanSchema, body);
  const localPath = expandTilde(input.localPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Get repo info from gh CLI
  const repoId = await getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError(`Could not detect GitHub repo at: ${localPath}`);
  }

  // Get repoPin for savedBaseBranch
  const [repoPin] = await db.select().from(schema.repoPins).where(eq(schema.repoPins.localPath, localPath));
  const savedBaseBranch = repoPin?.baseBranch ?? "main";

  // Get rules and treeSpec for snapshot building
  const [rules, treeSpecs] = await Promise.all([
    db.select().from(schema.projectRules).where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    ),
    db.select().from(schema.treeSpecs).where(eq(schema.treeSpecs.repoId, repoId)),
  ]);

  const ruleRecord = rules[0];
  const branchNaming = ruleRecord ? (JSON.parse(ruleRecord.ruleJson) as BranchNamingRule) : null;

  const treeSpec: TreeSpec | undefined = treeSpecs[0]
    ? {
        id: treeSpecs[0].id,
        repoId: treeSpecs[0].repoId,
        baseBranch: treeSpecs[0].baseBranch ?? savedBaseBranch,
        status: (treeSpecs[0].status ?? "draft") as TreeSpec["status"],
        specJson: JSON.parse(treeSpecs[0].specJson),
        createdAt: treeSpecs[0].createdAt,
        updatedAt: treeSpecs[0].updatedAt,
      }
    : undefined;

  // Start background scan (don't await)
  (async () => {
    try {
      // Generate scan session ID for grouping logs
      const scanSessionId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[Scan] Starting background scan for ${repoId} (session: ${scanSessionId})`);

      // Helper to build snapshot
      const buildSnapshot = (
        branchNames: string[],
        defaultBranch: string,
        nodes: import("../../shared/types").TreeNode[],
        edges: import("../../shared/types").TreeEdge[],
        worktrees: import("../../shared/types").WorktreeInfo[],
        warnings: import("../../shared/types").Warning[]
      ): ScanSnapshot => ({
        repoId,
        defaultBranch,
        branches: branchNames,
        nodes,
        edges,
        warnings,
        worktrees,
        rules: { branchNaming },
        restart: null,
        ...(treeSpec && { treeSpec }),
      });

      // Step 1: Get branches
      const branches = await getBranches(localPath);
      const branchNames = branches.map((b) => b.name);
      const currentDefaultBranch = savedBaseBranch && branchNames.includes(savedBaseBranch)
        ? savedBaseBranch
        : await getDefaultBranch(localPath, branchNames);

      // Clean up old branch data from DB
      if (branchNames.length > 0) {
        await Promise.all([
          db.delete(schema.branchLinks).where(
            and(eq(schema.branchLinks.repoId, repoId), notInArray(schema.branchLinks.branchName, branchNames))
          ),
          db.delete(schema.worktreeActivity).where(
            and(eq(schema.worktreeActivity.repoId, repoId), notInArray(schema.worktreeActivity.branchName, branchNames))
          ),
          db.delete(schema.branchExternalLinks).where(
            and(eq(schema.branchExternalLinks.repoId, repoId), notInArray(schema.branchExternalLinks.branchName, branchNames))
          ),
          db.delete(schema.branchFiles).where(
            and(eq(schema.branchFiles.repoId, repoId), notInArray(schema.branchFiles.branchName, branchNames))
          ),
          db.delete(schema.taskTodos).where(
            and(eq(schema.taskTodos.repoId, repoId), notInArray(schema.taskTodos.branchName, branchNames))
          ),
          db.delete(schema.taskInstructions).where(
            and(eq(schema.taskInstructions.repoId, repoId), notInArray(schema.taskInstructions.branchName, branchNames))
          ),
        ]);
        console.log(`[Scan] Cleaned up old branch data for ${repoId}`);
      }

      let currentNodes: import("../../shared/types").TreeNode[] = branchNames.map((name) => ({
        branchName: name,
        badges: [],
        lastCommitAt: "",
      }));

      // Initialize edges from cached scan result if available
      const branchSet = new Set(branchNames);
      let currentEdges: import("../../shared/types").TreeEdge[] = [];

      // Use cached edges from last scan if available
      if (repoPin?.cachedEdgesJson) {
        try {
          const cachedEdges = JSON.parse(repoPin.cachedEdgesJson) as import("../../shared/types").TreeEdge[];
          // Remap cached edges: keep edges for existing children, remap parent to defaultBranch if parent doesn't exist
          currentEdges = cachedEdges
            .filter((e) => branchSet.has(e.child))
            .map((e) => ({
              ...e,
              parent: (branchSet.has(e.parent) || e.parent === currentDefaultBranch)
                ? e.parent
                : currentDefaultBranch,
            }));
        } catch {
          // Fall through to build from DB
        }
      }

      // Get confirmed sessions (needed for building edges and later merging)
      const confirmedSessions = await db.select().from(schema.planningSessions).where(
        and(eq(schema.planningSessions.repoId, repoId), eq(schema.planningSessions.status, "confirmed"))
      );

      // If no cached edges, build from planning sessions and treeSpec
      if (currentEdges.length === 0) {
        for (const session of confirmedSessions) {
          const sessionNodes = JSON.parse(session.nodesJson) as Array<{ id: string; branchName?: string }>;
          const sessionEdges = JSON.parse(session.edgesJson) as Array<{ parent: string; child: string }>;
          const taskToBranch = new Map<string, string>();
          for (const node of sessionNodes) {
            if (node.branchName) taskToBranch.set(node.id, node.branchName);
          }
          const effectiveBaseBranch = branchSet.has(session.baseBranch) ? session.baseBranch : currentDefaultBranch;
          for (const edge of sessionEdges) {
            let parentBranch = taskToBranch.get(edge.parent) ?? edge.parent;
            const childBranch = taskToBranch.get(edge.child) ?? edge.child;
            if (!branchSet.has(parentBranch)) parentBranch = effectiveBaseBranch;
            if (parentBranch && childBranch && branchSet.has(childBranch)) {
              const idx = currentEdges.findIndex((e) => e.child === childBranch);
              if (idx >= 0) currentEdges[idx] = { parent: parentBranch, child: childBranch, confidence: "high", isDesigned: true };
              else currentEdges.push({ parent: parentBranch, child: childBranch, confidence: "high", isDesigned: true });
            }
          }
          const childTaskIds = new Set(sessionEdges.map((e) => e.child));
          for (const node of sessionNodes) {
            if (node.branchName && !childTaskIds.has(node.id) && branchSet.has(node.branchName)) {
              const idx = currentEdges.findIndex((e) => e.child === node.branchName);
              if (idx >= 0) currentEdges[idx] = { parent: effectiveBaseBranch, child: node.branchName, confidence: "high", isDesigned: true };
              else currentEdges.push({ parent: effectiveBaseBranch, child: node.branchName, confidence: "high", isDesigned: true });
            }
          }
        }

        // Add edges from treeSpec
        if (treeSpec) {
          for (const designedEdge of treeSpec.specJson.edges as Array<{ parent: string; child: string }>) {
            const parentBranch = branchSet.has(designedEdge.parent) ? designedEdge.parent : currentDefaultBranch;
            if (branchSet.has(designedEdge.child)) {
              const idx = currentEdges.findIndex((e) => e.child === designedEdge.child);
              if (idx >= 0) currentEdges[idx] = { parent: parentBranch, child: designedEdge.child, confidence: "high", isDesigned: true };
              else currentEdges.push({ parent: parentBranch, child: designedEdge.child, confidence: "high", isDesigned: true });
            }
          }
        }
      }

      let currentWorktrees: import("../../shared/types").WorktreeInfo[] = [];
      let currentWarnings: import("../../shared/types").Warning[] = [];

      console.log(`[Scan] Step 1 complete: ${currentEdges.length} edges from DB cache`);
      // Note: Intermediate broadcasts are for progress indication only, UI should NOT auto-update from these
      // Progress: 8 total steps (edges_cached, worktrees, tree, aheadBehind, remoteAheadBehind, final, pr_refreshing, complete)
      const TOTAL_STEPS = 8;
      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: (repoPin?.cachedSnapshotVersion ?? 0),
          stage: "edges_cached",
          isFinal: false,
          isComplete: false,
          progress: { current: 1, total: TOTAL_STEPS },
          snapshot: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        },
      });

      // Step 2: Get worktrees
      const worktrees = await getWorktrees(localPath);
      currentWorktrees = worktrees;

      for (const node of currentNodes) {
        const wt = worktrees.find((w) => w.branch === node.branchName);
        if (wt) node.worktree = wt;
      }

      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: (repoPin?.cachedSnapshotVersion ?? 0),
          stage: "worktrees",
          isFinal: false,
          isComplete: false,
          progress: { current: 2, total: TOTAL_STEPS },
          snapshot: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        },
      });

      // Step 3: Build tree structure
      const cachedPrs = await db.select().from(schema.branchLinks).where(
        and(eq(schema.branchLinks.repoId, repoId), eq(schema.branchLinks.linkType, "pr"))
      );
      const prs: import("../../shared/types").PRInfo[] = cachedPrs.map((link) => ({
        branch: link.branchName,
        number: link.number ?? 0,
        title: link.title ?? "",
        url: link.url,
        state: (link.status?.toUpperCase() ?? "OPEN") as "OPEN" | "MERGED" | "CLOSED",
        checks: link.checksStatus?.toUpperCase() as "PENDING" | "SUCCESS" | "FAILURE" | undefined,
        reviewDecision: link.reviewDecision as "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | undefined,
        reviewStatus: link.reviewStatus as "none" | "requested" | "reviewed" | "approved" | undefined,
        labels: link.labels ? JSON.parse(link.labels) : undefined,
        reviewers: link.reviewers ? JSON.parse(link.reviewers) : undefined,
      }));

      const { nodes: treeNodes, edges: treeEdges } = await buildTree(branches, worktrees, prs, localPath, currentDefaultBranch);
      currentNodes = treeNodes;
      currentEdges = treeEdges;

      // Merge planning session edges (reuse confirmedSessions from initial load)
      for (const session of confirmedSessions) {
        const sessionNodes = JSON.parse(session.nodesJson) as Array<{ id: string; branchName?: string }>;
        const sessionEdges = JSON.parse(session.edgesJson) as Array<{ parent: string; child: string }>;
        const taskToBranch = new Map<string, string>();
        for (const node of sessionNodes) {
          if (node.branchName) taskToBranch.set(node.id, node.branchName);
        }
        const effectiveBaseBranch = branchSet.has(session.baseBranch) ? session.baseBranch : currentDefaultBranch;
        for (const edge of sessionEdges) {
          let parentBranch = taskToBranch.get(edge.parent) ?? edge.parent;
          const childBranch = taskToBranch.get(edge.child) ?? edge.child;
          if (!branchSet.has(parentBranch)) parentBranch = effectiveBaseBranch;
          if (parentBranch && childBranch && branchSet.has(childBranch)) {
            const idx = currentEdges.findIndex((e) => e.child === childBranch);
            if (idx >= 0) currentEdges[idx] = { parent: parentBranch, child: childBranch, confidence: "high", isDesigned: true };
            else currentEdges.push({ parent: parentBranch, child: childBranch, confidence: "high", isDesigned: true });
          }
        }
        const childTaskIds = new Set(sessionEdges.map((e) => e.child));
        for (const node of sessionNodes) {
          if (node.branchName && !childTaskIds.has(node.id) && branchSet.has(node.branchName)) {
            const idx = currentEdges.findIndex((e) => e.child === node.branchName);
            if (idx >= 0) currentEdges[idx] = { parent: effectiveBaseBranch, child: node.branchName, confidence: "high", isDesigned: true };
            else currentEdges.push({ parent: effectiveBaseBranch, child: node.branchName, confidence: "high", isDesigned: true });
          }
        }
      }

      // Merge treeSpec edges
      if (treeSpec) {
        for (const designedEdge of treeSpec.specJson.edges as Array<{ parent: string; child: string }>) {
          const parentBranch = branchSet.has(designedEdge.parent) ? designedEdge.parent : currentDefaultBranch;
          if (branchSet.has(designedEdge.child)) {
            const idx = currentEdges.findIndex((e) => e.child === designedEdge.child);
            if (idx >= 0) currentEdges[idx] = { parent: parentBranch, child: designedEdge.child, confidence: "high", isDesigned: true };
            else currentEdges.push({ parent: parentBranch, child: designedEdge.child, confidence: "high", isDesigned: true });
          }
        }
      }

      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: (repoPin?.cachedSnapshotVersion ?? 0),
          stage: "tree",
          isFinal: false,
          isComplete: false,
          progress: { current: 3, total: TOTAL_STEPS },
          snapshot: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        },
      });

      // Step 4: Calculate ahead/behind
      await calculateAheadBehind(currentNodes, currentEdges, localPath, currentDefaultBranch);
      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: (repoPin?.cachedSnapshotVersion ?? 0),
          stage: "aheadBehind",
          isFinal: false,
          isComplete: false,
          progress: { current: 4, total: TOTAL_STEPS },
          snapshot: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        },
      });

      // Step 5: Calculate remote ahead/behind
      await calculateRemoteAheadBehind(currentNodes, localPath);
      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: (repoPin?.cachedSnapshotVersion ?? 0),
          stage: "remoteAheadBehind",
          isFinal: false,
          isComplete: false,
          progress: { current: 5, total: TOTAL_STEPS },
          snapshot: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        },
      });

      // Step 6: Calculate warnings
      currentWarnings = calculateWarnings(currentNodes, currentEdges, branchNaming, currentDefaultBranch, treeSpec);

      // Final broadcast with restart info
      const activeWorktree = currentWorktrees.find((w) => w.branch !== "HEAD");
      const finalSnapshot: ScanSnapshot = {
        ...buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        restart: activeWorktree ? generateRestartInfo(activeWorktree, currentNodes, currentWarnings, branchNaming) : null,
      };
      // Update repoId if changed
      if (repoPin && repoPin.repoId !== repoId) {
        await db.update(schema.repoPins).set({ repoId }).where(eq(schema.repoPins.id, repoPin.id));
      }

      // Cache full snapshot and branches/edges in DB (SSOT)
      const now = new Date().toISOString();
      const newVersion = (repoPin?.cachedSnapshotVersion ?? 0) + 1;
      if (repoPin) {
        await db.update(schema.repoPins).set({
          cachedBranchesJson: JSON.stringify(branchNames),
          cachedEdgesJson: JSON.stringify(currentEdges),
          cachedSnapshotJson: JSON.stringify(finalSnapshot),
          cachedSnapshotUpdatedAt: now,
          cachedSnapshotVersion: newVersion,
        }).where(eq(schema.repoPins.id, repoPin.id));
        console.log(`[Scan] Cached full snapshot (v${newVersion}) for ${repoId}`);
      }

      // Broadcast final result with metadata (UI uses this for notification, not auto-update)
      // Note: isFinal=true but isComplete=false because PR refresh is still pending
      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: newVersion,
          stage: "final",
          isFinal: true,
          isComplete: false,
          progress: { current: 6, total: TOTAL_STEPS },
          snapshot: finalSnapshot,
        },
      });

      console.log(`[Scan] Background scan completed for ${repoId}`);

      // Step 7: Smart PR refresh - prioritize local branches, gradually update others
      // Broadcast progress immediately so UI shows "Refreshing PRs..." during the slow gh pr list call
      broadcast({
        type: "scan.updated",
        repoId,
        data: {
          version: newVersion,
          stage: "pr_refreshing",
          isFinal: false,
          isComplete: false,
          progress: { current: 7, total: TOTAL_STEPS },
          snapshot: finalSnapshot,
        },
      });

      try {
        // Load polling settings for PR fetch count
        const pollingRules = await db.select().from(schema.projectRules)
          .where(and(
            eq(schema.projectRules.repoId, repoId),
            eq(schema.projectRules.ruleType, "polling"),
            eq(schema.projectRules.isActive, true)
          ));
        const pollingRule = pollingRules[0];
        const pollingSettings = pollingRule ? JSON.parse(pollingRule.ruleJson) : null;
        const prFetchCount = pollingSettings?.prFetchCount ?? 5;

        const freshPrs = await getPRs(localPath);
        if (freshPrs.length === 0) {
          // No PRs found, send complete signal
          broadcast({
            type: "scan.updated",
            repoId,
            data: {
              version: newVersion,
              stage: "complete",
              isFinal: true,
              isComplete: true,
              progress: { current: TOTAL_STEPS, total: TOTAL_STEPS },
              snapshot: finalSnapshot,
            },
          });
          console.log(`[Scan] No PRs found, scan complete for ${repoId}`);
        } else {
        // Get cached PR data for scoring
        const cachedPRs = await db.select().from(schema.branchLinks)
          .where(and(
            eq(schema.branchLinks.repoId, repoId),
            eq(schema.branchLinks.linkType, "pr")
          ));

        const localBranchSet = new Set(branchNames);
        const worktreeBranchSet = new Set(worktrees.map(w => w.branch).filter(Boolean) as string[]);

        // Build a map of fresh PRs for quick lookup (only for LOCAL branches)
        const freshPrMap = new Map(
          freshPrs
            .filter(pr => localBranchSet.has(pr.branch))
            .map(pr => [pr.branch, pr])
        );

        // Build cache lookup for updatedAt
        const cacheMap = new Map(
          cachedPRs.map(c => [c.branchName, c])
        );

        // Score and select PRs to refresh (only PRs that exist in freshPrMap)
        const { selectPRsToRefresh, calculatePRScore } = await import("../lib/pr-scoring");
        const prsForScoring = Array.from(freshPrMap.values()).map(pr => {
          const cached = cacheMap.get(pr.branch);
          return {
            branchName: pr.branch,
            checksStatus: pr.checks?.toLowerCase() ?? null,
            updatedAt: cached?.updatedAt ?? null,
          };
        });

        const scoringContext = {
          localBranches: localBranchSet,
          worktreeBranches: worktreeBranchSet,
          now: Date.now(),
        };

        const selected = selectPRsToRefresh(prsForScoring, scoringContext, {
          maxTotal: prFetchCount,
        });

        // Filter fresh PRs to only selected ones
        const relevantPrs = selected
          .map(s => freshPrMap.get(s.branchName))
          .filter((pr): pr is NonNullable<typeof pr> => pr != null);

        // Broadcast which PRs were selected for scanning (for debugging)
        if (relevantPrs.length > 0) {
          broadcast({
            type: "pr.scanned",
            repoId,
            data: { branches: relevantPrs.map(pr => pr.branch) },
          });
          const now = new Date().toISOString();
          const updatedPrs: { branch: string; checks: string | null; state: string; changes: { type: string; old?: string | null; new?: string | null }[] }[] = [];
          const totalPrs = relevantPrs.length;
          let processedPrs = 0;
          for (const pr of relevantPrs) {
            const existing = await db.select().from(schema.branchLinks)
              .where(and(
                eq(schema.branchLinks.repoId, repoId),
                eq(schema.branchLinks.branchName, pr.branch),
                eq(schema.branchLinks.linkType, "pr"),
                eq(schema.branchLinks.number, pr.number)
              )).limit(1);

            const prData = {
              title: pr.title,
              status: pr.state.toLowerCase(),
              checksStatus: pr.checks?.toLowerCase() ?? null,
              checks: pr.checksDetail ? JSON.stringify(pr.checksDetail) : null,
              reviewDecision: pr.reviewDecision ?? null,
              reviewStatus: pr.reviewStatus ?? null,
              labels: pr.labels ? JSON.stringify(pr.labels) : null,
              reviewers: pr.reviewers ? JSON.stringify(pr.reviewers) : null,
              updatedAt: now,
            };

            if (existing[0]) {
              // Detect what changed with details
              const changes: { type: string; old?: string | null; new?: string | null }[] = [];
              const old = existing[0];

              if ((old.checksStatus ?? null) !== prData.checksStatus) {
                // Count passed/total and get failed checks from checks JSON
                type CheckInfo = { name?: string; conclusion?: string; detailsUrl?: string };
                const parseChecks = (checksJson: string | null) => {
                  if (!checksJson) return { passed: 0, total: 0, failed: [] as { name: string; url: string | null }[] };
                  try {
                    const checks = JSON.parse(checksJson) as CheckInfo[];
                    const total = checks.length;
                    const passed = checks.filter(c => {
                      const conclusion = c.conclusion?.toUpperCase();
                      return conclusion === "SUCCESS" || conclusion === "SKIPPED";
                    }).length;
                    const failed = checks
                      .filter(c => {
                        const conclusion = c.conclusion?.toUpperCase();
                        return conclusion !== "SUCCESS" && conclusion !== "SKIPPED" && conclusion !== null;
                      })
                      .map(c => ({ name: c.name || "Unknown", url: c.detailsUrl || null }));
                    return { passed, total, failed };
                  } catch {
                    return { passed: 0, total: 0, failed: [] as { name: string; url: string | null }[] };
                  }
                };
                const oldParsed = parseChecks(old.checks);
                const newParsed = parseChecks(prData.checks);
                changes.push({
                  type: "checks",
                  old: old.checksStatus,
                  new: prData.checksStatus,
                  oldPassed: oldParsed.passed,
                  oldTotal: oldParsed.total,
                  newPassed: newParsed.passed,
                  newTotal: newParsed.total,
                  failedChecks: newParsed.failed,
                });
              }
              {
                // Handle both string[] and {name: string; color: string}[] formats for backwards compatibility
                type LabelWithColor = { name: string; color: string };
                const parseLabels = (json: string | null): LabelWithColor[] => {
                  if (!json) return [];
                  const parsed = JSON.parse(json);
                  return parsed.map((l: string | LabelWithColor) =>
                    typeof l === "string" ? { name: l, color: "6b7280" } : { name: l.name, color: l.color || "6b7280" }
                  );
                };
                const oldLabels = parseLabels(old.labels);
                const newLabels = parseLabels(prData.labels);
                const oldNames = oldLabels.map(l => l.name);
                const newNames = newLabels.map(l => l.name);
                const added = newLabels.filter(l => !oldNames.includes(l.name));
                const removed = oldLabels.filter(l => !newNames.includes(l.name));
                // Only add change if there are actual additions or removals
                if (added.length > 0 || removed.length > 0) {
                  changes.push({
                    type: "labels",
                    added: added.map(l => ({ name: l.name, color: l.color })),
                    removed: removed.map(l => ({ name: l.name, color: l.color })),
                  });
                }
              }
              // Normalize empty/null values for comparison
              const oldReviewDecision = old.reviewDecision || null;
              const newReviewDecision = prData.reviewDecision || null;
              if (oldReviewDecision !== newReviewDecision) {
                changes.push({ type: "review", old: oldReviewDecision, new: newReviewDecision });
              }
              {
                const oldReviewers: string[] = old.reviewers ? JSON.parse(old.reviewers).sort() : [];
                const newReviewers: string[] = prData.reviewers ? JSON.parse(prData.reviewers).sort() : [];
                const added = newReviewers.filter(r => !oldReviewers.includes(r));
                const removed = oldReviewers.filter(r => !newReviewers.includes(r));
                if (added.length > 0 || removed.length > 0) {
                  changes.push({ type: "reviewers", old: removed.join(","), new: added.join(",") });
                }
              }

              // Only broadcast if something actually changed
              if (changes.length > 0) {
                updatedPrs.push({
                  branch: pr.branch,
                  checks: prData.checksStatus,
                  state: prData.status,
                  changes,
                });
                // Save to scan logs - one log per change
                for (const change of changes) {
                  const logData = {
                    branch: pr.branch,
                    changeType: change.type,
                    data: change,
                  };
                  await db.insert(schema.scanLogs).values({
                    repoId,
                    logType: "pr",
                    message: `${pr.branch}: ${change.type}`,
                    html: JSON.stringify(logData),
                    branchName: pr.branch,
                    scanSessionId,
                    createdAt: now,
                  });
                }
              }
              await db.update(schema.branchLinks).set(prData).where(eq(schema.branchLinks.id, existing[0].id));
              // Broadcast branchLink.updated so frontend branchLinks state is updated
              broadcast({
                type: "branchLink.updated",
                repoId,
                data: { ...existing[0], ...prData },
              });
            } else {
              // New PR - always broadcast
              const insertResult = await db.insert(schema.branchLinks).values({ repoId, branchName: pr.branch, linkType: "pr", url: pr.url, number: pr.number, ...prData, createdAt: now }).returning();
              updatedPrs.push({ branch: pr.branch, checks: prData.checksStatus, state: prData.status, changes: [{ type: "new" }] });
              // Save to scan logs
              const logData = {
                branch: pr.branch,
                changeType: "new",
                data: { type: "new" },
              };
              await db.insert(schema.scanLogs).values({
                repoId,
                logType: "pr",
                message: `${pr.branch}: new`,
                html: JSON.stringify(logData),
                branchName: pr.branch,
                scanSessionId,
                createdAt: now,
              });
              // Broadcast branchLink.created so frontend branchLinks state is updated
              if (insertResult[0]) {
                broadcast({
                  type: "branchLink.created",
                  repoId,
                  data: insertResult[0],
                });
              }
            }

            // Broadcast progress after each PR
            processedPrs++;
            broadcast({
              type: "scan.updated",
              repoId,
              data: {
                version: newVersion,
                stage: "pr_refreshing",
                isFinal: false,
                isComplete: false,
                progress: { current: 7, total: 8, prProgress: { current: processedPrs, total: totalPrs } },
                snapshot: finalSnapshot,
              },
            });
          }

          // Broadcast PR updates if any changed
          if (updatedPrs.length > 0) {
            broadcast({
              type: "pr.updated",
              repoId,
              data: { prs: updatedPrs, scanSessionId },
            });
          }
        }

        // Always rebuild snapshot with fresh PR data and re-broadcast
        // This ensures frontend gets complete PR info (reviews, labels, etc.)
        const updatedNodes = finalSnapshot.nodes.map(node => {
          const freshPr = freshPrMap.get(node.branchName);
          if (freshPr) {
            return {
              ...node,
              pr: {
                branch: freshPr.branch,
                number: freshPr.number,
                title: freshPr.title,
                url: freshPr.url,
                state: freshPr.state,
                checks: freshPr.checks,
                reviewDecision: freshPr.reviewDecision,
                reviewStatus: freshPr.reviewStatus,
                labels: freshPr.labels,
                reviewers: freshPr.reviewers,
              },
            };
          }
          return node;
        });

        const prRefreshedSnapshot = { ...finalSnapshot, nodes: updatedNodes };

        // Increment version to ensure frontend accepts update
        const prRefreshVersion = newVersion + 1;

        // Update cache with fresh PR data and new version
        if (repoPin) {
          await db.update(schema.repoPins).set({
            cachedSnapshotJson: JSON.stringify(prRefreshedSnapshot),
            cachedSnapshotVersion: prRefreshVersion,
          }).where(eq(schema.repoPins.id, repoPin.id));
        }

        // Re-broadcast snapshot with fresh PR info - this is the truly complete scan
        broadcast({
          type: "scan.updated",
          repoId,
          data: {
            version: prRefreshVersion,
            stage: "pr_refreshed",
            isFinal: true,
            isComplete: true,
            progress: { current: TOTAL_STEPS, total: TOTAL_STEPS },
            snapshot: prRefreshedSnapshot,
          },
        });

        console.log(`[Scan] PR refresh complete for ${repoId}`);
        } // end else (freshPrs.length > 0)
      } catch (err) {
        console.warn("[Scan] Background PR fetch failed:", err);
      }
    } catch (err) {
      console.error("[Scan] Background scan failed:", err);
    }
  })();

  // Return immediately
  return c.json({ started: true, repoId });
});

// GET /api/scan/restart-prompt
scanRouter.get("/restart-prompt", async (c) => {
  const query = validateOrThrow(restartPromptQuerySchema, {
    repoId: c.req.query("repoId"),
    localPath: c.req.query("localPath"),
    planId: c.req.query("planId"),
    worktreePath: c.req.query("worktreePath"),
  });

  const repoId = query.repoId;
  const localPath = expandTilde(query.localPath);
  const worktreePath = query.worktreePath
    ? expandTilde(query.worktreePath)
    : undefined;

  // Get plan if provided
  let plan = null;
  if (query.planId) {
    const plans = await db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, query.planId));
    plan = plans[0] ?? null;
  }

  // Get branch naming rule
  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  const ruleRecord = rules[0];
  const branchNaming = ruleRecord
    ? (JSON.parse(ruleRecord.ruleJson) as BranchNamingRule)
    : null;

  // Get git status for worktree
  const targetPath = worktreePath ?? localPath;
  let gitStatus = "";
  try {
    gitStatus = (await execAsync(`cd "${targetPath}" && git status --short`)).trim();
  } catch {
    gitStatus = "Unable to get git status";
  }

  const prompt = `# Restart Prompt for ${repoId}

## Project Rules
### Branch Naming
- Pattern: \`${branchNaming?.pattern ?? "N/A"}\`
- Examples: ${branchNaming?.examples?.join(", ") ?? "N/A"}

${
  plan
    ? `## Plan
### ${plan.title}
${plan.contentMd}
`
    : ""
}

## Current State
\`\`\`
${gitStatus || "Clean working directory"}
\`\`\`

## Next Steps
1. Review the current state above
2. Continue working on the plan
3. Follow the branch naming convention

---
*Paste this prompt into Claude Code to continue your session.*
`;

  return c.json({
    cdCommand: `cd "${targetPath}"`,
    restartPromptMd: prompt,
  });
});

// POST /api/scan/fetch - Fetch from remote
scanRouter.post("/fetch", async (c) => {
  const body = await c.req.json();
  const localPath = expandTilde(body.localPath);

  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  const repoId = await getRepoId(localPath);

  try {
    // Step 1: Fetch all remotes
    broadcast({
      type: "fetch.progress",
      repoId,
      data: { step: "fetch", message: "git fetch --all" },
    });

    await execAsync(`cd "${localPath}" && git fetch --all`);

    // Step 2: Get remote tracking status for all branches
    broadcast({
      type: "fetch.progress",
      repoId,
      data: { step: "status", message: "Checking branch status..." },
    });

    const branchStatus: Record<string, { ahead: number; behind: number }> = {};

    try {
      // Get all local branches with their upstream
      const branchOutput = await execAsync(
        `cd "${localPath}" && git for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads`
      );

      for (const line of branchOutput.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split(" ");
        const branchName = parts[0];
        const upstream = parts[1];
        const track = parts.slice(2).join(" ");

        if (!upstream || !branchName) continue;

        // Parse [ahead N, behind M] or [ahead N] or [behind M]
        const aheadMatch = track.match(/ahead (\d+)/);
        const behindMatch = track.match(/behind (\d+)/);

        branchStatus[branchName] = {
          ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
          behind: behindMatch ? parseInt(behindMatch[1], 10) : 0,
        };
      }
    } catch {
      // Ignore errors in getting branch status
    }

    broadcast({
      type: "fetch.completed",
      repoId,
      data: { branchStatus },
    });

    return c.json({ success: true, branchStatus });
  } catch (err) {
    broadcast({
      type: "fetch.error",
      repoId,
      data: { message: err instanceof Error ? err.message : String(err) },
    });
    throw new BadRequestError(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// POST /api/scan/cleanup-stale - Remove DB entries for branches that no longer exist in git
scanRouter.post("/cleanup-stale", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath }: { localPath: string } = body;

  if (!rawLocalPath) {
    throw new BadRequestError("localPath is required");
  }

  const localPath = expandTilde(rawLocalPath);
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  const repoId = await getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError(`Could not detect GitHub repo at: ${localPath}`);
  }

  // Get actual branches from git
  const branches = await getBranches(localPath);
  const actualBranchNames = new Set(branches.map((b) => b.name));

  const cleanupResults: Record<string, number> = {};

  // 1. Clean up task_instructions
  const taskInstructionsToDelete = await db
    .select()
    .from(schema.taskInstructions)
    .where(eq(schema.taskInstructions.repoId, repoId));

  const staleTasks = taskInstructionsToDelete.filter(
    (t) => t.branchName && !actualBranchNames.has(t.branchName)
  );
  if (staleTasks.length > 0) {
    await db
      .delete(schema.taskInstructions)
      .where(
        and(
          eq(schema.taskInstructions.repoId, repoId),
          inArray(
            schema.taskInstructions.branchName,
            staleTasks.map((t) => t.branchName).filter((b): b is string => b !== null)
          )
        )
      );
    cleanupResults.taskInstructions = staleTasks.length;
  }

  // 2. Clean up worktree_activity
  const worktreeActivities = await db
    .select()
    .from(schema.worktreeActivity)
    .where(eq(schema.worktreeActivity.repoId, repoId));

  const staleWorktrees = worktreeActivities.filter(
    (w) => w.branchName && !actualBranchNames.has(w.branchName)
  );
  if (staleWorktrees.length > 0) {
    await db
      .delete(schema.worktreeActivity)
      .where(
        and(
          eq(schema.worktreeActivity.repoId, repoId),
          inArray(
            schema.worktreeActivity.branchName,
            staleWorktrees.map((w) => w.branchName).filter((b): b is string => b !== null)
          )
        )
      );
    cleanupResults.worktreeActivity = staleWorktrees.length;
  }

  // 3. Clean up branch_links
  const branchLinks = await db
    .select()
    .from(schema.branchLinks)
    .where(eq(schema.branchLinks.repoId, repoId));

  const staleBranchLinks = branchLinks.filter(
    (l) => !actualBranchNames.has(l.branchName)
  );
  if (staleBranchLinks.length > 0) {
    await db
      .delete(schema.branchLinks)
      .where(
        and(
          eq(schema.branchLinks.repoId, repoId),
          inArray(
            schema.branchLinks.branchName,
            staleBranchLinks.map((l) => l.branchName)
          )
        )
      );
    cleanupResults.branchLinks = staleBranchLinks.length;
  }

  // 4. Clean up task_todos
  const taskTodos = await db
    .select()
    .from(schema.taskTodos)
    .where(eq(schema.taskTodos.repoId, repoId));

  const staleTodos = taskTodos.filter(
    (t) => !actualBranchNames.has(t.branchName)
  );
  if (staleTodos.length > 0) {
    await db
      .delete(schema.taskTodos)
      .where(
        and(
          eq(schema.taskTodos.repoId, repoId),
          inArray(
            schema.taskTodos.branchName,
            staleTodos.map((t) => t.branchName)
          )
        )
      );
    cleanupResults.taskTodos = staleTodos.length;
  }

  const totalDeleted = Object.values(cleanupResults).reduce((a, b) => a + b, 0);

  return c.json({
    success: true,
    repoId,
    cleanupResults,
    totalDeleted,
    actualBranchCount: actualBranchNames.size,
  });
});
