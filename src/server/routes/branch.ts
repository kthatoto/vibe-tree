import { Hono } from "hono";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, basename, join } from "path";
import { randomUUID } from "crypto";
import { eq, and, ne } from "drizzle-orm";
import { expandTilde, getRepoId } from "../utils";
import { createBranchSchema, createTreeSchema, validateOrThrow } from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";
import { db, schema } from "../../db";

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
    const existingBranches = execSync(
      `cd "${localPath}" && git branch --list "${input.branchName}"`,
      { encoding: "utf-8" }
    ).trim();
    if (existingBranches) {
      throw new BadRequestError(`Branch already exists: ${input.branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    // Ignore other errors (git command issues)
  }

  // Create the branch
  try {
    execSync(
      `cd "${localPath}" && git branch "${input.branchName}" "${input.baseBranch}"`,
      { encoding: "utf-8" }
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
function getExistingPr(localPath: string, branchName: string): { url: string; number: number } | null {
  try {
    const result = execSync(
      `cd "${localPath}" && gh pr view "${branchName}" --json url,number 2>/dev/null || true`,
      { encoding: "utf-8" }
    ).trim();
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
function createPr(
  localPath: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string
): { url: string; number: number } {
  // First push the branch
  execSync(`cd "${localPath}" && git push -u origin "${branchName}"`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Create PR
  const result = execSync(
    `cd "${localPath}" && gh pr create --head "${branchName}" --base "${baseBranch}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --json url,number`,
    { encoding: "utf-8" }
  ).trim();

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
      const existingBranches = execSync(
        `cd "${localPath}" && git branch --list "${task.branchName}"`,
        { encoding: "utf-8" }
      ).trim();

      // Create branch if it doesn't exist
      if (!existingBranches) {
        execSync(
          `cd "${localPath}" && git branch "${task.branchName}" "${task.parentBranch}"`,
          { encoding: "utf-8" }
        );
      }

      // Check if worktree already exists
      if (existsSync(result.worktreePath)) {
        // Worktree already exists, just use it
        console.log(`Worktree already exists: ${result.worktreePath}`);
      } else {
        // Create worktree
        execSync(
          `cd "${localPath}" && git worktree add "${result.worktreePath}" "${task.branchName}"`,
          { encoding: "utf-8" }
        );
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
          const existingPr = getExistingPr(localPath, task.branchName);
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

            const pr = createPr(
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
    const existingBranches = execSync(
      `cd "${localPath}" && git branch --list "${branchName}"`,
      { encoding: "utf-8" }
    ).trim();
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

  // Create worktree
  const worktreeName = branchName.replace(/\//g, "-");
  const worktreePath = join(worktreesDir, worktreeName);

  if (existsSync(worktreePath)) {
    // Worktree already exists
    return c.json({
      worktreePath,
      branchName,
      alreadyExists: true,
    });
  }

  try {
    execSync(
      `cd "${localPath}" && git worktree add "${worktreePath}" "${branchName}"`,
      { encoding: "utf-8" }
    );
  } catch (err) {
    throw new BadRequestError(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
  }

  return c.json({
    worktreePath,
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
    const existingBranches = execSync(
      `cd "${localPath}" && git branch --list "${branchName}"`,
      { encoding: "utf-8" }
    ).trim();
    if (!existingBranches) {
      throw new BadRequestError(`Branch does not exist: ${branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check for uncommitted changes
  try {
    const status = execSync(
      `cd "${localPath}" && git status --porcelain`,
      { encoding: "utf-8" }
    ).trim();
    if (status) {
      throw new BadRequestError("Cannot checkout: you have uncommitted changes. Please commit or stash them first.");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Checkout
  try {
    execSync(
      `cd "${localPath}" && git checkout "${branchName}"`,
      { encoding: "utf-8" }
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
      const currentBranch = execSync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`,
        { encoding: "utf-8" }
      ).trim();
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
      const output = execSync(
        `cd "${localPath}" && git fetch origin "${branchName}:${branchName}"`,
        { encoding: "utf-8", timeout: 30000 }
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
    const status = execSync(
      `cd "${pullPath}" && git status --porcelain`,
      { encoding: "utf-8" }
    ).trim();
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
    const output = execSync(
      `cd "${pullPath}" && git pull`,
      { encoding: "utf-8", timeout: 30000 }
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

  if (worktreePath && existsSync(worktreePath)) {
    rebasePath = worktreePath;
  } else {
    // Check if the main repo is on this branch
    try {
      const currentBranch = execSync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`,
        { encoding: "utf-8" }
      ).trim();
      if (currentBranch === branchName) {
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
    const status = execSync(
      `cd "${rebasePath}" && git status --porcelain`,
      { encoding: "utf-8" }
    ).trim();
    if (status) {
      throw new BadRequestError("Cannot rebase: you have uncommitted changes. Please commit or stash them first.");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if remote branch exists
  let useRemote = false;
  try {
    execSync(`cd "${rebasePath}" && git fetch origin "${parentBranch}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    // Verify remote ref exists
    execSync(`cd "${rebasePath}" && git rev-parse "origin/${parentBranch}" 2>/dev/null`, {
      encoding: "utf-8",
    });
    useRemote = true;
  } catch {
    // Remote doesn't exist, use local branch
  }

  // Rebase onto remote or local parent
  const rebaseTarget = useRemote ? `origin/${parentBranch}` : parentBranch;
  try {
    const output = execSync(
      `cd "${rebasePath}" && git rebase "${rebaseTarget}"`,
      { encoding: "utf-8", timeout: 60000 }
    );
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
      execSync(`cd "${rebasePath}" && git rebase --abort 2>/dev/null || true`, { encoding: "utf-8" });
    } catch {
      // Ignore
    }
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
      const currentBranch = execSync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`,
        { encoding: "utf-8" }
      ).trim();
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
    const status = execSync(
      `cd "${mergePath}" && git status --porcelain`,
      { encoding: "utf-8" }
    ).trim();
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
    execSync(`cd "${mergePath}" && git fetch origin "${parentBranch}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    // Verify remote ref exists
    execSync(`cd "${mergePath}" && git rev-parse "origin/${parentBranch}" 2>/dev/null`, {
      encoding: "utf-8",
    });
    useRemote = true;
  } catch {
    // Remote doesn't exist, use local branch
  }

  // Merge remote or local parent
  const mergeTarget = useRemote ? `origin/${parentBranch}` : parentBranch;
  try {
    const output = execSync(
      `cd "${mergePath}" && git merge "${mergeTarget}" --no-edit`,
      { encoding: "utf-8", timeout: 60000 }
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
      execSync(`cd "${mergePath}" && git merge --abort 2>/dev/null || true`, { encoding: "utf-8" });
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
      const currentBranch = execSync(
        `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`,
        { encoding: "utf-8" }
      ).trim();
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
    const output = execSync(
      `cd "${pushPath}" && git push ${forceFlag} -u origin "${branchName}" 2>&1`,
      { encoding: "utf-8", timeout: 60000 }
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
    const existingBranches = execSync(
      `cd "${localPath}" && git branch --list "${branchName}"`,
      { encoding: "utf-8" }
    ).trim();
    if (!existingBranches) {
      return c.json({ deletable: false, reason: "branch_not_found" });
    }
  } catch {
    return c.json({ deletable: false, reason: "check_failed" });
  }

  // Check if currently on this branch
  try {
    const currentBranch = execSync(
      `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`,
      { encoding: "utf-8" }
    ).trim();
    if (currentBranch === branchName) {
      return c.json({ deletable: false, reason: "currently_checked_out" });
    }
  } catch {
    // Ignore
  }

  // Check if branch exists on remote
  let existsOnRemote = false;
  try {
    const remoteRef = execSync(
      `cd "${localPath}" && git ls-remote --heads origin "${branchName}" 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
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
    const repoId = getRepoId(localPath);
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
        const mainExists = execSync(
          `cd "${localPath}" && git rev-parse --verify main 2>/dev/null`,
          { encoding: "utf-8" }
        ).trim();
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
    const commits = execSync(
      `cd "${localPath}" && git log "${actualParent}..${branchName}" --oneline 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
    if (commits.length > 0) {
      return c.json({ deletable: false, reason: "has_commits" });
    }
  } catch {
    // If command fails, check against origin version
    try {
      const commits = execSync(
        `cd "${localPath}" && git log "origin/${actualParent}..${branchName}" --oneline 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();
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
    const existingBranches = execSync(
      `cd "${localPath}" && git branch --list "${branchName}"`,
      { encoding: "utf-8" }
    ).trim();
    if (!existingBranches) {
      throw new BadRequestError(`Branch does not exist: ${branchName}`);
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if currently on this branch
  try {
    const currentBranch = execSync(
      `cd "${localPath}" && git rev-parse --abbrev-ref HEAD`,
      { encoding: "utf-8" }
    ).trim();
    if (currentBranch === branchName) {
      throw new BadRequestError("Cannot delete the currently checked out branch");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    // Ignore other errors
  }

  // Delete the branch
  try {
    const flag = force ? "-D" : "-d";
    execSync(
      `cd "${localPath}" && git branch ${flag} "${branchName}"`,
      { encoding: "utf-8" }
    );

    // Also delete remote branch if it exists
    try {
      execSync(
        `cd "${localPath}" && git push origin --delete "${branchName}" 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 30000 }
      );
    } catch {
      // Ignore errors deleting remote branch
    }

    // Reparent children of deleted branch in both treeSpecs and planningSessions
    const repoId = getRepoId(localPath);
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

  const localPath = normalizePath(rawLocalPath);
  const repoId = getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError("Could not determine repo ID");
  }

  // Get all existing branches
  let existingBranches: string[] = [];
  try {
    const output = execSync(
      `cd "${localPath}" && git for-each-ref --format='%(refname:short)' refs/heads/`,
      { encoding: "utf-8" }
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
