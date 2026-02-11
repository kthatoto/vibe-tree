import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { broadcast } from "../ws";
import { expandTilde, getRepoId } from "../utils";
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

// POST /api/scan
scanRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(scanSchema, body);
  const localPath = expandTilde(input.localPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Get repo info from gh CLI
  const repoId = getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError(`Could not detect GitHub repo at: ${localPath}`);
  }

  // 1. Get branches
  const branches = getBranches(localPath);
  const branchNames = branches.map((b) => b.name);

  // 2. Get worktrees with heartbeat (can run independently)
  const worktrees = getWorktrees(localPath);

  // 3. Run all DB queries in parallel
  const [repoPinRecords, cachedPrLinks, rules, treeSpecs, confirmedSessions] = await Promise.all([
    // Repo pins
    db.select().from(schema.repoPins).where(eq(schema.repoPins.localPath, localPath)),
    // Cached PR links
    db.select().from(schema.branchLinks).where(
      and(
        eq(schema.branchLinks.repoId, repoId),
        eq(schema.branchLinks.linkType, "pr")
      )
    ),
    // Branch naming rules
    db.select().from(schema.projectRules).where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    ),
    // Tree specs
    db.select().from(schema.treeSpecs).where(eq(schema.treeSpecs.repoId, repoId)),
    // Confirmed sessions
    db.select().from(schema.planningSessions).where(
      and(
        eq(schema.planningSessions.repoId, repoId),
        eq(schema.planningSessions.status, "confirmed")
      )
    ),
  ]);

  // 4. Process repoPin and detect default branch
  const repoPin = repoPinRecords[0];
  const savedBaseBranch = repoPin?.baseBranch;

  // Update repoId in repo_pins if it has changed (ensures consistency)
  if (repoPin && repoPin.repoId !== repoId) {
    await db
      .update(schema.repoPins)
      .set({ repoId })
      .where(eq(schema.repoPins.id, repoPin.id));
  }

  // 5. Detect default branch dynamically (use saved if available and valid)
  const defaultBranch = savedBaseBranch && branchNames.includes(savedBaseBranch)
    ? savedBaseBranch
    : getDefaultBranch(localPath, branchNames);

  // Convert cached data to PRInfo format
  const cachedPrs: import("../../shared/types").PRInfo[] = cachedPrLinks.map((link) => ({
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

  // 4.5. Use cached PRs for immediate response, fetch fresh data in background
  const prs = cachedPrs;

  // Fetch fresh PR info from GitHub in background (non-blocking)
  (async () => {
    try {
      const freshPrs = getPRs(localPath);
      if (freshPrs.length === 0) return;

      const now = new Date().toISOString();
      for (const pr of freshPrs) {
        // Check if PR link already exists
        const existing = await db
          .select()
          .from(schema.branchLinks)
          .where(
            and(
              eq(schema.branchLinks.repoId, repoId),
              eq(schema.branchLinks.branchName, pr.branch),
              eq(schema.branchLinks.linkType, "pr"),
              eq(schema.branchLinks.number, pr.number)
            )
          )
          .limit(1);

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
          await db
            .update(schema.branchLinks)
            .set(prData)
            .where(eq(schema.branchLinks.id, existing[0].id));
        } else {
          await db.insert(schema.branchLinks).values({
            repoId,
            branchName: pr.branch,
            linkType: "pr",
            url: pr.url,
            number: pr.number,
            ...prData,
            createdAt: now,
          });
        }

        // Broadcast update for real-time UI refresh
        broadcast({
          type: "branchLink.updated",
          repoId,
          data: {
            branchName: pr.branch,
            linkType: "pr",
            ...prData,
          },
        });
      }

      // After all PRs updated, trigger a rescan broadcast to update the graph
      broadcast({
        type: "scan.prsUpdated",
        repoId,
        data: { count: freshPrs.length },
      });
    } catch (err) {
      console.warn("[Scan] Background PR fetch failed:", err);
    }
  })();

  // 5. Build tree (infer parent-child relationships)
  const { nodes, edges } = buildTree(branches, worktrees, prs, localPath, defaultBranch);

  // 6. Process branch naming rule (already fetched in parallel)
  const ruleRecord = rules[0];
  const branchNaming = ruleRecord
    ? (JSON.parse(ruleRecord.ruleJson) as BranchNamingRule)
    : null;

  // 7. Process tree spec (already fetched in parallel)
  const treeSpec: TreeSpec | undefined = treeSpecs[0]
    ? {
        id: treeSpecs[0].id,
        repoId: treeSpecs[0].repoId,
        baseBranch: treeSpecs[0].baseBranch ?? defaultBranch,
        status: (treeSpecs[0].status ?? "draft") as TreeSpec["status"],
        specJson: JSON.parse(treeSpecs[0].specJson),
        createdAt: treeSpecs[0].createdAt,
        updatedAt: treeSpecs[0].updatedAt,
      }
    : undefined;

  // 8. Merge confirmed planning session edges (already fetched in parallel)
  for (const session of confirmedSessions) {
    console.log(`[Scan] Processing confirmed session: ${session.id}, title: ${session.title || "Untitled"}`);
    const sessionNodes = JSON.parse(session.nodesJson) as Array<{
      id: string;
      title: string;
      branchName?: string;
    }>;
    // Planning session edges use { parent, child } format (task IDs)
    const sessionEdges = JSON.parse(session.edgesJson) as Array<{
      parent: string;
      child: string;
    }>;
    console.log(`[Scan] Session has ${sessionNodes.length} nodes, ${sessionEdges.length} edges`);
    console.log(`[Scan] Session edges raw:`, JSON.stringify(sessionEdges));

    // Build taskId -> branchName map
    const taskToBranch = new Map<string, string>();
    for (const node of sessionNodes) {
      if (node.branchName) {
        taskToBranch.set(node.id, node.branchName);
        console.log(`[Scan] Task mapping: ${node.id} -> ${node.branchName}`);
      }
    }

    // Convert task edges to branch edges
    // NOTE: Planning session edges are user-designed, so we trust them completely
    // and do NOT validate against git ancestry (which can fail for newly created branches)
    for (const edge of sessionEdges) {
      console.log(`[Scan] Processing edge: parent=${edge.parent}, child=${edge.child}`);
      // First try to resolve as task IDs, then as branch names directly
      const parentBranch = taskToBranch.get(edge.parent) ?? edge.parent;
      const childBranch = taskToBranch.get(edge.child) ?? edge.child;
      console.log(`[Scan] Resolved to: parentBranch=${parentBranch}, childBranch=${childBranch}`);

      if (parentBranch && childBranch) {
        // Check if this child already has an edge
        const existingIndex = edges.findIndex((e) => e.child === childBranch);
        if (existingIndex >= 0) {
          // Planning session edges (user-designed) always take priority over git-inferred edges
          edges[existingIndex] = {
            parent: parentBranch,
            child: childBranch,
            confidence: "high" as const,
            isDesigned: true,
          };
        } else {
          // Add new edge
          edges.push({
            parent: parentBranch,
            child: childBranch,
            confidence: "high" as const,
            isDesigned: true,
          });
        }
      } else if (childBranch && !parentBranch) {
        // Child has branch but parent doesn't - connect to base branch
        const existingIndex = edges.findIndex((e) => e.child === childBranch);
        if (existingIndex < 0) {
          edges.push({
            parent: session.baseBranch,
            child: childBranch,
            confidence: "high" as const,
            isDesigned: true,
          });
        }
      }
    }

    // Also add edges for root tasks (tasks without parent edge) to base branch
    const childTaskIds = new Set(sessionEdges.map((e) => e.child));
    for (const node of sessionNodes) {
      if (node.branchName && !childTaskIds.has(node.id)) {
        // This is a root task - connect to base branch
        const existingIndex = edges.findIndex((e) => e.child === node.branchName);
        if (existingIndex >= 0) {
          // Planning session edges (user-designed) always take priority
          edges[existingIndex] = {
            parent: session.baseBranch,
            child: node.branchName,
            confidence: "high" as const,
            isDesigned: true,
          };
        } else {
          edges.push({
            parent: session.baseBranch,
            child: node.branchName,
            confidence: "high" as const,
            isDesigned: true,
          });
        }
      }
    }
  }

  // 8.5. Merge treeSpec edges LAST (manual edits take highest priority)
  // User-designed edges are trusted - no git ancestry validation needed
  if (treeSpec) {
    console.log(`[Scan] treeSpec found with ${(treeSpec.specJson.edges as Array<unknown>).length} edges`);
    for (const designedEdge of treeSpec.specJson.edges as Array<{ parent: string; child: string }>) {
      console.log(`[Scan] Processing treeSpec edge: ${designedEdge.parent} -> ${designedEdge.child}`);

      // Find and replace existing edge for this child
      // User-designed edges (from branch graph) always take priority over git-inferred edges
      const existingIndex = edges.findIndex((e) => e.child === designedEdge.child);
      if (existingIndex >= 0) {
        const oldParent = edges[existingIndex].parent;
        edges[existingIndex] = {
          parent: designedEdge.parent,
          child: designedEdge.child,
          confidence: "high" as const,
          isDesigned: true,
        };
        console.log(`[Scan] Replaced edge for ${designedEdge.child}: ${oldParent} -> ${designedEdge.parent}`);
      } else {
        edges.push({
          parent: designedEdge.parent,
          child: designedEdge.child,
          confidence: "high" as const,
          isDesigned: true,
        });
        console.log(`[Scan] Added new edge: ${designedEdge.parent} -> ${designedEdge.child}`);
      }
    }
  }

  // Log final edges for debugging
  console.log(`[Scan] Final edges:`, edges.map(e => `${e.parent}->${e.child}(${e.confidence}${e.isDesigned ? ',designed' : ''})`).join(', '));

  // Phase 1: Return immediately without ahead/behind (fast response)
  // Calculate warnings without ahead/behind dependent ones
  const initialWarnings = calculateWarnings(nodes, edges, branchNaming, defaultBranch, treeSpec);
  // Filter out BEHIND_PARENT warnings (they depend on ahead/behind calculation)
  const warningsWithoutBehind = initialWarnings.filter(w => w.code !== "BEHIND_PARENT");

  // Generate restart info for active worktree
  const activeWorktree = worktrees.find((w) => w.branch !== "HEAD");
  const restart = activeWorktree
    ? generateRestartInfo(activeWorktree, nodes, warningsWithoutBehind, branchNaming)
    : null;

  const snapshot: ScanSnapshot = {
    repoId,
    defaultBranch,
    branches: branchNames,
    nodes,
    edges,
    warnings: warningsWithoutBehind,
    worktrees,
    rules: { branchNaming },
    restart,
    ...(treeSpec && { treeSpec }),
  };

  // Broadcast initial scan result (without ahead/behind)
  broadcast({
    type: "scan.updated",
    repoId,
    data: snapshot,
  });

  // Phase 2: Calculate ahead/behind in background
  (async () => {
    try {
      // Calculate ahead/behind based on finalized edges (parent branch, not default)
      calculateAheadBehind(nodes, edges, localPath, defaultBranch);

      // Calculate ahead/behind relative to remote (origin)
      calculateRemoteAheadBehind(nodes, localPath);

      // Recalculate warnings with ahead/behind data (now includes BEHIND_PARENT)
      const fullWarnings = calculateWarnings(nodes, edges, branchNaming, defaultBranch, treeSpec);

      // Broadcast the updated data
      broadcast({
        type: "scan.aheadBehindUpdated",
        repoId,
        data: {
          nodes,
          warnings: fullWarnings,
        },
      });
      console.log(`[Scan] Background ahead/behind calculation completed for ${repoId}`);
    } catch (err) {
      console.warn("[Scan] Background ahead/behind calculation failed:", err);
    }
  })();

  return c.json(snapshot);
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
    gitStatus = execSync(`cd "${targetPath}" && git status --short`, {
      encoding: "utf-8",
    }).trim();
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

  const repoId = getRepoId(localPath);

  try {
    // Step 1: Fetch all remotes
    broadcast({
      type: "fetch.progress",
      repoId,
      data: { step: "fetch", message: "git fetch --all" },
    });

    execSync(`cd "${localPath}" && git fetch --all`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    // Step 2: Get remote tracking status for all branches
    broadcast({
      type: "fetch.progress",
      repoId,
      data: { step: "status", message: "Checking branch status..." },
    });

    const branchStatus: Record<string, { ahead: number; behind: number }> = {};

    try {
      // Get all local branches with their upstream
      const branchOutput = execSync(
        `cd "${localPath}" && git for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads`,
        { encoding: "utf-8" }
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

