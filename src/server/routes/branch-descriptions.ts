import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";

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

// GET /api/branch-descriptions?repoId=...&branchName=...
branchDescriptionsRouter.get("/", async (c) => {
  const query = validateOrThrow(getBranchDescriptionSchema, {
    repoId: c.req.query("repoId"),
    branchName: c.req.query("branchName"),
  });

  const [result] = await db
    .select()
    .from(schema.branchDescriptions)
    .where(
      and(
        eq(schema.branchDescriptions.repoId, query.repoId),
        eq(schema.branchDescriptions.branchName, query.branchName)
      )
    )
    .limit(1);

  return c.json(result || null);
});

// PUT /api/branch-descriptions - Create or update description
branchDescriptionsRouter.put("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(updateBranchDescriptionSchema, body);
  const now = new Date().toISOString();

  // Check if exists
  const [existing] = await db
    .select()
    .from(schema.branchDescriptions)
    .where(
      and(
        eq(schema.branchDescriptions.repoId, input.repoId),
        eq(schema.branchDescriptions.branchName, input.branchName)
      )
    )
    .limit(1);

  if (existing) {
    // Update
    await db
      .update(schema.branchDescriptions)
      .set({
        description: input.description,
        updatedAt: now,
      })
      .where(eq(schema.branchDescriptions.id, existing.id));

    const [updated] = await db
      .select()
      .from(schema.branchDescriptions)
      .where(eq(schema.branchDescriptions.id, existing.id));

    return c.json(updated);
  } else {
    // Create
    const [created] = await db
      .insert(schema.branchDescriptions)
      .values({
        repoId: input.repoId,
        branchName: input.branchName,
        description: input.description,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return c.json(created, 201);
  }
});
