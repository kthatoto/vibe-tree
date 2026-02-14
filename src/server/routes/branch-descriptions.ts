import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { expandTilde, execAsync } from "../utils";

export const branchDescriptionsRouter = new Hono();

// Validation schemas
const getBranchDescriptionSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
});

const updateBranchDescriptionSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
  description: z.string(),
});

// Helper: get localPath from repoId
async function getLocalPath(repoId: string): Promise<string | null> {
  const [pin] = await db.select().from(schema.repoPins).where(eq(schema.repoPins.repoId, repoId)).limit(1);
  return pin ? expandTilde(pin.localPath) : null;
}

// Helper: get git branch description
async function getGitDescription(localPath: string, branchName: string): Promise<string | null> {
  try {
    const desc = (await execAsync(`cd "${localPath}" && git config branch.${branchName}.description 2>/dev/null`)).trim();
    return desc || null;
  } catch {
    return null;
  }
}

// Helper: set git branch description
async function setGitDescription(localPath: string, branchName: string, description: string): Promise<void> {
  if (description) {
    await execAsync(`cd "${localPath}" && git config branch.${branchName}.description "${description.replace(/"/g, '\\"')}"`);
  } else {
    await execAsync(`cd "${localPath}" && git config --unset branch.${branchName}.description 2>/dev/null || true`);
  }
}

// GET /api/branch-descriptions?repoId=...&branchName=...
// Fetches from git config and syncs to DB
branchDescriptionsRouter.get("/", async (c) => {
  const query = validateOrThrow(getBranchDescriptionSchema, {
    repoId: c.req.query("repoId"),
    branchName: c.req.query("branchName"),
  });

  const localPath = await getLocalPath(query.repoId);
  if (!localPath) {
    return c.json(null);
  }

  // Fetch from git
  const gitDesc = await getGitDescription(localPath, query.branchName);
  const now = new Date().toISOString();

  // Sync to DB
  const [existing] = await db.select().from(schema.branchDescriptions)
    .where(and(eq(schema.branchDescriptions.repoId, query.repoId), eq(schema.branchDescriptions.branchName, query.branchName)))
    .limit(1);

  if (gitDesc) {
    if (existing) {
      if (existing.description !== gitDesc) {
        await db.update(schema.branchDescriptions).set({ description: gitDesc, updatedAt: now }).where(eq(schema.branchDescriptions.id, existing.id));
      }
      return c.json({ ...existing, description: gitDesc });
    } else {
      const [created] = await db.insert(schema.branchDescriptions).values({
        repoId: query.repoId, branchName: query.branchName, description: gitDesc, createdAt: now, updatedAt: now,
      }).returning();
      return c.json(created);
    }
  } else {
    // No git description - return null (but keep DB record if exists for history)
    return c.json(null);
  }
});

// GET /api/branch-descriptions/batch?repoId=...&branches=branch1,branch2,...
branchDescriptionsRouter.get("/batch", async (c) => {
  const repoId = c.req.query("repoId");
  const branchesParam = c.req.query("branches");
  if (!repoId || !branchesParam) return c.json({});

  const branches = branchesParam.split(",").filter(Boolean);
  const localPath = await getLocalPath(repoId);
  const result: Record<string, string> = {};

  if (localPath) {
    for (const branchName of branches) {
      const desc = await getGitDescription(localPath, branchName);
      if (desc) result[branchName] = desc;
    }
  }
  return c.json(result);
});

// PUT /api/branch-descriptions - Create or update description (both git and DB)
branchDescriptionsRouter.put("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(updateBranchDescriptionSchema, body);
  const now = new Date().toISOString();

  // Update git config
  const localPath = await getLocalPath(input.repoId);
  if (localPath) {
    await setGitDescription(localPath, input.branchName, input.description);
  }

  // Update DB
  const [existing] = await db.select().from(schema.branchDescriptions)
    .where(and(eq(schema.branchDescriptions.repoId, input.repoId), eq(schema.branchDescriptions.branchName, input.branchName)))
    .limit(1);

  if (existing) {
    await db.update(schema.branchDescriptions).set({ description: input.description, updatedAt: now }).where(eq(schema.branchDescriptions.id, existing.id));
    const [updated] = await db.select().from(schema.branchDescriptions).where(eq(schema.branchDescriptions.id, existing.id));
    return c.json(updated);
  } else {
    const [created] = await db.insert(schema.branchDescriptions).values({
      repoId: input.repoId, branchName: input.branchName, description: input.description, createdAt: now, updatedAt: now,
    }).returning();
    return c.json(created, 201);
  }
});
