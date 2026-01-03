import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { broadcast } from "../ws";
import {
  repoIdQuerySchema,
  updateBranchNamingSchema,
  validateOrThrow,
} from "../../shared/validation";
import type { BranchNamingRule } from "../../shared/types";

export const projectRulesRouter = new Hono();

// GET /api/project-rules/branch-naming?repoId=...
projectRulesRouter.get("/branch-naming", async (c) => {
  const query = validateOrThrow(repoIdQuerySchema, {
    repoId: c.req.query("repoId"),
  });

  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, query.repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  const rule = rules[0];
  if (!rule) {
    // Return empty rule if none exists
    return c.json({
      id: null,
      repoId: query.repoId,
      patterns: [],
    });
  }

  const ruleData = JSON.parse(rule.ruleJson) as BranchNamingRule;
  // Support legacy single pattern
  let patterns: string[];
  if (ruleData.patterns && Array.isArray(ruleData.patterns)) {
    patterns = ruleData.patterns;
  } else if ((ruleData as unknown as { pattern?: string }).pattern) {
    patterns = [(ruleData as unknown as { pattern: string }).pattern];
  } else {
    patterns = [];
  }
  return c.json({
    id: rule.id,
    repoId: rule.repoId,
    patterns,
  });
});

// POST /api/project-rules/branch-naming
projectRulesRouter.post("/branch-naming", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(updateBranchNamingSchema, body);

  const now = new Date().toISOString();
  const ruleJson = JSON.stringify({
    patterns: input.patterns,
  });

  // Check if rule exists
  const existing = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, input.repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  let ruleId: number;

  if (existing[0]) {
    // Update existing rule
    await db
      .update(schema.projectRules)
      .set({
        ruleJson,
        updatedAt: now,
      })
      .where(eq(schema.projectRules.id, existing[0].id));
    ruleId = existing[0].id;
  } else {
    // Create new rule
    const result = await db
      .insert(schema.projectRules)
      .values({
        repoId: input.repoId,
        ruleType: "branch_naming",
        ruleJson,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    ruleId = result[0]!.id;
  }

  const response = {
    id: ruleId,
    repoId: input.repoId,
    patterns: input.patterns,
  };

  // Broadcast update
  broadcast({
    type: "projectRules.updated",
    repoId: input.repoId,
    data: response,
  });

  return c.json(response);
});
