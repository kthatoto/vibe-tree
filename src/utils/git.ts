import { execAsync } from "../server/utils";

/**
 * Check if a branch exists in the repository.
 */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    const output = (await execAsync(
      `cd "${repoPath}" && git branch --list "${branch}"`
    )).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a worktree exists for a given branch.
 */
export async function worktreeExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    const output = await execAsync(
      `cd "${repoPath}" && git worktree list --porcelain`
    );
    // Parse worktree list output to find matching branch
    const lines = output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("branch refs/heads/")) {
        const worktreeBranch = lines[i].replace("branch refs/heads/", "");
        if (worktreeBranch === branch) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the worktree path for a given branch, or null if no worktree exists.
 */
export async function getWorktreePath(repoPath: string, branch: string): Promise<string | null> {
  try {
    const output = await execAsync(
      `cd "${repoPath}" && git worktree list --porcelain`
    );
    const lines = output.split("\n");
    let currentPath: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.replace("worktree ", "");
      } else if (line.startsWith("branch refs/heads/")) {
        const worktreeBranch = line.replace("branch refs/heads/", "");
        if (worktreeBranch === branch && currentPath) {
          return currentPath;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the default branch of a repository.
 * Tries origin/HEAD, then gh repo view, then falls back to common defaults.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  // 1. Try to get origin's HEAD (most reliable)
  try {
    const output = (await execAsync(
      `cd "${repoPath}" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`
    )).trim();
    const match = output.match(/refs\/remotes\/origin\/(.+)$/);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // Ignore - try fallback methods
  }

  // 2. Try gh repo view to get default branch
  try {
    const output = (await execAsync(
      `cd "${repoPath}" && gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`
    )).trim();
    if (output) {
      return output;
    }
  } catch {
    // Ignore - try fallback methods
  }

  // 3. Check for common default branch names
  if (await branchExists(repoPath, "main")) return "main";
  if (await branchExists(repoPath, "master")) return "master";
  if (await branchExists(repoPath, "develop")) return "develop";

  // 4. Last resort
  return "main";
}

/**
 * Remove a worktree for a given branch.
 * Returns true if successful, false otherwise.
 */
export async function removeWorktree(repoPath: string, branch: string): Promise<boolean> {
  const worktreePath = await getWorktreePath(repoPath, branch);
  if (!worktreePath) {
    return false;
  }

  try {
    // Use --force to handle dirty worktrees
    await execAsync(
      `cd "${repoPath}" && git worktree remove "${worktreePath}" --force`
    );
    return true;
  } catch {
    return false;
  }
}
