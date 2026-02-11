import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, notInArray } from "drizzle-orm";
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

  // Build cached snapshot from DB data
  const cachedBranchNames = new Set<string>();
  const cachedPrs: import("../../shared/types").PRInfo[] = [];

  for (const link of cachedBranchLinks) {
    cachedBranchNames.add(link.branchName);
    if (link.linkType === "pr") {
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

  // Add branches from worktree activity
  for (const wt of worktreeActivities) {
    if (wt.branchName) cachedBranchNames.add(wt.branchName);
  }

  // Add branches from planning sessions
  for (const session of confirmedSessions) {
    const sessionNodes = JSON.parse(session.nodesJson) as Array<{ branchName?: string }>;
    for (const node of sessionNodes) {
      if (node.branchName) cachedBranchNames.add(node.branchName);
    }
  }

  // Always include base branch
  cachedBranchNames.add(savedBaseBranch);

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

  // Build cached edges from planning sessions
  const cachedEdges: import("../../shared/types").TreeEdge[] = [];
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

    // Root tasks connect to base branch (fallback to savedBaseBranch if session.baseBranch doesn't exist)
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

  return c.json(cachedSnapshot);
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
      console.log(`[Scan] Starting background scan for ${repoId}`);

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
      let currentEdges: import("../../shared/types").TreeEdge[] = [];
      let currentWorktrees: import("../../shared/types").WorktreeInfo[] = [];
      let currentWarnings: import("../../shared/types").Warning[] = [];

      broadcast({ type: "scan.updated", repoId, data: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings) });

      // Step 2: Get worktrees
      const worktrees = await getWorktrees(localPath);
      currentWorktrees = worktrees;

      for (const node of currentNodes) {
        const wt = worktrees.find((w) => w.branch === node.branchName);
        if (wt) node.worktree = wt;
      }

      broadcast({ type: "scan.updated", repoId, data: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings) });

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

      // Merge planning session edges
      const branchSet = new Set(branchNames);
      const confirmedSessions = await db.select().from(schema.planningSessions).where(
        and(eq(schema.planningSessions.repoId, repoId), eq(schema.planningSessions.status, "confirmed"))
      );

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

      broadcast({ type: "scan.updated", repoId, data: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings) });

      // Step 4: Calculate ahead/behind
      await calculateAheadBehind(currentNodes, currentEdges, localPath, currentDefaultBranch);
      broadcast({ type: "scan.updated", repoId, data: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings) });

      // Step 5: Calculate remote ahead/behind
      await calculateRemoteAheadBehind(currentNodes, localPath);
      broadcast({ type: "scan.updated", repoId, data: buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings) });

      // Step 6: Calculate warnings
      currentWarnings = calculateWarnings(currentNodes, currentEdges, branchNaming, currentDefaultBranch, treeSpec);

      // Final broadcast with restart info
      const activeWorktree = currentWorktrees.find((w) => w.branch !== "HEAD");
      const finalSnapshot: ScanSnapshot = {
        ...buildSnapshot(branchNames, currentDefaultBranch, currentNodes, currentEdges, currentWorktrees, currentWarnings),
        restart: activeWorktree ? generateRestartInfo(activeWorktree, currentNodes, currentWarnings, branchNaming) : null,
      };
      broadcast({ type: "scan.updated", repoId, data: finalSnapshot });

      // Update repoId if changed
      if (repoPin && repoPin.repoId !== repoId) {
        await db.update(schema.repoPins).set({ repoId }).where(eq(schema.repoPins.id, repoPin.id));
      }

      console.log(`[Scan] Background scan completed for ${repoId}`);

      // Step 7: Fetch PR info from GitHub
      try {
        const freshPrs = await getPRs(localPath);
        if (freshPrs.length > 0) {
          const now = new Date().toISOString();
          for (const pr of freshPrs) {
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
              reviewDecision: pr.reviewDecision ?? null,
              reviewStatus: pr.reviewStatus ?? null,
              labels: pr.labels ? JSON.stringify(pr.labels) : null,
              reviewers: pr.reviewers ? JSON.stringify(pr.reviewers) : null,
              updatedAt: now,
            };

            if (existing[0]) {
              await db.update(schema.branchLinks).set(prData).where(eq(schema.branchLinks.id, existing[0].id));
            } else {
              await db.insert(schema.branchLinks).values({ repoId, branchName: pr.branch, linkType: "pr", url: pr.url, number: pr.number, ...prData, createdAt: now });
            }
          }
        }
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
