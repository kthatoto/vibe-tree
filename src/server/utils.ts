import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

// Expand ~ to home directory
export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

// Get repo ID from local path using gh CLI or git remote
export function getRepoId(repoPath: string): string | null {
  // 1. Try gh CLI first (works for GitHub repos)
  try {
    const output = execSync(
      `cd "${repoPath}" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null`,
      { encoding: "utf-8" }
    );
    const trimmed = output.trim();
    if (trimmed) return trimmed;
  } catch {
    // Ignore - try fallback
  }

  // 2. Try git remote origin URL
  try {
    const output = execSync(
      `cd "${repoPath}" && git remote get-url origin 2>/dev/null`,
      { encoding: "utf-8" }
    );
    const url = output.trim();
    // Parse GitHub URL: git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match && match[1]) return match[1];
  } catch {
    // Ignore - try fallback
  }

  // 3. Fallback: use folder name as local repo ID
  try {
    const folderName = repoPath.split("/").filter(Boolean).pop();
    if (folderName) {
      return `local/${folderName}`;
    }
  } catch {
    // Ignore
  }

  return null;
}
