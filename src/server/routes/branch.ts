import { Hono } from "hono";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { expandTilde } from "../utils";
import { createBranchSchema, validateOrThrow } from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";

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
