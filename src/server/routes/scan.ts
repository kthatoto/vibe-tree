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

  // 2. Check if user has saved a preferred base branch in repo_pins
  // Query by localPath (unique) instead of repoId (can change)
  const repoPinRecords = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.localPath, localPath));
  const repoPin = repoPinRecords[0];
  const savedBaseBranch = repoPin?.baseBranch;

  // Update repoId in repo_pins if it has changed (ensures consistency)
  if (repoPin && repoPin.repoId !== repoId) {
    await db
      .update(schema.repoPins)
      .set({ repoId })
      .where(eq(schema.repoPins.id, repoPin.id));
  }

  // 3. Detect default branch dynamically (use saved if available and valid)
  const defaultBranch = savedBaseBranch && branchNames.includes(savedBaseBranch)
    ? savedBaseBranch
    : getDefaultBranch(localPath, branchNames);

  // 3. Get worktrees with heartbeat
  const worktrees = getWorktrees(localPath);

  // 4. Get PRs with detailed info
  const prs = getPRs(localPath);

  // 5. Build tree (infer parent-child relationships)
  const { nodes, edges } = buildTree(branches, worktrees, prs, localPath, defaultBranch);

  // 6. Get branch naming rule
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

  // 7. Get tree spec (タスクツリー)
  const treeSpecs = await db
    .select()
    .from(schema.treeSpecs)
    .where(eq(schema.treeSpecs.repoId, repoId));

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

  // 8. Merge treeSpec edges into scanned edges (designed edges override inferred)
  if (treeSpec) {
    const designedEdgeSet = new Set(
      treeSpec.specJson.edges.map((e: { parent: string; child: string }) => e.child)
    );
    // Remove inferred edges where we have designed ones
    const filteredEdges = edges.filter((e) => !designedEdgeSet.has(e.child));
    // Add designed edges
    for (const designedEdge of treeSpec.specJson.edges) {
      filteredEdges.push({
        parent: designedEdge.parent,
        child: designedEdge.child,
        confidence: "high" as const,
        isDesigned: true,
      });
    }
    edges.length = 0;
    edges.push(...filteredEdges);
  }

  // 8.5. Merge confirmed planning session edges
  const confirmedSessions = await db
    .select()
    .from(schema.planningSessions)
    .where(
      and(
        eq(schema.planningSessions.repoId, repoId),
        eq(schema.planningSessions.status, "confirmed")
      )
    );

  for (const session of confirmedSessions) {
    const sessionNodes = JSON.parse(session.nodesJson) as Array<{
      id: string;
      title: string;
      branchName?: string;
    }>;
    const sessionEdges = JSON.parse(session.edgesJson) as Array<{
      parent: string;
      child: string;
    }>;

    // Build taskId -> branchName map
    const taskToBranch = new Map<string, string>();
    for (const node of sessionNodes) {
      if (node.branchName) {
        taskToBranch.set(node.id, node.branchName);
      }
    }

    // Convert task edges to branch edges
    for (const edge of sessionEdges) {
      const parentBranch = taskToBranch.get(edge.parent);
      const childBranch = taskToBranch.get(edge.child);

      if (parentBranch && childBranch) {
        // Check if this child already has an edge
        const existingIndex = edges.findIndex((e) => e.child === childBranch);
        if (existingIndex >= 0) {
          // Replace with planning session edge (higher priority)
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
        // This is a root task - connect to base branch if not already connected
        const existingIndex = edges.findIndex((e) => e.child === node.branchName);
        if (existingIndex < 0) {
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

  // 9. Calculate warnings (including tree divergence)
  const warnings = calculateWarnings(nodes, edges, branchNaming, defaultBranch, treeSpec);

  // 9. Generate restart info for active worktree
  const activeWorktree = worktrees.find((w) => w.branch !== "HEAD");
  const restart = activeWorktree
    ? generateRestartInfo(activeWorktree, nodes, warnings, branchNaming)
    : null;

  const snapshot: ScanSnapshot = {
    repoId,
    defaultBranch,
    branches: branchNames,
    nodes,
    edges,
    warnings,
    worktrees,
    rules: { branchNaming },
    restart,
    ...(treeSpec && { treeSpec }),
  };

  // Broadcast scan result
  broadcast({
    type: "scan.updated",
    repoId,
    data: snapshot,
  });

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

