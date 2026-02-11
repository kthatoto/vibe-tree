import { homedir } from "os";
import { join } from "path";
import { exec, execSync } from "child_process";
import { promisify } from "util";

// Async exec for non-blocking command execution
const execPromise = promisify(exec);

export async function execAsync(
  command: string,
  options?: { encoding?: BufferEncoding; cwd?: string; shell?: string }
): Promise<string> {
  const { stdout } = await execPromise(command, {
    encoding: options?.encoding ?? "utf-8",
    cwd: options?.cwd,
    shell: options?.shell,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
  });
  return stdout;
}

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
export async function getRepoId(repoPath: string): Promise<string | null> {
  // 1. Try gh CLI first (works for GitHub repos)
  try {
    const output = await execAsync(
      `cd "${repoPath}" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null`
    );
    const trimmed = output.trim();
    if (trimmed) return trimmed;
  } catch {
    // Ignore - try fallback
  }

  // 2. Try git remote origin URL
  try {
    const output = await execAsync(
      `cd "${repoPath}" && git remote get-url origin 2>/dev/null`
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
