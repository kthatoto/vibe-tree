import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { broadcast } from "../ws";
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
  const { repoId, localPath } = input;

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // 1. Get branches
  const branches = getBranches(localPath);

  // 2. Get worktrees with heartbeat
  const worktrees = getWorktrees(localPath);

  // 3. Get PRs with detailed info
  const prs = getPRs(localPath);

  // 4. Build tree (infer parent-child relationships)
  const { nodes, edges } = buildTree(branches, worktrees, prs, localPath);

  // 5. Get branch naming rule
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

  // 6. Get tree spec (設計ツリー)
  const treeSpecs = await db
    .select()
    .from(schema.treeSpecs)
    .where(eq(schema.treeSpecs.repoId, repoId));

  const treeSpec: TreeSpec | undefined = treeSpecs[0]
    ? {
        id: treeSpecs[0].id,
        repoId: treeSpecs[0].repoId,
        specJson: JSON.parse(treeSpecs[0].specJson),
        createdAt: treeSpecs[0].createdAt,
        updatedAt: treeSpecs[0].updatedAt,
      }
    : undefined;

  // 7. Calculate warnings (including tree divergence)
  const warnings = calculateWarnings(nodes, edges, branchNaming, treeSpec);

  // 8. Generate restart info for active worktree
  const activeWorktree = worktrees.find((w) => w.branch !== "HEAD");
  const restart = activeWorktree
    ? generateRestartInfo(activeWorktree, nodes, warnings, branchNaming)
    : null;

  const snapshot: ScanSnapshot = {
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

  const { repoId, localPath } = query;

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
  const targetPath = query.worktreePath ?? localPath;
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
  } catch {
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
    if (worktree?.isActive) badges.push("active");
    if (pr) {
      badges.push(pr.state === "OPEN" ? "pr" : "pr-merged");
      if (pr.isDraft) badges.push("draft");
      if (pr.checks === "FAILURE") badges.push("ci-fail");
      if (pr.checks === "SUCCESS") badges.push("ci-pass");
      if (pr.reviewDecision === "APPROVED") badges.push("approved");
      if (pr.reviewDecision === "CHANGES_REQUESTED") badges.push("changes-requested");
    }

    // Calculate ahead/behind relative to main
    let aheadBehind: { ahead: number; behind: number } | undefined;
    if (mainBranch && branch.name !== mainBranch.name) {
      try {
        const output = execSync(
          `cd "${repoPath}" && git rev-list --left-right --count ${mainBranch.name}...${branch.name}`,
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
  edges: TreeEdge[],
  branchNaming: BranchNamingRule | null,
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
