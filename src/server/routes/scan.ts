import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { execSync } from "child_process";
import { broadcast } from "../ws";

export const scanRouter = new Hono();

interface BranchInfo {
  name: string;
  commit: string;
  lastCommitAt: string;
}

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  dirty: boolean;
}

interface PRInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  branch: string;
  checks?: string;
}

interface Warning {
  severity: "warn" | "error";
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

interface TreeNode {
  branchName: string;
  badges: string[];
  pr?: PRInfo;
  worktree?: WorktreeInfo;
  lastCommitAt: string;
  aheadBehind?: { ahead: number; behind: number };
}

interface TreeEdge {
  parent: string;
  child: string;
  confidence: "high" | "medium" | "low";
}

// POST /api/scan
scanRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { repoId } = body;

  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  // Get repo
  const repos = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, repoId));

  if (repos.length === 0) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const repo = repos[0];
  const repoPath = repo.path;

  try {
    // 1. Get branches
    const branches = getBranches(repoPath);

    // 2. Get worktrees
    const worktrees = getWorktrees(repoPath);

    // 3. Get PRs
    const prs = getPRs(repoPath);

    // 4. Build tree (infer parent-child relationships)
    const { nodes, edges } = buildTree(branches, worktrees, prs, repoPath);

    // 5. Calculate warnings
    const warnings = calculateWarnings(nodes, edges, repoPath);

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

    const branchNaming =
      rules.length > 0 ? JSON.parse(rules[0].ruleJson) : null;

    // 7. Generate restart info for active worktree
    const activeWorktree = worktrees.find((w) => w.branch !== "HEAD");
    const restart = activeWorktree
      ? {
          worktreePath: activeWorktree.path,
          cdCommand: `cd "${activeWorktree.path}"`,
          restartPromptMd: generateRestartPrompt(
            activeWorktree,
            nodes,
            warnings,
            branchNaming
          ),
        }
      : null;

    const snapshot = {
      nodes,
      edges,
      warnings,
      worktrees,
      rules: { branchNaming },
      restart,
    };

    // Broadcast scan result
    broadcast({
      type: "scan.updated",
      repoId,
      data: snapshot,
    });

    return c.json(snapshot);
  } catch (error) {
    console.error("Scan error:", error);
    return c.json({ error: "Failed to scan repository" }, 500);
  }
});

// GET /api/restart-prompt
scanRouter.get("/restart-prompt", async (c) => {
  const repoId = parseInt(c.req.query("repoId") || "0");
  const planId = parseInt(c.req.query("planId") || "0");
  const worktreePath = c.req.query("worktreePath");

  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  // Get repo
  const repos = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, repoId));

  if (repos.length === 0) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const repo = repos[0];

  // Get plan if provided
  let plan = null;
  if (planId) {
    const plans = await db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, planId));
    plan = plans[0] || null;
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

  const branchNaming = rules.length > 0 ? JSON.parse(rules[0].ruleJson) : null;

  // Get git status for worktree
  let gitStatus = "";
  const targetPath = worktreePath || repo.path;
  try {
    gitStatus = execSync(`cd "${targetPath}" && git status --short`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    gitStatus = "Unable to get git status";
  }

  const prompt = `# Restart Prompt for ${repo.name}

## Project Rules
### Branch Naming
- Pattern: \`${branchNaming?.pattern || "N/A"}\`
- Examples: ${branchNaming?.examples?.join(", ") || "N/A"}

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
        const [name, commit, lastCommitAt] = line.split("|");
        return { name, commit, lastCommitAt };
      });
  } catch {
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
        current = { path: line.replace("worktree ", "") };
      } else if (line.startsWith("HEAD ")) {
        current.commit = line.replace("HEAD ", "");
      } else if (line.startsWith("branch ")) {
        current.branch = line.replace("branch refs/heads/", "");
      }
    }
    if (current.path) worktrees.push(current as WorktreeInfo);

    // Check dirty status for each worktree
    for (const wt of worktrees) {
      try {
        const status = execSync(`cd "${wt.path}" && git status --porcelain`, {
          encoding: "utf-8",
        });
        wt.dirty = status.trim().length > 0;
      } catch {
        wt.dirty = false;
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

function getPRs(repoPath: string): PRInfo[] {
  try {
    const output = execSync(
      `cd "${repoPath}" && gh pr list --json number,title,state,url,headRefName,statusCheckRollup --limit 50`,
      { encoding: "utf-8" }
    );
    const prs = JSON.parse(output);
    return prs.map((pr: Record<string, unknown>) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.url,
      branch: pr.headRefName,
      checks: pr.statusCheckRollup?.[0]?.conclusion || undefined,
    }));
  } catch {
    return [];
  }
}

function buildTree(
  branches: BranchInfo[],
  worktrees: WorktreeInfo[],
  prs: PRInfo[],
  repoPath: string
): { nodes: TreeNode[]; edges: TreeEdge[] } {
  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];

  // Find main/master branch
  const mainBranch = branches.find(
    (b) => b.name === "main" || b.name === "master"
  );

  for (const branch of branches) {
    const worktree = worktrees.find((w) => w.branch === branch.name);
    const pr = prs.find((p) => p.branch === branch.name);

    const badges: string[] = [];
    if (worktree?.dirty) badges.push("dirty");
    if (pr) badges.push(pr.state === "OPEN" ? "pr" : "pr-merged");
    if (pr?.checks === "FAILURE") badges.push("ci-fail");

    // Calculate ahead/behind relative to main
    let aheadBehind: { ahead: number; behind: number } | undefined;
    if (mainBranch && branch.name !== mainBranch.name) {
      try {
        const output = execSync(
          `cd "${repoPath}" && git rev-list --left-right --count ${mainBranch.name}...${branch.name}`,
          { encoding: "utf-8" }
        );
        const [behind, ahead] = output.trim().split(/\s+/).map(Number);
        aheadBehind = { ahead, behind };
      } catch {
        // Ignore errors
      }
    }

    nodes.push({
      branchName: branch.name,
      badges,
      pr,
      worktree,
      lastCommitAt: branch.lastCommitAt,
      aheadBehind,
    });

    // Infer parent relationship using merge-base
    if (mainBranch && branch.name !== mainBranch.name) {
      edges.push({
        parent: mainBranch.name,
        child: branch.name,
        confidence: "medium",
      });
    }
  }

  return { nodes, edges };
}

function calculateWarnings(
  nodes: TreeNode[],
  _edges: TreeEdge[],
  repoPath: string
): Warning[] {
  const warnings: Warning[] = [];

  // Get branch naming rule pattern
  let branchPattern: RegExp | null = null;
  try {
    // This is a simplified check - in production you'd get this from DB
    branchPattern = /^vt\/\d+\/.+$/;
  } catch {
    // Ignore
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
      !node.branchName.match(/^(main|master)$/) &&
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

  return warnings;
}

function generateRestartPrompt(
  worktree: WorktreeInfo,
  nodes: TreeNode[],
  warnings: Warning[],
  branchNaming: { pattern: string; examples: string[] } | null
): string {
  const node = nodes.find((n) => n.branchName === worktree.branch);
  const branchWarnings = warnings.filter(
    (w) => w.meta?.branch === worktree.branch
  );

  return `# Restart Prompt

## Project Rules
### Branch Naming
- Pattern: \`${branchNaming?.pattern || "N/A"}\`
- Examples: ${branchNaming?.examples?.join(", ") || "N/A"}

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
}
