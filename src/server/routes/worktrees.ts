import { Hono } from "hono";
import { z } from "zod";
import { existsSync } from "fs";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";
import { expandTilde, execAsync } from "../utils";
import { getWorktrees } from "../lib/git-helpers";
import { db, schema } from "../../db";
import { eq } from "drizzle-orm";

export const worktreesRouter = new Hono();

// Schemas
const getWorktreesSchema = z.object({
  localPath: z.string().min(1),
});

const createWorktreeSchema = z.object({
  localPath: z.string().min(1),
  branchName: z.string().min(1),
  worktreePath: z.string().min(1),
});

// GET /api/worktrees?localPath=xxx - Get worktree list for a repository
worktreesRouter.get("/", async (c) => {
  const localPath = c.req.query("localPath");
  if (!localPath) {
    throw new BadRequestError("localPath is required");
  }

  const expandedPath = expandTilde(localPath);
  if (!existsSync(expandedPath)) {
    throw new BadRequestError(`Path does not exist: ${expandedPath}`);
  }

  try {
    const worktrees = await getWorktrees(expandedPath);
    return c.json(worktrees);
  } catch (err) {
    console.error("[Worktrees] Failed to get worktrees:", err);
    throw new BadRequestError("Failed to get worktrees");
  }
});

// GET /api/worktrees/by-repo?repoId=xxx - Get worktree list by repoId (uses repo_pins for localPath)
worktreesRouter.get("/by-repo", async (c) => {
  const repoId = c.req.query("repoId");
  if (!repoId) {
    throw new BadRequestError("repoId is required");
  }

  // Get localPath from repo_pins
  const [repoPin] = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.repoId, repoId))
    .limit(1);

  if (!repoPin) {
    throw new BadRequestError(`Repository not found in pins: ${repoId}`);
  }

  const localPath = repoPin.localPath;
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Path does not exist: ${localPath}`);
  }

  try {
    const worktrees = await getWorktrees(localPath);
    return c.json({
      localPath,
      worktrees,
    });
  } catch (err) {
    console.error("[Worktrees] Failed to get worktrees:", err);
    throw new BadRequestError("Failed to get worktrees");
  }
});

// POST /api/worktrees - Create a new worktree
worktreesRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { localPath, branchName, worktreePath } = validateOrThrow(createWorktreeSchema, body);

  const expandedLocalPath = expandTilde(localPath);
  const expandedWorktreePath = expandTilde(worktreePath);

  if (!existsSync(expandedLocalPath)) {
    throw new BadRequestError(`Repository path does not exist: ${expandedLocalPath}`);
  }

  if (existsSync(expandedWorktreePath)) {
    throw new BadRequestError(`Worktree path already exists: ${expandedWorktreePath}`);
  }

  try {
    // Check if branch exists
    const branchExists = (await execAsync(
      `cd "${expandedLocalPath}" && git rev-parse --verify "${branchName}" 2>/dev/null || git rev-parse --verify "origin/${branchName}" 2>/dev/null || echo ""`
    )).trim();

    if (!branchExists) {
      throw new BadRequestError(`Branch does not exist: ${branchName}`);
    }

    // Create worktree
    await execAsync(
      `cd "${expandedLocalPath}" && git worktree add "${expandedWorktreePath}" "${branchName}"`
    );

    // Get updated worktree list
    const worktrees = await getWorktrees(expandedLocalPath);
    const newWorktree = worktrees.find((w) => w.path === expandedWorktreePath);

    return c.json({
      success: true,
      worktree: newWorktree,
    });
  } catch (err) {
    console.error("[Worktrees] Failed to create worktree:", err);
    const message = err instanceof Error ? err.message : "Failed to create worktree";
    throw new BadRequestError(message);
  }
});
