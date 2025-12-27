import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { broadcast } from "../ws";

export const projectRulesRouter = new Hono();

// GET /api/project-rules/branch-naming?repoId=...
projectRulesRouter.get("/branch-naming", async (c) => {
  const repoId = parseInt(c.req.query("repoId") || "0");
  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  if (rules.length === 0) {
    return c.json({ error: "Branch naming rule not found" }, 404);
  }

  const rule = rules[0];
  return c.json({
    id: rule.id,
    repoId: rule.repoId,
    ...JSON.parse(rule.ruleJson),
  });
});

// POST /api/project-rules/branch-naming
projectRulesRouter.post("/branch-naming", async (c) => {
  const body = await c.req.json();
  const { repoId, pattern, description, examples } = body;

  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  const now = new Date().toISOString();
  const ruleJson = JSON.stringify({ pattern, description, examples });

  // Update existing branch_naming rule
  const result = await db
    .update(schema.projectRules)
    .set({
      ruleJson,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    )
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Branch naming rule not found" }, 404);
  }

  // Broadcast update
  broadcast({
    type: "projectRules.updated",
    repoId,
    data: { pattern, description, examples },
  });

  return c.json({
    id: result[0].id,
    repoId,
    pattern,
    description,
    examples,
  });
});
