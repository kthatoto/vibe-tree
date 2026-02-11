import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, desc } from "drizzle-orm";
import { existsSync } from "fs";
import { expandTilde, getRepoId } from "../utils";
import {
  createRepoPinSchema,
  useRepoPinSchema,
  validateOrThrow,
} from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import type { RepoPin } from "../../shared/types";

export const repoPinsRouter = new Hono();

// GET /api/repo-pins - Get all saved repo pins
repoPinsRouter.get("/", async (c) => {
  const pins = await db
    .select()
    .from(schema.repoPins)
    .orderBy(desc(schema.repoPins.lastUsedAt));

  const result: RepoPin[] = pins.map((p) => ({
    id: p.id,
    repoId: p.repoId,
    localPath: p.localPath,
    label: p.label,
    baseBranch: p.baseBranch ?? null,
    lastUsedAt: p.lastUsedAt,
    createdAt: p.createdAt,
  }));

  return c.json(result);
});

// POST /api/repo-pins - Add a new repo pin
repoPinsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createRepoPinSchema, body);
  const localPath = expandTilde(input.localPath);

  // Verify path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Get repo ID from path
  const repoId = await getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError(`Could not detect GitHub repo at: ${localPath}`);
  }

  const now = new Date().toISOString();

  // Check if already exists (by localPath)
  const existing = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.localPath, localPath));

  const existingPin = existing[0];
  if (existingPin) {
    // Update existing
    await db
      .update(schema.repoPins)
      .set({
        repoId,
        label: input.label ?? existingPin.label,
        lastUsedAt: now,
      })
      .where(eq(schema.repoPins.id, existingPin.id));

    const updated: RepoPin = {
      id: existingPin.id,
      repoId,
      localPath,
      label: input.label ?? existingPin.label,
      baseBranch: existingPin.baseBranch ?? null,
      lastUsedAt: now,
      createdAt: existingPin.createdAt,
    };
    return c.json(updated);
  }

  // Insert new
  const result = await db
    .insert(schema.repoPins)
    .values({
      repoId,
      localPath,
      label: input.label ?? null,
      lastUsedAt: now,
      createdAt: now,
    })
    .returning();

  const inserted = result[0];
  if (!inserted) {
    throw new BadRequestError("Failed to insert repo pin");
  }

  const pin: RepoPin = {
    id: inserted.id,
    repoId: inserted.repoId,
    localPath: inserted.localPath,
    label: inserted.label,
    baseBranch: inserted.baseBranch ?? null,
    lastUsedAt: inserted.lastUsedAt,
    createdAt: inserted.createdAt,
  };

  return c.json(pin, 201);
});

// POST /api/repo-pins/use - Mark a pin as used (update lastUsedAt)
repoPinsRouter.post("/use", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(useRepoPinSchema, body);

  const existing = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.id, input.id));

  const existingPin = existing[0];
  if (!existingPin) {
    throw new NotFoundError(`Repo pin not found: ${input.id}`);
  }

  const now = new Date().toISOString();
  await db
    .update(schema.repoPins)
    .set({ lastUsedAt: now })
    .where(eq(schema.repoPins.id, input.id));

  const updated: RepoPin = {
    id: existingPin.id,
    repoId: existingPin.repoId,
    localPath: existingPin.localPath,
    label: existingPin.label,
    baseBranch: existingPin.baseBranch ?? null,
    lastUsedAt: now,
    createdAt: existingPin.createdAt,
  };

  return c.json(updated);
});

// PATCH /api/repo-pins/:id - Update a repo pin (label, baseBranch)
repoPinsRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id) || id <= 0) {
    throw new BadRequestError("Invalid id");
  }

  const body = await c.req.json();
  const { label, baseBranch } = body as { label?: string; baseBranch?: string };

  const existing = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.id, id));

  const existingPin = existing[0];
  if (!existingPin) {
    throw new NotFoundError(`Repo pin not found: ${id}`);
  }

  const updateData: Record<string, unknown> = {};
  if (label !== undefined) updateData.label = label;
  if (baseBranch !== undefined) updateData.baseBranch = baseBranch;

  if (Object.keys(updateData).length > 0) {
    await db
      .update(schema.repoPins)
      .set(updateData)
      .where(eq(schema.repoPins.id, id));
  }

  const updated: RepoPin = {
    id: existingPin.id,
    repoId: existingPin.repoId,
    localPath: existingPin.localPath,
    label: label !== undefined ? label : existingPin.label,
    baseBranch: baseBranch !== undefined ? baseBranch : existingPin.baseBranch ?? null,
    lastUsedAt: existingPin.lastUsedAt,
    createdAt: existingPin.createdAt,
  };

  return c.json(updated);
});

// DELETE /api/repo-pins/:id - Delete a repo pin
repoPinsRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id) || id <= 0) {
    throw new BadRequestError("Invalid id");
  }

  const existing = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.id, id));

  if (existing.length === 0) {
    throw new NotFoundError(`Repo pin not found: ${id}`);
  }

  await db.delete(schema.repoPins).where(eq(schema.repoPins.id, id));

  return c.json({ success: true });
});
