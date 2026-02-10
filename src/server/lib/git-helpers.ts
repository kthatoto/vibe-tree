import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
  BranchNamingRule,
  TreeNode,
  TreeEdge,
  Warning,
  WorktreeInfo,
  PRInfo,
  RestartInfo,
  TreeSpec,
} from "../../shared/types";

export interface BranchInfo {
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
  reviewRequests: { login?: string; name?: string; slug?: string }[]; // User has login, Team has name/slug
  reviews: { author: { login: string }; state: string }[];
  statusCheckRollup?: { conclusion?: string }[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

export function getDefaultBranch(repoPath: string, branchNames: string[]): string {
  // 1. Try to get origin's HEAD (most reliable)
  try {
    const output = execSync(
      `cd "${repoPath}" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
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

export function getBranches(repoPath: string): BranchInfo[] {
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

export function getWorktrees(repoPath: string): WorktreeInfo[] {
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

export function getPRs(repoPath: string): PRInfo[] {
  try {
    const output = execSync(
      `cd "${repoPath}" && gh pr list --state all --json number,title,state,url,headRefName,isDraft,labels,assignees,reviewDecision,reviewRequests,reviews,statusCheckRollup,additions,deletions,changedFiles --limit 50`,
      { encoding: "utf-8" }
    );
    const prs: GhPR[] = JSON.parse(output);
    return prs.map((pr) => {
      // Filter out bot reviewers (e.g., GitHub Copilot)
      const isBot = (name: string | undefined) =>
        name && (name.toLowerCase().includes("copilot") || name.endsWith("[bot]"));

      // Get reviewers - supports both User (login) and Team (name/slug)
      const humanReviewers = (pr.reviewRequests ?? [])
        .map((r) => r.login || r.slug || r.name) // User has login, Team has slug/name
        .filter((name): name is string => !!name && !isBot(name));

      // Check if there are any human reviews submitted (exclude bots)
      const humanReviews = (pr.reviews ?? []).filter(
        (r) => r.author?.login && !isBot(r.author.login)
      );
      const hasReviews = humanReviews.length > 0;

      // Compute review status
      let reviewStatus: "none" | "requested" | "reviewed" | "approved" = "none";
      if (pr.reviewDecision === "APPROVED") {
        reviewStatus = "approved";
      } else if (hasReviews) {
        // Has reviews but not approved (could be CHANGES_REQUESTED or pending)
        reviewStatus = "reviewed";
      } else if (humanReviewers.length > 0) {
        // Reviewers assigned but no reviews yet
        reviewStatus = "requested";
      }

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
        reviewStatus,
        reviewers: humanReviewers,
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

export function findBestParent(
  branchName: string,
  allBranches: string[],
  defaultBranch: string,
  repoPath?: string
): { parent: string; confidence: "high" | "medium" | "low" } {
  let bestMatch = defaultBranch;
  let bestMatchLength = 0;

  // 1. First try naming convention (highest confidence)
  for (const candidate of allBranches) {
    if (candidate === branchName) continue;
    if (candidate === defaultBranch) continue;

    if (
      branchName.startsWith(candidate + "/") ||
      branchName.startsWith(candidate + "-")
    ) {
      if (candidate.length > bestMatchLength) {
        bestMatch = candidate;
        bestMatchLength = candidate.length;
      }
    }
  }

  if (bestMatchLength > 0) {
    return { parent: bestMatch, confidence: "high" };
  }

  // 2. If no naming match, try to find parent by git ancestry
  // The key insight: if branch B was created from branch A, then:
  //   - The tip of A is an ancestor of B
  //   - The commit count from A to B should be minimal compared to other branches
  if (repoPath) {
    try {
      let closestParent = defaultBranch;
      let minDistance = Infinity;

      // First, get the commit count from default branch to this branch
      try {
        const defaultCount = parseInt(
          execSync(
            `cd "${repoPath}" && git rev-list --count "${defaultBranch}..${branchName}" 2>/dev/null || echo "999999"`,
            { encoding: "utf-8" }
          ).trim(),
          10
        );
        if (!isNaN(defaultCount) && defaultCount < minDistance) {
          minDistance = defaultCount;
          closestParent = defaultBranch;
        }
      } catch {
        // Ignore
      }

      for (const candidate of allBranches) {
        if (candidate === branchName) continue;
        if (candidate === defaultBranch) continue;

        try {
          // Find merge-base between candidate and branchName
          const mergeBase = execSync(
            `cd "${repoPath}" && git merge-base "${candidate}" "${branchName}" 2>/dev/null`,
            { encoding: "utf-8" }
          ).trim();

          if (!mergeBase) continue;

          // Get merge-base with default branch
          const defaultMergeBase = execSync(
            `cd "${repoPath}" && git merge-base "${defaultBranch}" "${branchName}" 2>/dev/null`,
            { encoding: "utf-8" }
          ).trim();

          // If merge-base with candidate is same as merge-base with default,
          // then candidate is not a better parent than default
          if (mergeBase === defaultMergeBase) continue;

          // Check if candidate's merge-base is a descendant of default's merge-base
          // (meaning candidate is "closer" to branchName in the tree)
          const isDescendant = execSync(
            `cd "${repoPath}" && git merge-base --is-ancestor "${defaultMergeBase}" "${mergeBase}" 2>/dev/null && echo "yes" || echo "no"`,
            { encoding: "utf-8" }
          ).trim();

          if (isDescendant !== "yes") continue;

          // Count commits from merge-base to branchName
          const count = parseInt(
            execSync(
              `cd "${repoPath}" && git rev-list --count "${mergeBase}..${branchName}" 2>/dev/null`,
              { encoding: "utf-8" }
            ).trim(),
            10
          );

          // Find the candidate with the smallest distance (closest ancestor)
          if (!isNaN(count) && count >= 0 && count < minDistance) {
            minDistance = count;
            closestParent = candidate;
          }
        } catch {
          // Ignore errors for individual branches
        }
      }

      // Only return medium confidence if we found a non-default ancestor
      if (closestParent !== defaultBranch && minDistance < Infinity) {
        return { parent: closestParent, confidence: "medium" };
      }
    } catch {
      // If git commands fail, fall back to default
    }
  }

  return { parent: bestMatch, confidence: "low" };
}

export function buildTree(
  branches: BranchInfo[],
  worktrees: WorktreeInfo[],
  prs: PRInfo[],
  repoPath: string,
  defaultBranch: string
): { nodes: TreeNode[]; edges: TreeEdge[] } {
  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const branchNames = branches.map((b) => b.name);

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

    const node: TreeNode = {
      branchName: branch.name,
      badges,
      lastCommitAt: branch.lastCommitAt,
    };
    if (pr) node.pr = pr;
    if (worktree) node.worktree = worktree;
    nodes.push(node);

    if (baseBranch && branch.name !== defaultBranch) {
      const { parent, confidence } = findBestParent(branch.name, branchNames, defaultBranch, repoPath);
      edges.push({
        parent,
        child: branch.name,
        confidence,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Calculate ahead/behind for each node based on its parent in the edges.
 * This should be called after edges are finalized (including planning session edges).
 */
export function calculateAheadBehind(
  nodes: TreeNode[],
  edges: TreeEdge[],
  repoPath: string,
  defaultBranch: string
): void {
  // Build a map of child -> parent from edges
  const parentMap = new Map<string, string>();
  for (const edge of edges) {
    parentMap.set(edge.child, edge.parent);
  }

  for (const node of nodes) {
    if (node.branchName === defaultBranch) continue;

    const parentBranch = parentMap.get(node.branchName) || defaultBranch;

    try {
      const output = execSync(
        `cd "${repoPath}" && git rev-list --left-right --count "${parentBranch}"..."${node.branchName}"`,
        { encoding: "utf-8" }
      );
      const parts = output.trim().split(/\s+/);
      const behind = parseInt(parts[0] ?? "0", 10);
      const ahead = parseInt(parts[1] ?? "0", 10);
      node.aheadBehind = { ahead, behind };
    } catch {
      // Ignore errors (branch might not exist, etc.)
    }
  }
}

/**
 * Calculate ahead/behind for each node relative to its remote tracking branch (origin).
 */
export function calculateRemoteAheadBehind(
  nodes: TreeNode[],
  repoPath: string
): void {
  for (const node of nodes) {
    try {
      // Check if there's a remote tracking branch
      const upstream = execSync(
        `cd "${repoPath}" && git rev-parse --abbrev-ref "${node.branchName}@{upstream}" 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();

      if (!upstream) continue;

      // Get ahead/behind count relative to upstream
      const output = execSync(
        `cd "${repoPath}" && git rev-list --left-right --count "${upstream}"..."${node.branchName}"`,
        { encoding: "utf-8" }
      );
      const parts = output.trim().split(/\s+/);
      const behind = parseInt(parts[0] ?? "0", 10);
      const ahead = parseInt(parts[1] ?? "0", 10);

      if (ahead > 0 || behind > 0) {
        node.remoteAheadBehind = { ahead, behind };
      }
    } catch {
      // No upstream or error - skip
    }
  }
}

export function calculateWarnings(
  nodes: TreeNode[],
  edges: TreeEdge[],
  branchNaming: BranchNamingRule | null,
  defaultBranch: string,
  treeSpec?: TreeSpec
): Warning[] {
  const warnings: Warning[] = [];

  // Build array of regex patterns from naming rules
  const branchPatterns: RegExp[] = [];
  if (branchNaming?.patterns && branchNaming.patterns.length > 0) {
    for (const pattern of branchNaming.patterns) {
      try {
        // Use pattern directly as regex
        branchPatterns.push(new RegExp(pattern));
      } catch {
        // Ignore invalid regex patterns
      }
    }
  }

  for (const node of nodes) {
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

    if (node.worktree?.dirty) {
      warnings.push({
        severity: "warn",
        code: "DIRTY",
        message: `Worktree for ${node.branchName} has uncommitted changes`,
        meta: { branch: node.branchName, worktree: node.worktree.path },
      });
    }

    if (node.pr?.checks === "FAILURE") {
      warnings.push({
        severity: "error",
        code: "CI_FAIL",
        message: `CI failed for PR #${node.pr.number} (${node.branchName})`,
        meta: { branch: node.branchName, prNumber: node.pr.number },
      });
    }

    // Check branch naming against any of the patterns
    if (
      branchPatterns.length > 0 &&
      node.branchName !== defaultBranch &&
      !branchPatterns.some((pattern) => pattern.test(node.branchName))
    ) {
      warnings.push({
        severity: "warn",
        code: "BRANCH_NAMING_VIOLATION",
        message: `Branch ${node.branchName} does not follow naming convention`,
        meta: { branch: node.branchName },
      });
    }
  }

  if (treeSpec) {
    const gitEdgeSet = new Set(edges.map((e) => `${e.parent}->${e.child}`));

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

export function generateRestartInfo(
  worktree: WorktreeInfo,
  nodes: TreeNode[],
  warnings: Warning[],
  branchNaming: BranchNamingRule | null
): RestartInfo {
  const node = nodes.find((n) => n.branchName === worktree.branch);
  const branchWarnings = warnings.filter(
    (w) => w.meta?.branch === worktree.branch
  );

  const restartPromptMd = `# Restart Prompt

## Project Rules
### Branch Naming
- Patterns: ${branchNaming?.patterns?.map(p => `\`${p}\``).join(", ") ?? "N/A"}

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
