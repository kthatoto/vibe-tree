import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, desc } from "drizzle-orm";
import { broadcast } from "../ws";

export const instructionsRouter = new Hono();

// POST /api/instructions/log
instructionsRouter.post("/log", async (c) => {
  const body = await c.req.json();
  const { repoId, planId, worktreePath, branchName, kind, contentMd } = body;

  if (!repoId || !kind || !contentMd) {
    return c.json({ error: "repoId, kind, and contentMd are required" }, 400);
  }

  const now = new Date().toISOString();

  const result = await db
    .insert(schema.instructionsLog)
    .values({
      repoId,
      planId: planId || null,
      worktreePath: worktreePath || null,
      branchName: branchName || null,
      kind,
      contentMd,
      createdAt: now,
    })
    .returning();

  const log = result[0];

  broadcast({
    type: "instructions.logged",
    repoId,
    data: log,
  });

  return c.json(log, 201);
});

// GET /api/instructions/logs?repoId=...
instructionsRouter.get("/logs", async (c) => {
  const repoId = parseInt(c.req.query("repoId") || "0");
  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  const logs = await db
    .select()
    .from(schema.instructionsLog)
    .where(eq(schema.instructionsLog.repoId, repoId))
    .orderBy(desc(schema.instructionsLog.createdAt))
    .limit(100);

  return c.json(logs);
});
