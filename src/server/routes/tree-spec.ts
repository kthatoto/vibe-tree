import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq } from "drizzle-orm";
import { broadcast } from "../ws";
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
    specJson: JSON.parse(spec.specJson),
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
  };

  broadcast({
    type: "scan.updated",
    repoId: input.repoId,
  });

  return c.json(response);
});
