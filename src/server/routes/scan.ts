import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { broadcast } from "../ws";
import { expandTilde, getRepoId } from "../utils";
import {
  scanSchema,
  restartPromptQuerySchema,
  validateOrThrow,
} from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";
import type {
  BranchNamingRule,
  TreeNode,
  TreeEdge,
  Warning,
  WorktreeInfo,
  PRInfo,
  ScanSnapshot,
  TreeSpec,
} from "../../shared/types";

interface BranchInfo {
  name: string;
  commit: string;
  lastCommitAt: string;
}

interface GhPR {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  labels: { name: string }[];
  assignees: { login: string }[];
  reviewDecision: string;
  statusCheckRollup?: { conclusion?: string }[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

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

  // 2. Detect default branch dynamically
  const defaultBranch = getDefaultBranch(localPath, branchNames);

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

function getDefaultBranch(repoPath: string, branchNames: string[]): string {
  // 1. Try to get origin's HEAD (most reliable)
  try {
    const output = execSync(
      `cd "${repoPath}" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
    // output is like "refs/remotes/origin/main"
    const match = output.match(/refs\/remotes\/origin\/(.+)$/);
    if (match && match[1] && branchNames.includes(match[1])) {
      return match[1];
    }
  } catch {
    // Ignore - try fallback methods
  }

  // 2. Try gh repo view to get default branch
  try {
    const output = execSync(
      `cd "${repoPath}" && gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`,
      { encoding: "utf-8" }
    ).trim();
    if (output && branchNames.includes(output)) {
      return output;
    }
  } catch {
    // Ignore - try fallback methods
  }

  // 3. Fallback priority: develop > main > master
  if (branchNames.includes("develop")) return "develop";
  if (branchNames.includes("main")) return "main";
  if (branchNames.includes("master")) return "master";

  // 4. Last resort: first branch or empty
  return branchNames[0] ?? "main";
}

function getBranches(repoPath: string): BranchInfo[] {
  try {
    const output = execSync(
      `cd "${repoPath}" && git for-each-ref --sort=-committerdate --format='%(refname:short)|%(objectname:short)|%(committerdate:iso8601)' refs/heads/`,
      { encoding: "utf-8" }
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        return {
          name: parts[0] ?? "",
          commit: parts[1] ?? "",
          lastCommitAt: parts[2] ?? "",
        };
      });
  } catch (err) {
    console.error("getBranches error:", err);
    return [];
  }
}

function getWorktrees(repoPath: string): WorktreeInfo[] {
  try {
    const output = execSync(
      `cd "${repoPath}" && git worktree list --porcelain`,
      { encoding: "utf-8" }
    );
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as WorktreeInfo);
        current = { path: line.replace("worktree ", ""), dirty: false };
      } else if (line.startsWith("HEAD ")) {
        current.commit = line.replace("HEAD ", "");
      } else if (line.startsWith("branch ")) {
        current.branch = line.replace("branch refs/heads/", "");
      }
    }
    if (current.path) worktrees.push(current as WorktreeInfo);

    // Check dirty status and heartbeat for each worktree
    for (const wt of worktrees) {
      try {
        const status = execSync(`cd "${wt.path}" && git status --porcelain`, {
          encoding: "utf-8",
        });
        wt.dirty = status.trim().length > 0;
      } catch {
        wt.dirty = false;
      }

      // Check heartbeat
      const heartbeatPath = join(wt.path, ".vibetree", "heartbeat.json");
      if (existsSync(heartbeatPath)) {
        try {
          const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf-8"));
          const lastUpdate = new Date(heartbeat.updatedAt).getTime();
          const now = Date.now();
          // Active if updated within last 30 seconds
          if (now - lastUpdate < 30000) {
            wt.isActive = true;
            wt.activeAgent = heartbeat.agent;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    return worktrees;
  } catch (err) {
    console.error("getWorktrees error:", err);
    return [];
  }
}

function getPRs(repoPath: string): PRInfo[] {
  try {
    const output = execSync(
      `cd "${repoPath}" && gh pr list --json number,title,state,url,headRefName,isDraft,labels,assignees,reviewDecision,statusCheckRollup,additions,deletions,changedFiles --limit 50`,
      { encoding: "utf-8" }
    );
    const prs: GhPR[] = JSON.parse(output);
    return prs.map((pr) => {
      const prInfo: PRInfo = {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.url,
        branch: pr.headRefName,
        isDraft: pr.isDraft,
        labels: pr.labels?.map((l) => l.name) ?? [],
        assignees: pr.assignees?.map((a) => a.login) ?? [],
        reviewDecision: pr.reviewDecision,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
      };
      const conclusion = pr.statusCheckRollup?.[0]?.conclusion;
      if (conclusion) {
        prInfo.checks = conclusion;
      }
      return prInfo;
    });
  } catch (err) {
    console.error("getPRs error:", err);
    return [];
  }
}

function findBestParent(
  branchName: string,
  allBranches: string[],
  defaultBranch: string
): { parent: string; confidence: "high" | "medium" | "low" } {
  // Check if branch name starts with another branch name
  // e.g., "feature/auth-login" starts with "feature/auth"
  let bestMatch = defaultBranch;
  let bestMatchLength = 0;

  for (const candidate of allBranches) {
    if (candidate === branchName) continue;
    if (candidate === defaultBranch) continue;

    // Check if branchName starts with candidate + separator
    if (
      branchName.startsWith(candidate + "/") ||
      branchName.startsWith(candidate + "-")
    ) {
      // Prefer longer matches (more specific parent)
      if (candidate.length > bestMatchLength) {
        bestMatch = candidate;
        bestMatchLength = candidate.length;
      }
    }
  }

  // If we found a prefix match, it's high confidence
  // Otherwise fallback to default branch with low confidence
  const confidence = bestMatchLength > 0 ? "high" : "low";
  return { parent: bestMatch, confidence };
}

function buildTree(
  branches: BranchInfo[],
  worktrees: WorktreeInfo[],
  prs: PRInfo[],
  repoPath: string,
  defaultBranch: string
): { nodes: TreeNode[]; edges: TreeEdge[] } {
  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const branchNames = branches.map((b) => b.name);

  // Find default branch info
  const baseBranch = branches.find((b) => b.name === defaultBranch);

  for (const branch of branches) {
    const worktree = worktrees.find((w) => w.branch === branch.name);
    const pr = prs.find((p) => p.branch === branch.name);

    const badges: string[] = [];
    if (worktree?.dirty) badges.push("dirty");
    if (worktree?.isActive) badges.push("active");
    if (pr) {
      badges.push(pr.state === "OPEN" ? "pr" : "pr-merged");
      if (pr.isDraft) badges.push("draft");
      if (pr.checks === "FAILURE") badges.push("ci-fail");
      if (pr.checks === "SUCCESS") badges.push("ci-pass");
      if (pr.reviewDecision === "APPROVED") badges.push("approved");
      if (pr.reviewDecision === "CHANGES_REQUESTED") badges.push("changes-requested");
    }

    // Calculate ahead/behind relative to default branch
    let aheadBehind: { ahead: number; behind: number } | undefined;
    if (baseBranch && branch.name !== defaultBranch) {
      try {
        const output = execSync(
          `cd "${repoPath}" && git rev-list --left-right --count ${defaultBranch}...${branch.name}`,
          { encoding: "utf-8" }
        );
        const parts = output.trim().split(/\s+/);
        const behind = parseInt(parts[0] ?? "0", 10);
        const ahead = parseInt(parts[1] ?? "0", 10);
        aheadBehind = { ahead, behind };
      } catch {
        // Ignore errors
      }
    }

    const node: TreeNode = {
      branchName: branch.name,
      badges,
      lastCommitAt: branch.lastCommitAt,
    };
    if (pr) node.pr = pr;
    if (worktree) node.worktree = worktree;
    if (aheadBehind) node.aheadBehind = aheadBehind;
    nodes.push(node);

    // Find best parent for this branch
    if (baseBranch && branch.name !== defaultBranch) {
      const { parent, confidence } = findBestParent(branch.name, branchNames, defaultBranch);
      edges.push({
        parent,
        child: branch.name,
        confidence,
      });
    }
  }

  return { nodes, edges };
}

function calculateWarnings(
  nodes: TreeNode[],
  edges: TreeEdge[],
  branchNaming: BranchNamingRule | null,
  defaultBranch: string,
  treeSpec?: TreeSpec
): Warning[] {
  const warnings: Warning[] = [];

  // Create pattern from branch naming rule
  let branchPattern: RegExp | null = null;
  if (branchNaming?.pattern) {
    try {
      const regexStr = branchNaming.pattern
        .replace(/\{planId\}/g, "\\d+")
        .replace(/\{taskSlug\}/g, "[a-z0-9-]+");
      branchPattern = new RegExp(`^${regexStr}$`);
    } catch {
      // Ignore invalid patterns
    }
  }

  for (const node of nodes) {
    // BEHIND_PARENT
    if (node.aheadBehind) {
      if (node.aheadBehind.behind >= 5) {
        warnings.push({
          severity: "error",
          code: "BEHIND_PARENT",
          message: `Branch ${node.branchName} is ${node.aheadBehind.behind} commits behind`,
          meta: { branch: node.branchName, behind: node.aheadBehind.behind },
        });
      } else if (node.aheadBehind.behind >= 1) {
        warnings.push({
          severity: "warn",
          code: "BEHIND_PARENT",
          message: `Branch ${node.branchName} is ${node.aheadBehind.behind} commits behind`,
          meta: { branch: node.branchName, behind: node.aheadBehind.behind },
        });
      }
    }

    // DIRTY
    if (node.worktree?.dirty) {
      warnings.push({
        severity: "warn",
        code: "DIRTY",
        message: `Worktree for ${node.branchName} has uncommitted changes`,
        meta: { branch: node.branchName, worktree: node.worktree.path },
      });
    }

    // CI_FAIL
    if (node.pr?.checks === "FAILURE") {
      warnings.push({
        severity: "error",
        code: "CI_FAIL",
        message: `CI failed for PR #${node.pr.number} (${node.branchName})`,
        meta: { branch: node.branchName, prNumber: node.pr.number },
      });
    }

    // BRANCH_NAMING_VIOLATION
    if (
      branchPattern &&
      node.branchName !== defaultBranch &&
      !branchPattern.test(node.branchName)
    ) {
      warnings.push({
        severity: "warn",
        code: "BRANCH_NAMING_VIOLATION",
        message: `Branch ${node.branchName} does not follow naming convention`,
        meta: { branch: node.branchName },
      });
    }
  }

  // TREE_DIVERGENCE: Check if design tree matches git reality
  if (treeSpec) {
    const gitEdgeSet = new Set(edges.map((e) => `${e.parent}->${e.child}`));

    // Check for edges in design but not in git
    for (const edge of treeSpec.specJson.edges) {
      const key = `${edge.parent}->${edge.child}`;
      if (!gitEdgeSet.has(key)) {
        warnings.push({
          severity: "warn",
          code: "TREE_DIVERGENCE",
          message: `Design tree has ${edge.parent} -> ${edge.child} but git doesn't match`,
          meta: { parent: edge.parent, child: edge.child, type: "missing_in_git" },
        });
      }
    }
  }

  return warnings;
}

function generateRestartInfo(
  worktree: WorktreeInfo,
  nodes: TreeNode[],
  warnings: Warning[],
  branchNaming: BranchNamingRule | null
): ScanSnapshot["restart"] {
  const node = nodes.find((n) => n.branchName === worktree.branch);
  const branchWarnings = warnings.filter(
    (w) => w.meta?.branch === worktree.branch
  );

  const restartPromptMd = `# Restart Prompt

## Project Rules
### Branch Naming
- Pattern: \`${branchNaming?.pattern ?? "N/A"}\`
- Examples: ${branchNaming?.examples?.join(", ") ?? "N/A"}

## Current State
- Branch: \`${worktree.branch}\`
- Worktree: \`${worktree.path}\`
- Dirty: ${worktree.dirty ? "Yes (uncommitted changes)" : "No"}
${node?.aheadBehind ? `- Behind: ${node.aheadBehind.behind} commits` : ""}

## Warnings
${branchWarnings.length > 0 ? branchWarnings.map((w) => `- [${w.severity.toUpperCase()}] ${w.message}`).join("\n") : "No warnings"}

## Next Steps
${
  branchWarnings.length > 0
    ? branchWarnings
        .slice(0, 3)
        .map((w, i) => `${i + 1}. Address: ${w.message}`)
        .join("\n")
    : "1. Continue working on your current task"
}

---
*Paste this prompt into Claude Code to continue your session.*
`;

  return {
    worktreePath: worktree.path,
    cdCommand: `cd "${worktree.path}"`,
    restartPromptMd,
  };
}
