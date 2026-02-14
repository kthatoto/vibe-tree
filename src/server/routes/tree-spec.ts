import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq } from "drizzle-orm";
import {
  repoIdQuerySchema,
  updateTreeSpecSchema,
  validateOrThrow,
} from "../../shared/validation";

export const treeSpecRouter = new Hono();

// GET /api/tree-spec?repoId=...
treeSpecRouter.get("/", async (c) => {
  const query = validateOrThrow(repoIdQuerySchema, {
    repoId: c.req.query("repoId"),
  });

  const specs = await db
    .select()
    .from(schema.treeSpecs)
    .where(eq(schema.treeSpecs.repoId, query.repoId))
    .limit(1);

  const spec = specs[0];
  if (!spec) {
    return c.json(null);
  }

  return c.json({
    id: spec.id,
    repoId: spec.repoId,
    baseBranch: spec.baseBranch ?? "main",
    status: spec.status ?? "draft",
    specJson: JSON.parse(spec.specJson),
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
  });
});

// POST /api/tree-spec
treeSpecRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(updateTreeSpecSchema, body);

  const now = new Date().toISOString();
  const specJson = JSON.stringify({
    nodes: input.nodes,
    edges: input.edges,
    siblingOrder: input.siblingOrder,
  });

  // Check if spec exists
  const existing = await db
    .select()
    .from(schema.treeSpecs)
    .where(eq(schema.treeSpecs.repoId, input.repoId))
    .limit(1);

  let result;
  if (existing[0]) {
    // Update
    result = await db
      .update(schema.treeSpecs)
      .set({
        baseBranch: input.baseBranch,
        specJson,
        updatedAt: now,
      })
      .where(eq(schema.treeSpecs.repoId, input.repoId))
      .returning();
  } else {
    // Insert
    result = await db
      .insert(schema.treeSpecs)
      .values({
        repoId: input.repoId,
        baseBranch: input.baseBranch,
        specJson,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  }

  const spec = result[0];
  if (!spec) {
    throw new Error("Failed to save tree spec");
  }

  const response = {
    id: spec.id,
    repoId: spec.repoId,
    baseBranch: spec.baseBranch ?? "main",
    status: spec.status ?? "draft",
    specJson: JSON.parse(spec.specJson),
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
  };

  return c.json(response);
});

// POST /api/tree-spec/confirm - Confirm the tree spec
treeSpecRouter.post("/confirm", async (c) => {
  const body = await c.req.json();
  const { repoId } = body;

  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  const existing = await db
    .select()
    .from(schema.treeSpecs)
    .where(eq(schema.treeSpecs.repoId, repoId))
    .limit(1);

  if (!existing[0]) {
    return c.json({ error: "Tree spec not found" }, 404);
  }

  const spec = existing[0];
  const parsed = JSON.parse(spec.specJson);

  // Validate confirmation conditions
  const errors: string[] = [];

  // 1. Base branch must be set
  if (!spec.baseBranch) {
    errors.push("Base branch is not set");
  }

  // 2. At least one node must exist
  if (parsed.nodes.length === 0) {
    errors.push("At least one task is required");
  }

  // 3. All nodes must have a parent (edge) or be root (no incoming edge means root)
  // For MVP: just check that nodes exist and at least one root exists
  const childIds = new Set(parsed.edges.map((e: { child: string }) => e.child));
  const rootNodes = parsed.nodes.filter((n: { id: string }) => !childIds.has(n.id));

  if (rootNodes.length === 0 && parsed.nodes.length > 0) {
    errors.push("At least one root task is required");
  }

  if (errors.length > 0) {
    return c.json({ error: errors.join(", "), errors }, 400);
  }

  // Update status to confirmed
  const now = new Date().toISOString();
  const result = await db
    .update(schema.treeSpecs)
    .set({ status: "confirmed", updatedAt: now })
    .where(eq(schema.treeSpecs.repoId, repoId))
    .returning();

  const updated = result[0];
  if (!updated) {
    return c.json({ error: "Failed to confirm tree spec" }, 500);
  }

  return c.json({
    id: updated.id,
    repoId: updated.repoId,
    baseBranch: updated.baseBranch,
    status: updated.status,
    specJson: JSON.parse(updated.specJson),
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
});

// POST /api/tree-spec/unconfirm - Unconfirm the tree spec (back to draft)
treeSpecRouter.post("/unconfirm", async (c) => {
  const body = await c.req.json();
  const { repoId } = body;

  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  const now = new Date().toISOString();
  const result = await db
    .update(schema.treeSpecs)
    .set({ status: "draft", updatedAt: now })
    .where(eq(schema.treeSpecs.repoId, repoId))
    .returning();

  const updated = result[0];
  if (!updated) {
    return c.json({ error: "Tree spec not found" }, 404);
  }

  return c.json({
    id: updated.id,
    repoId: updated.repoId,
    baseBranch: updated.baseBranch,
    status: updated.status,
    specJson: JSON.parse(updated.specJson),
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
});
