import { Hono } from "hono";
import { exec } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, basename, join } from "path";
import { randomUUID } from "crypto";
import { eq, and, ne } from "drizzle-orm";
import { expandTilde, getRepoId, execAsync } from "../utils";
import { createBranchSchema, createTreeSchema, validateOrThrow } from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";
import { db, schema } from "../../db";
import type { WorktreeSettings } from "../../shared/types";
import { getWorktreePath, removeWorktree } from "../../utils/git";

// Helper to get worktree settings for a repo
async function getWorktreeSettings(repoId: string): Promise<WorktreeSettings> {
  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "worktree"),
        eq(schema.projectRules.isActive, true)
      )
    );

  if (!rules[0]) {
    return { createScript: "", postCreateScript: "", postDeleteScript: "", checkoutPreference: "main" };
  }

  return JSON.parse(rules[0].ruleJson) as WorktreeSettings;
}

// Helper to run post-creation script (async, fire-and-forget for UI responsiveness)
function runPostCreateScript(worktreePath: string, script: string): void {
  if (!script || !script.trim()) return;

  console.log(`[Worktree] Running post-create script in ${worktreePath}`);

  exec(`cd "${worktreePath}" && ${script}`, { shell: "/bin/bash" }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Worktree] Post-create script failed:`, error.message);
      if (stderr) console.error(`[Worktree] stderr:`, stderr);
    } else {
      console.log(`[Worktree] Post-create script completed successfully`);
      if (stdout) console.log(`[Worktree] stdout:`, stdout);
    }
  });
}

// Helper to run post-deletion script (async, fire-and-forget for UI responsiveness)
function runPostDeleteScript(localPath: string, script: string): void {
  if (!script || !script.trim()) return;

  console.log(`[Worktree] Running post-delete script in ${localPath}`);

  exec(`cd "${localPath}" && ${script}`, { shell: "/bin/bash" }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Worktree] Post-delete script failed:`, error.message);
      if (stderr) console.error(`[Worktree] stderr:`, stderr);
    } else {
      console.log(`[Worktree] Post-delete script completed successfully`);
      if (stdout) console.log(`[Worktree] stdout:`, stdout);
    }
  });
}

// Helper to run custom worktree command with placeholder replacement
// Placeholders: {repo}, {branch}, {path}
function runCustomCommand(
  command: string,
  context: { repoId: string; branchName: string; worktreePath: string },
  label: string
): void {
  if (!command || !command.trim()) return;

  // Replace placeholders
  const repoName = context.repoId.split("/").pop() || context.repoId;
  const resolvedCommand = command
    .replace(/\{repo\}/g, repoName)
    .replace(/\{branch\}/g, context.branchName)
    .replace(/\{path\}/g, context.worktreePath);

  console.log(`[Worktree] Running ${label}: ${resolvedCommand}`);

  exec(resolvedCommand, { shell: "/bin/bash" }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Worktree] ${label} failed:`, error.message);
      if (stderr) console.error(`[Worktree] stderr:`, stderr);
    } else {
      console.log(`[Worktree] ${label} completed successfully`);
      if (stdout) console.log(`[Worktree] stdout:`, stdout);
    }
  });
}

// Helper to find worktree path for a branch from git worktree list
async function findWorktreePathForBranch(localPath: string, branchName: string): Promise<string | null> {
  try {
    const output = await execAsync(
      `cd "${localPath}" && git worktree list --porcelain`
    );

    // Parse porcelain output: worktree path, HEAD sha, branch name
    const lines = output.trim().split("\n");
    let currentWorktree: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentWorktree = line.substring(9); // Remove "worktree " prefix
      } else if (line.startsWith("branch refs/heads/")) {
        const wtBranch = line.substring(18); // Remove "branch refs/heads/" prefix
        if (wtBranch === branchName && currentWorktree) {
          return currentWorktree;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Helper to create worktree with optional custom script
// Returns the actual worktree path (may differ from input if custom script is used)
async function createWorktreeWithScript(
  localPath: string,
  fallbackWorktreePath: string,
  branchName: string,
  createScript?: string
): Promise<string> {
  if (createScript && createScript.trim()) {
    // Replace placeholders in custom script
    const script = createScript
      .replace(/\{worktreePath\}/g, fallbackWorktreePath)
      .replace(/\{branchName\}/g, branchName)
      .replace(/\{localPath\}/g, localPath);

    await execAsync(`cd "${localPath}" && ${script}`, { shell: "/bin/bash" });

    // After custom script, find actual worktree path from git
    const actualPath = await findWorktreePathForBranch(localPath, branchName);
    if (actualPath) {
      return actualPath;
    }
    // Fallback to expected path if not found (script might use different branch name)
    return fallbackWorktreePath;
  } else {
    // Default worktree creation
    await execAsync(
      `cd "${localPath}" && git worktree add "${fallbackWorktreePath}" "${branchName}"`
    );
    return fallbackWorktreePath;
  }
}

export const branchRouter = new Hono();

// POST /api/branch/create
branchRouter.post("/create", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createBranchSchema, body);
  const localPath = expandTilde(input.localPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Validate branch name (no spaces, special chars)
  const branchNameRegex = /^[a-zA-Z0-9/_-]+$/;
  if (!branchNameRegex.test(input.branchName)) {
    throw new BadRequestError(
      `Invalid branch name: ${input.branchName}. Use only alphanumeric, /, _, -`
    );
  }

  // Check if branch already exists
  try {
    const existingBranches = (await execAsync(
      `cd "${localPath}" && git branch --list "${input.branchName}"`
    )).trim();
    if (existingBranches) {
      throw new BadRequestError(`Branch already exists: ${input.branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    // Ignore other errors (git command issues)
  }

  // Create the branch
  try {
    await execAsync(
      `cd "${localPath}" && git branch "${input.branchName}" "${input.baseBranch}"`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(`Failed to create branch: ${message}`);
  }

  return c.json({
    success: true,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
  });
});

interface TaskResult {
  taskId: string;
  branchName: string;
  worktreePath: string;
  chatSessionId: string;
  prUrl?: string;
  prNumber?: number;
  success: boolean;
  error?: string;
}

// Check if PR already exists for branch
async function getExistingPr(localPath: string, branchName: string): Promise<{ url: string; number: number } | null> {
  try {
    const result = (await execAsync(
      `cd "${localPath}" && gh pr view "${branchName}" --json url,number 2>/dev/null || true`
    )).trim();
    if (result) {
      const pr = JSON.parse(result);
      return { url: pr.url, number: pr.number };
    }
  } catch {
    // No existing PR
  }
  return null;
}

// Create PR for branch
async function createPr(
  localPath: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<{ url: string; number: number }> {
  // First push the branch
  await execAsync(`cd "${localPath}" && git push -u origin "${branchName}"`);

  // Create PR
  const result = (await execAsync(
    `cd "${localPath}" && gh pr create --head "${branchName}" --base "${baseBranch}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --json url,number`
  )).trim();

  const pr = JSON.parse(result);
  return { url: pr.url, number: pr.number };
}

// POST /api/branch/create-tree - Batch create branches + worktrees + chat sessions
branchRouter.post("/create-tree", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createTreeSchema, body);
  const localPath = expandTilde(input.localPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Determine worktrees parent directory: {repo}-worktrees
  const repoName = basename(localPath);
  const parentDir = dirname(localPath);
  const worktreesDir = join(parentDir, `${repoName}-worktrees`);

  // Create worktrees directory if it doesn't exist
  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  const results: TaskResult[] = [];
  const now = new Date().toISOString();

  for (const task of input.tasks) {
    const result: TaskResult = {
      taskId: task.id,
      branchName: task.branchName,
      worktreePath: join(worktreesDir, task.worktreeName),
      chatSessionId: "",
      success: false,
    };

    try {
      // Validate branch name
      const branchNameRegex = /^[a-zA-Z0-9/_-]+$/;
      if (!branchNameRegex.test(task.branchName)) {
        throw new Error(`Invalid branch name: ${task.branchName}`);
      }

      // Check if branch already exists
      const existingBranches = (await execAsync(
        `cd "${localPath}" && git branch --list "${task.branchName}"`
      )).trim();

      // Create branch if it doesn't exist
      if (!existingBranches) {
        await execAsync(
          `cd "${localPath}" && git branch "${task.branchName}" "${task.parentBranch}"`
        );
      }

      // Check if worktree already exists for this branch
      const existingWorktreePath = await findWorktreePathForBranch(localPath, task.branchName);
      if (existingWorktreePath) {
        // Worktree already exists, use actual path
        result.worktreePath = existingWorktreePath;
        console.log(`Worktree already exists: ${result.worktreePath}`);
      } else {
        // Create worktree with optional custom script
        const wtSettings = await getWorktreeSettings(input.repoId);
        const actualPath = await createWorktreeWithScript(localPath, result.worktreePath, task.branchName, wtSettings.createScript);
        result.worktreePath = actualPath;

        // Run post-creation script if configured
        if (wtSettings.postCreateScript) {
          runPostCreateScript(result.worktreePath, wtSettings.postCreateScript);
        }

        // Run custom worktree create command if configured
        if (wtSettings.worktreeCreateCommand) {
          runCustomCommand(wtSettings.worktreeCreateCommand, {
            repoId: input.repoId,
            branchName: task.branchName,
            worktreePath: result.worktreePath,
          }, "worktreeCreateCommand");
        }
      }

      // Create chat session for this worktree
      const sessionId = randomUUID();
      await db.insert(schema.chatSessions).values({
        id: sessionId,
        repoId: input.repoId,
        worktreePath: result.worktreePath,
        branchName: task.branchName,
        planId: null,
        status: "active",
        lastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      result.chatSessionId = sessionId;

      // Create PR if requested
      if (input.createPrs) {
        try {
          // Check for existing PR
          const existingPr = await getExistingPr(localPath, task.branchName);
          if (existingPr) {
            result.prUrl = existingPr.url;
            result.prNumber = existingPr.number;
            console.log(`PR already exists for ${task.branchName}: ${existingPr.url}`);
          } else {
            // Create new PR
            const prTitle = task.title || task.branchName;
            const prBody = [
              task.description ? `## Task\n${task.description}` : "",
              `## Branch\n\`${task.branchName}\``,
              `## Base\n\`${task.parentBranch}\``,
              "",
              "---",
              "*Created by VibeTree*",
            ]
              .filter(Boolean)
              .join("\n");

            const pr = await createPr(
              localPath,
              task.branchName,
              task.parentBranch,
              prTitle,
              prBody
            );
            result.prUrl = pr.url;
            result.prNumber = pr.number;
            console.log(`Created PR for ${task.branchName}: ${pr.url}`);

            // Save PR link to branchLinks
            await db.insert(schema.branchLinks).values({
              repoId: input.repoId,
              branchName: task.branchName,
              linkType: "pr",
              url: pr.url,
              number: pr.number,
              title: prTitle,
              status: "open",
              createdAt: now,
              updatedAt: now,
            });
          }
        } catch (prErr) {
          // PR creation failed but branch/worktree succeeded
          console.error(`Failed to create PR for ${task.branchName}:`, prErr);
          // Don't fail the whole task, just log the error
        }
      }

      result.success = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`Failed to create tree for task ${task.id}:`, result.error);
    }

    results.push(result);
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  // Update tree spec status to "generated" if all succeeded
  if (successCount > 0) {
    const updateNow = new Date().toISOString();
    await db
      .update(schema.treeSpecs)
      .set({ status: "generated", updatedAt: updateNow })
      .where(eq(schema.treeSpecs.repoId, input.repoId));
  }

  return c.json({
    success: failCount === 0,
    worktreesDir,
    results,
    summary: {
      total: results.length,
      success: successCount,
      failed: failCount,
    },
  });
});

// POST /api/branch/create-worktree - Create worktree for an existing branch
branchRouter.post("/create-worktree", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName } = body;

  if (!rawLocalPath || !branchName) {
    throw new BadRequestError("localPath and branchName are required");
  }

  const localPath = expandTilde(rawLocalPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Check if branch exists
  try {
    const existingBranches = (await execAsync(
      `cd "${localPath}" && git branch --list "${branchName}"`
    )).trim();
    if (!existingBranches) {
      throw new BadRequestError(`Branch does not exist: ${branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Create worktrees directory
  const repoName = basename(localPath);
  const parentDir = dirname(localPath);
  const worktreesDir = join(parentDir, `${repoName}-worktrees`);
  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  // Check if worktree already exists for this branch
  const existingWorktreePath = await findWorktreePathForBranch(localPath, branchName);
  if (existingWorktreePath) {
    // Worktree already exists, return actual path
    return c.json({
      worktreePath: existingWorktreePath,
      branchName,
      alreadyExists: true,
    });
  }

  // Create worktree
  const worktreeName = branchName.replace(/\//g, "-");
  const fallbackWorktreePath = join(worktreesDir, worktreeName);

  let actualWorktreePath: string;
  try {
    // Get worktree settings
    const repoId = await getRepoId(localPath);
    const wtSettings = await getWorktreeSettings(repoId ?? "");

    // Create worktree with optional custom script
    actualWorktreePath = await createWorktreeWithScript(localPath, fallbackWorktreePath, branchName, wtSettings.createScript);

    // Run post-creation script if configured
    if (wtSettings.postCreateScript) {
      runPostCreateScript(actualWorktreePath, wtSettings.postCreateScript);
    }

    // Run custom worktree create command if configured
    if (wtSettings.worktreeCreateCommand && repoId) {
      runCustomCommand(wtSettings.worktreeCreateCommand, {
        repoId,
        branchName,
        worktreePath: actualWorktreePath,
      }, "worktreeCreateCommand");
    }
  } catch (err) {
    throw new BadRequestError(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
  }

  return c.json({
    worktreePath: actualWorktreePath,
    branchName,
    alreadyExists: false,
  });
});

// POST /api/branch/checkout - Checkout to a branch
branchRouter.post("/checkout", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName } = body;

  if (!rawLocalPath || !branchName) {
    throw new BadRequestError("localPath and branchName are required");
  }

  const localPath = expandTilde(rawLocalPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Check if branch exists
  try {
    const existingBranches = (await execAsync(
      `cd "${localPath}" && git branch --list "${branchName}"`
    )).trim();
    if (!existingBranches) {
      throw new BadRequestError(`Branch does not exist: ${branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check for uncommitted changes
  try {
    const status = (await execAsync(
      `cd "${localPath}" && git status --porcelain`
    )).trim();
    if (status) {
      throw new BadRequestError("Cannot checkout: you have uncommitted changes. Please commit or stash them first.");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Checkout
  try {
    await execAsync(
      `cd "${localPath}" && git checkout "${branchName}"`
    );
  } catch (err) {
    throw new BadRequestError(`Failed to checkout: ${err instanceof Error ? err.message : String(err)}`);
  }

  return c.json({
    success: true,
    branchName,
  });
});

// POST /api/branch/pull - Pull latest changes for a branch
branchRouter.post("/pull", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName, worktreePath: rawWorktreePath } = body;

  if (!rawLocalPath || !branchName) {
    throw new BadRequestError("localPath and branchName are required");
  }

  const localPath = expandTilde(rawLocalPath);
  const worktreePath = rawWorktreePath ? expandTilde(rawWorktreePath) : null;

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Determine which path to use for pull
  let pullPath: string | null = null;

  if (worktreePath && existsSync(worktreePath)) {
    // Use worktree path directly
    pullPath = worktreePath;
  } else {
    // Check if the main repo is on this branch
    try {
      const currentBranch = (await execAsync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`
      )).trim();
      if (currentBranch === branchName) {
        pullPath = localPath;
      }
    } catch {
      // Ignore
    }
  }

  // If not checked out, try fast-forward fetch
  if (!pullPath) {
    try {
      // Use git fetch origin branchname:branchname for fast-forward update
      const output = await execAsync(
        `cd "${localPath}" && git fetch origin "${branchName}:${branchName}"`
      );
      return c.json({
        success: true,
        branchName,
        output: output.trim() || "Fast-forward updated",
        method: "fetch",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If fast-forward fails (e.g., diverged), suggest checkout
      if (message.includes("non-fast-forward") || message.includes("rejected")) {
        throw new BadRequestError(
          `Cannot fast-forward: branch "${branchName}" has diverged. Please checkout and merge manually.`
        );
      }
      throw new BadRequestError(`Failed to update branch: ${message}`);
    }
  }

  // Check for uncommitted changes
  try {
    const status = (await execAsync(
      `cd "${pullPath}" && git status --porcelain`
    )).trim();
    if (status) {
      throw new BadRequestError(
        "Cannot pull: you have uncommitted changes. Please commit or stash them first."
      );
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Pull
  try {
    const output = await execAsync(
      `cd "${pullPath}" && git pull`
    );
    return c.json({
      success: true,
      branchName,
      output: output.trim(),
      method: "pull",
    });
  } catch (err) {
    throw new BadRequestError(`Failed to pull: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// POST /api/branch/rebase - Rebase branch onto its parent
branchRouter.post("/rebase", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName, parentBranch, worktreePath: rawWorktreePath } = body;

  if (!rawLocalPath || !branchName || !parentBranch) {
    throw new BadRequestError("localPath, branchName, and parentBranch are required");
  }

  const localPath = expandTilde(rawLocalPath);
  const worktreePath = rawWorktreePath ? expandTilde(rawWorktreePath) : null;

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Determine which path to use for rebase
  let rebasePath: string | null = null;
  let needsCheckout = false;
  let originalBranch: string | null = null;

  if (worktreePath && existsSync(worktreePath)) {
    rebasePath = worktreePath;
  } else {
    // Check if the main repo is on this branch
    try {
      const currentBranch = (await execAsync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`
      )).trim();
      if (currentBranch === branchName) {
        rebasePath = localPath;
      } else {
        // Need to temporarily checkout the branch
        originalBranch = currentBranch;
        needsCheckout = true;
        rebasePath = localPath;
      }
    } catch {
      // Ignore
    }
  }

  if (!rebasePath) {
    throw new BadRequestError(`Branch "${branchName}" must be checked out to rebase`);
  }

  // Check for uncommitted changes
  try {
    const status = (await execAsync(
      `cd "${rebasePath}" && git status --porcelain`
    )).trim();
    if (status) {
      throw new BadRequestError("Cannot rebase: you have uncommitted changes. Please commit or stash them first.");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Checkout target branch if needed
  if (needsCheckout) {
    try {
      await execAsync(`cd "${rebasePath}" && git checkout "${branchName}"`);
    } catch (err) {
      throw new BadRequestError(`Failed to checkout branch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Helper to restore original branch
  const restoreOriginalBranch = async () => {
    if (needsCheckout && originalBranch) {
      try {
        await execAsync(`cd "${rebasePath}" && git checkout "${originalBranch}"`);
      } catch {
        console.warn(`Failed to restore original branch: ${originalBranch}`);
      }
    }
  };

  // Check if remote branch exists
  let useRemote = false;
  try {
    await execAsync(`cd "${rebasePath}" && git fetch origin "${parentBranch}"`);
    // Verify remote ref exists
    await execAsync(`cd "${rebasePath}" && git rev-parse "origin/${parentBranch}" 2>/dev/null`);
    useRemote = true;
  } catch {
    // Remote doesn't exist, use local branch
  }

  // Rebase onto remote or local parent
  const rebaseTarget = useRemote ? `origin/${parentBranch}` : parentBranch;
  try {
    const output = await execAsync(
      `cd "${rebasePath}" && git rebase "${rebaseTarget}"`
    );

    // Restore original branch after successful rebase
    await restoreOriginalBranch();

    return c.json({
      success: true,
      branchName,
      parentBranch,
      output: output.trim() || "Rebase successful",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Abort rebase if it failed
    try {
      await execAsync(`cd "${rebasePath}" && git rebase --abort 2>/dev/null || true`);
    } catch {
      // Ignore
    }

    // Restore original branch after failed rebase
    await restoreOriginalBranch();

    if (message.includes("conflict")) {
      throw new BadRequestError("Rebase failed due to conflicts. Rebase has been aborted.");
    }
    throw new BadRequestError(`Failed to rebase: ${message}`);
  }
});

// POST /api/branch/merge-parent - Merge parent branch into current
branchRouter.post("/merge-parent", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName, parentBranch, worktreePath: rawWorktreePath } = body;

  if (!rawLocalPath || !branchName || !parentBranch) {
    throw new BadRequestError("localPath, branchName, and parentBranch are required");
  }

  const localPath = expandTilde(rawLocalPath);
  const worktreePath = rawWorktreePath ? expandTilde(rawWorktreePath) : null;

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Determine which path to use for merge
  let mergePath: string | null = null;

  if (worktreePath && existsSync(worktreePath)) {
    mergePath = worktreePath;
  } else {
    // Check if the main repo is on this branch
    try {
      const currentBranch = (await execAsync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`
      )).trim();
      if (currentBranch === branchName) {
        mergePath = localPath;
      }
    } catch {
      // Ignore
    }
  }

  if (!mergePath) {
    throw new BadRequestError(`Branch "${branchName}" must be checked out to merge`);
  }

  // Check for uncommitted changes
  try {
    const status = (await execAsync(
      `cd "${mergePath}" && git status --porcelain`
    )).trim();
    if (status) {
      throw new BadRequestError("Cannot merge: you have uncommitted changes. Please commit or stash them first.");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if remote branch exists
  let useRemote = false;
  try {
    await execAsync(`cd "${mergePath}" && git fetch origin "${parentBranch}"`);
    // Verify remote ref exists
    await execAsync(`cd "${mergePath}" && git rev-parse "origin/${parentBranch}" 2>/dev/null`);
    useRemote = true;
  } catch {
    // Remote doesn't exist, use local branch
  }

  // Merge remote or local parent
  const mergeTarget = useRemote ? `origin/${parentBranch}` : parentBranch;
  try {
    const output = await execAsync(
      `cd "${mergePath}" && git merge "${mergeTarget}" --no-edit`
    );
    return c.json({
      success: true,
      branchName,
      parentBranch,
      output: output.trim() || "Merge successful",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Abort merge if it failed
    try {
      await execAsync(`cd "${mergePath}" && git merge --abort 2>/dev/null || true`);
    } catch {
      // Ignore
    }
    if (message.includes("conflict") || message.includes("CONFLICT")) {
      throw new BadRequestError("Merge failed due to conflicts. Merge has been aborted.");
    }
    throw new BadRequestError(`Failed to merge: ${message}`);
  }
});

// POST /api/branch/push - Push branch to remote
branchRouter.post("/push", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName, worktreePath: rawWorktreePath, force } = body;

  if (!rawLocalPath || !branchName) {
    throw new BadRequestError("localPath and branchName are required");
  }

  const localPath = expandTilde(rawLocalPath);
  const worktreePath = rawWorktreePath ? expandTilde(rawWorktreePath) : null;

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Determine which path to use for push
  let pushPath: string | null = null;

  if (worktreePath && existsSync(worktreePath)) {
    pushPath = worktreePath;
  } else {
    // Check if the main repo is on this branch
    try {
      const currentBranch = (await execAsync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`
      )).trim();
      if (currentBranch === branchName) {
        pushPath = localPath;
      }
    } catch {
      // Ignore
    }
  }

  if (!pushPath) {
    throw new BadRequestError(`Branch "${branchName}" must be checked out to push`);
  }

  // Push
  try {
    const forceFlag = force ? "--force-with-lease" : "";
    const output = await execAsync(
      `cd "${pushPath}" && git push ${forceFlag} -u origin "${branchName}" 2>&1`
    );
    return c.json({
      success: true,
      branchName,
      output: output.trim() || "Push successful",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("rejected") || message.includes("non-fast-forward")) {
      throw new BadRequestError("Push rejected. Remote has changes not in your branch. Pull/rebase first or use force push.");
    }
    throw new BadRequestError(`Failed to push: ${message}`);
  }
});

// POST /api/branch/check-deletable - Check if branch can be safely deleted
branchRouter.post("/check-deletable", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName, parentBranch } = body;

  if (!rawLocalPath || !branchName) {
    throw new BadRequestError("localPath and branchName are required");
  }

  const localPath = expandTilde(rawLocalPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Check if branch exists
  try {
    const existingBranches = (await execAsync(
      `cd "${localPath}" && git branch --list "${branchName}"`
    )).trim();
    if (!existingBranches) {
      return c.json({ deletable: false, reason: "branch_not_found" });
    }
  } catch {
    return c.json({ deletable: false, reason: "check_failed" });
  }

  // Check if currently on this branch
  try {
    const currentBranch = (await execAsync(
      `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`
    )).trim();
    if (currentBranch === branchName) {
      return c.json({ deletable: false, reason: "currently_checked_out" });
    }
  } catch {
    // Ignore
  }

  // Check if branch exists on remote
  let existsOnRemote = false;
  try {
    const remoteRef = (await execAsync(
      `cd "${localPath}" && git ls-remote --heads origin "${branchName}" 2>/dev/null`
    )).trim();
    existsOnRemote = remoteRef.length > 0;
  } catch {
    // If command fails, assume not on remote
  }

  if (existsOnRemote) {
    return c.json({ deletable: false, reason: "pushed_to_remote" });
  }

  // Check if branch has commits beyond parent
  // Find the parent branch from edges or use default
  let actualParent = parentBranch;
  if (!actualParent) {
    // Try to find parent from tree spec edges
    const repoId = await getRepoId(localPath);
    if (repoId) {
      try {
        const treeSpecs = await db
          .select()
          .from(schema.treeSpecs)
          .where(eq(schema.treeSpecs.repoId, repoId));

        for (const spec of treeSpecs) {
          const specJson = JSON.parse(spec.specJson) as {
            nodes: unknown[];
            edges: Array<{ parent: string; child: string }>;
          };
          const parentEdge = specJson.edges.find((e) => e.child === branchName);
          if (parentEdge) {
            actualParent = parentEdge.parent;
            break;
          }
        }

        // If no parent found, use base branch
        if (!actualParent && treeSpecs.length > 0 && treeSpecs[0]) {
          actualParent = treeSpecs[0].baseBranch;
        }
      } catch {
        // Ignore
      }
    }

    // Fallback to main/master
    if (!actualParent) {
      try {
        // Try main first
        const mainExists = (await execAsync(
          `cd "${localPath}" && git rev-parse --verify main 2>/dev/null`
        )).trim();
        if (mainExists) {
          actualParent = "main";
        }
      } catch {
        actualParent = "master";
      }
    }
  }

  // Check if there are any commits between parent and branch
  try {
    const commits = (await execAsync(
      `cd "${localPath}" && git log "${actualParent}..${branchName}" --oneline 2>/dev/null`
    )).trim();
    if (commits.length > 0) {
      return c.json({ deletable: false, reason: "has_commits" });
    }
  } catch {
    // If command fails, check against origin version
    try {
      const commits = (await execAsync(
        `cd "${localPath}" && git log "origin/${actualParent}..${branchName}" --oneline 2>/dev/null`
      )).trim();
      if (commits.length > 0) {
        return c.json({ deletable: false, reason: "has_commits" });
      }
    } catch {
      // If both fail, assume not deletable for safety
      return c.json({ deletable: false, reason: "check_failed" });
    }
  }

  // Branch can be safely deleted
  return c.json({ deletable: true, reason: null });
});

// DELETE /api/branch/delete - Delete a branch
branchRouter.post("/delete", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, branchName, force } = body;

  if (!rawLocalPath || !branchName) {
    throw new BadRequestError("localPath and branchName are required");
  }

  const localPath = expandTilde(rawLocalPath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Check if branch exists
  try {
    const existingBranches = (await execAsync(
      `cd "${localPath}" && git branch --list "${branchName}"`
    )).trim();
    if (!existingBranches) {
      throw new BadRequestError(`Branch does not exist: ${branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if currently on this branch
  try {
    const currentBranch = (await execAsync(
      `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`
    )).trim();
    if (currentBranch === branchName) {
      throw new BadRequestError("Cannot delete the currently checked out branch");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    // Ignore other errors
  }

  // Remove worktree if it exists for this branch
  const worktreePath = await getWorktreePath(localPath, branchName);
  if (worktreePath) {
    // Get worktree settings before removal for custom command
    const repoIdForWorktree = await getRepoId(localPath);
    const wtSettings = await getWorktreeSettings(repoIdForWorktree ?? "");

    try {
      const removed = await removeWorktree(localPath, branchName);
      if (!removed) {
        console.warn(`Failed to remove worktree for branch ${branchName}`);
      } else {
        // Run custom worktree delete command if configured
        if (wtSettings.worktreeDeleteCommand && repoIdForWorktree) {
          runCustomCommand(wtSettings.worktreeDeleteCommand, {
            repoId: repoIdForWorktree,
            branchName,
            worktreePath,
          }, "worktreeDeleteCommand");
        }

        // Run post-delete script if configured
        if (wtSettings.postDeleteScript) {
          runPostDeleteScript(localPath, wtSettings.postDeleteScript);
        }
      }
    } catch (err) {
      console.error(`Error removing worktree for branch ${branchName}:`, err);
      // Continue with branch deletion even if worktree removal fails
    }
  }

  // Delete the branch
  try {
    const flag = force ? "-D" : "-d";
    await execAsync(
      `cd "${localPath}" && git branch ${flag} "${branchName}"`
    );

    // Also delete remote branch if it exists
    try {
      await execAsync(
        `cd "${localPath}" && git push origin --delete "${branchName}" 2>/dev/null || true`
      );
    } catch {
      // Ignore errors deleting remote branch
    }

    // Reparent children of deleted branch in both treeSpecs and planningSessions
    const repoId = await getRepoId(localPath);
    if (repoId) {
      // 1. Update treeSpecs (Branch Graph structure - highest priority)
      try {
        const treeSpecs = await db
          .select()
          .from(schema.treeSpecs)
          .where(eq(schema.treeSpecs.repoId, repoId));

        for (const spec of treeSpecs) {
          const specJson = JSON.parse(spec.specJson) as {
            nodes: unknown[];
            edges: Array<{ parent: string; child: string }>;
          };

          // Find the deleted branch's parent in treeSpec
          const parentEdge = specJson.edges.find((e) => e.child === branchName);
          const parentBranch = parentEdge?.parent || spec.baseBranch;

          // Update children of deleted branch to point to grandparent
          const updatedEdges = specJson.edges
            .filter((e) => e.child !== branchName) // Remove edge to deleted branch
            .map((e) => {
              if (e.parent === branchName) {
                // Reparent child to grandparent
                return { ...e, parent: parentBranch };
              }
              return e;
            });

          // Only update if edges changed
          if (JSON.stringify(specJson.edges) !== JSON.stringify(updatedEdges)) {
            await db
              .update(schema.treeSpecs)
              .set({
                specJson: JSON.stringify({ ...specJson, edges: updatedEdges }),
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.treeSpecs.id, spec.id));
          }
        }
      } catch (err) {
        console.error("Failed to update treeSpecs edges:", err);
      }

      // 2. Update planning sessions
      try {
        const sessions = await db
          .select()
          .from(schema.planningSessions)
          .where(
            and(
              eq(schema.planningSessions.repoId, repoId),
              ne(schema.planningSessions.status, "discarded")
            )
          );

        for (const session of sessions) {
          const edges = JSON.parse(session.edgesJson) as Array<{ from: string; to: string }>;

          // Find the deleted branch's parent
          const parentEdge = edges.find((e) => e.to === branchName);
          const parentBranch = parentEdge?.from || session.baseBranch;

          // Update children of deleted branch to point to grandparent
          const updatedEdges = edges
            .filter((e) => e.to !== branchName) // Remove edge to deleted branch
            .map((e) => {
              if (e.from === branchName) {
                // Reparent child to grandparent
                return { ...e, from: parentBranch };
              }
              return e;
            });

          // Only update if edges changed
          if (JSON.stringify(edges) !== JSON.stringify(updatedEdges)) {
            await db
              .update(schema.planningSessions)
              .set({
                edgesJson: JSON.stringify(updatedEdges),
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.planningSessions.id, session.id));
          }
        }
      } catch (err) {
        console.error("Failed to update planning session edges:", err);
      }
    }

    // Clean up related data for the deleted branch
    try {
      // Delete chat sessions and their messages
      const sessionsToDelete = await db
        .select({ id: schema.chatSessions.id })
        .from(schema.chatSessions)
        .where(
          and(
            eq(schema.chatSessions.repoId, repoId),
            eq(schema.chatSessions.branchName, branchName)
          )
        );

      for (const session of sessionsToDelete) {
        // Delete chat summaries first (foreign key)
        await db
          .delete(schema.chatSummaries)
          .where(eq(schema.chatSummaries.sessionId, session.id));
        // Delete chat messages
        await db
          .delete(schema.chatMessages)
          .where(eq(schema.chatMessages.sessionId, session.id));
        // Delete agent runs
        await db
          .delete(schema.agentRuns)
          .where(eq(schema.agentRuns.sessionId, session.id));
      }

      // Delete the chat sessions
      await db
        .delete(schema.chatSessions)
        .where(
          and(
            eq(schema.chatSessions.repoId, repoId),
            eq(schema.chatSessions.branchName, branchName)
          )
        );

      // Delete task instructions
      await db
        .delete(schema.taskInstructions)
        .where(
          and(
            eq(schema.taskInstructions.repoId, repoId),
            eq(schema.taskInstructions.branchName, branchName)
          )
        );

      // Delete branch links
      await db
        .delete(schema.branchLinks)
        .where(
          and(
            eq(schema.branchLinks.repoId, repoId),
            eq(schema.branchLinks.branchName, branchName)
          )
        );

      // Delete instruction logs
      await db
        .delete(schema.instructionsLog)
        .where(
          and(
            eq(schema.instructionsLog.repoId, repoId),
            eq(schema.instructionsLog.branchName, branchName)
          )
        );
    } catch (err) {
      console.error("Failed to clean up branch data:", err);
      // Don't fail the request, branch is already deleted
    }

    return c.json({
      success: true,
      branchName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not fully merged")) {
      throw new BadRequestError(
        `Branch "${branchName}" is not fully merged. Use force delete if you're sure.`
      );
    }
    throw new BadRequestError(`Failed to delete branch: ${message}`);
  }
});

// POST /api/branch/cleanup-orphaned - Clean up data for branches that no longer exist
branchRouter.post("/cleanup-orphaned", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath } = body;

  if (!rawLocalPath) {
    throw new BadRequestError("localPath is required");
  }

  const localPath = expandTilde(rawLocalPath);
  const repoId = await getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError("Could not determine repo ID");
  }

  // Get all existing branches
  let existingBranches: string[] = [];
  try {
    const output = await execAsync(
      `cd "${localPath}" && git for-each-ref --format='%(refname:short)' refs/heads/`
    );
    existingBranches = output.trim().split("\n").filter(Boolean);
  } catch (err) {
    throw new BadRequestError("Failed to get branches");
  }

  const branchSet = new Set(existingBranches);
  const cleaned = {
    chatSessions: 0,
    chatMessages: 0,
    taskInstructions: 0,
    branchLinks: 0,
    instructionsLog: 0,
  };

  try {
    // Find and delete chat sessions for non-existent branches
    const orphanedSessions = await db
      .select({ id: schema.chatSessions.id, branchName: schema.chatSessions.branchName })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.repoId, repoId));

    for (const session of orphanedSessions) {
      if (session.branchName && !branchSet.has(session.branchName)) {
        // Delete related data
        await db.delete(schema.chatSummaries).where(eq(schema.chatSummaries.sessionId, session.id));
        const msgResult = await db.delete(schema.chatMessages).where(eq(schema.chatMessages.sessionId, session.id));
        cleaned.chatMessages += msgResult.changes;
        await db.delete(schema.agentRuns).where(eq(schema.agentRuns.sessionId, session.id));
        await db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, session.id));
        cleaned.chatSessions += 1;
      }
    }

    // Clean up task instructions
    const orphanedInstructions = await db
      .select()
      .from(schema.taskInstructions)
      .where(eq(schema.taskInstructions.repoId, repoId));

    for (const instr of orphanedInstructions) {
      if (instr.branchName && !branchSet.has(instr.branchName)) {
        await db.delete(schema.taskInstructions).where(eq(schema.taskInstructions.id, instr.id));
        cleaned.taskInstructions += 1;
      }
    }

    // Clean up branch links
    const orphanedLinks = await db
      .select()
      .from(schema.branchLinks)
      .where(eq(schema.branchLinks.repoId, repoId));

    for (const link of orphanedLinks) {
      if (!branchSet.has(link.branchName)) {
        await db.delete(schema.branchLinks).where(eq(schema.branchLinks.id, link.id));
        cleaned.branchLinks += 1;
      }
    }

    // Clean up instruction logs
    const orphanedLogs = await db
      .select()
      .from(schema.instructionsLog)
      .where(eq(schema.instructionsLog.repoId, repoId));

    for (const log of orphanedLogs) {
      if (log.branchName && !branchSet.has(log.branchName)) {
        await db.delete(schema.instructionsLog).where(eq(schema.instructionsLog.id, log.id));
        cleaned.instructionsLog += 1;
      }
    }
  } catch (err) {
    console.error("Cleanup error:", err);
    throw new BadRequestError("Failed to clean up orphaned data");
  }

  return c.json({
    success: true,
    cleaned,
    existingBranches: existingBranches.length,
  });
});

// POST /api/branch/delete-worktree - Delete a worktree
branchRouter.post("/delete-worktree", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, worktreePath: rawWorktreePath } = body;

  if (!rawLocalPath || !rawWorktreePath) {
    throw new BadRequestError("localPath and worktreePath are required");
  }

  const localPath = expandTilde(rawLocalPath);
  const worktreePath = expandTilde(rawWorktreePath);

  // Verify local path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Check if worktree exists
  if (!existsSync(worktreePath)) {
    throw new BadRequestError(`Worktree path does not exist: ${worktreePath}`);
  }

  // Get branch name from worktree
  let branchName: string | null = null;
  try {
    branchName = (await execAsync(
      `cd "${worktreePath}" && git rev-parse --abbrev-ref HEAD`
    )).trim();
  } catch {
    // Could be detached HEAD
  }

  // Check for uncommitted changes
  try {
    const status = (await execAsync(
      `cd "${worktreePath}" && git status --porcelain`
    )).trim();
    if (status) {
      throw new BadRequestError("Cannot delete worktree: you have uncommitted changes. Please commit, stash, or discard them first.");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Remove worktree
  try {
    await execAsync(
      `cd "${localPath}" && git worktree remove "${worktreePath}"`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Try force remove if normal fails
    if (message.includes("not empty") || message.includes("dirty")) {
      throw new BadRequestError("Cannot delete worktree: working tree is dirty. Please clean up first.");
    }
    throw new BadRequestError(`Failed to delete worktree: ${message}`);
  }

  // Run post-delete script if configured
  const repoId = await getRepoId(localPath);
  const wtSettings = await getWorktreeSettings(repoId ?? "");
  if (wtSettings.postDeleteScript) {
    runPostDeleteScript(localPath, wtSettings.postDeleteScript);
  }

  return c.json({
    success: true,
    worktreePath,
    branchName,
  });
});

// POST /api/branch/refresh-status - Get ahead/behind for specific branches
// Used after operations (pull, push, rebase, merge) to update UI without full scan
branchRouter.post("/refresh-status", async (c) => {
  const body = await c.req.json();
  const { localPath, branches, edges, defaultBranch } = body as {
    localPath: string;
    branches: string[];
    edges: { parent: string; child: string }[];
    defaultBranch: string;
  };

  if (!localPath || !branches || !Array.isArray(branches)) {
    throw new BadRequestError("localPath and branches array are required");
  }

  const expandedPath = expandTilde(localPath);
  if (!existsSync(expandedPath)) {
    throw new BadRequestError(`Path does not exist: ${expandedPath}`);
  }

  // Build parent map from edges
  const parentMap = new Map<string, string>();
  for (const edge of edges || []) {
    parentMap.set(edge.child, edge.parent);
  }

  // Calculate ahead/behind for each branch in parallel
  const results: Record<string, {
    aheadBehind?: { ahead: number; behind: number };
    remoteAheadBehind?: { ahead: number; behind: number };
  }> = {};

  await Promise.all(branches.map(async (branchName) => {
    results[branchName] = {};

    // Calculate ahead/behind relative to parent
    if (branchName !== defaultBranch) {
      const parentBranch = parentMap.get(branchName) || defaultBranch;
      try {
        const output = await execAsync(
          `cd "${expandedPath}" && git rev-list --left-right --count "${parentBranch}"..."${branchName}"`
        );
        const parts = output.trim().split(/\s+/);
        const behind = parseInt(parts[0] ?? "0", 10);
        const ahead = parseInt(parts[1] ?? "0", 10);
        results[branchName].aheadBehind = { ahead, behind };
      } catch {
        // Ignore errors
      }
    }

    // Calculate ahead/behind relative to remote
    try {
      const upstream = (await execAsync(
        `cd "${expandedPath}" && git rev-parse --abbrev-ref "${branchName}@{upstream}" 2>/dev/null`
      )).trim();

      if (upstream) {
        const output = await execAsync(
          `cd "${expandedPath}" && git rev-list --left-right --count "${upstream}"..."${branchName}"`
        );
        const parts = output.trim().split(/\s+/);
        const behind = parseInt(parts[0] ?? "0", 10);
        const ahead = parseInt(parts[1] ?? "0", 10);
        if (ahead > 0 || behind > 0) {
          results[branchName].remoteAheadBehind = { ahead, behind };
        }
      }
    } catch {
      // No upstream or error - skip
    }
  }));

  return c.json(results);
});
