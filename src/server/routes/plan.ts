import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, desc } from "drizzle-orm";
import { broadcast } from "../ws";
import { execAsync } from "../utils";
import {
  repoIdQuerySchema,
  startPlanSchema,
  updatePlanSchema,
  commitPlanSchema,
  validateOrThrow,
} from "../../shared/validation";
import { NotFoundError } from "../middleware/error-handler";
import type { BranchNamingRule } from "../../shared/types";

export const planRouter = new Hono();

// GET /api/plan/current?repoId=...
planRouter.get("/current", async (c) => {
  const query = validateOrThrow(repoIdQuerySchema, {
    repoId: c.req.query("repoId"),
  });

  // Get the latest plan for this repo
  const plans = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.repoId, query.repoId))
    .orderBy(desc(schema.plans.createdAt))
    .limit(1);

  const plan = plans[0];
  return c.json(plan ?? null);
});

// POST /api/plan/start
planRouter.post("/start", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(startPlanSchema, body);

  const now = new Date().toISOString();

  const result = await db
    .insert(schema.plans)
    .values({
      repoId: input.repoId,
      title: input.title,
      contentMd: "",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const plan = result[0];
  if (!plan) {
    throw new Error("Failed to create plan");
  }

  broadcast({
    type: "plan.updated",
    repoId: input.repoId,
    data: plan,
  });

  return c.json(plan, 201);
});

// POST /api/plan/update
planRouter.post("/update", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(updatePlanSchema, body);

  const now = new Date().toISOString();

  const result = await db
    .update(schema.plans)
    .set({
      contentMd: input.contentMd,
      updatedAt: now,
    })
    .where(eq(schema.plans.id, input.planId))
    .returning();

  const plan = result[0];
  if (!plan) {
    throw new NotFoundError("Plan");
  }

  broadcast({
    type: "plan.updated",
    repoId: plan.repoId,
    data: plan,
  });

  return c.json(plan);
});

// POST /api/plan/commit
planRouter.post("/commit", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(commitPlanSchema, body);

  // Get plan
  const plans = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.id, input.planId));

  const plan = plans[0];
  if (!plan) {
    throw new NotFoundError("Plan");
  }

  // Get branch naming rule
  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, plan.repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  const ruleRecord = rules[0];
  const branchNaming = ruleRecord
    ? (JSON.parse(ruleRecord.ruleJson) as BranchNamingRule)
    : null;

  // Create GitHub Issue with minimal summary
  const issueBody = createIssueBody(plan, branchNaming);
  let issueUrl: string | null = null;

  try {
    const escapedTitle = plan.title.replace(/"/g, '\\"');
    const escapedBody = issueBody.replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const result = await execAsync(
      `cd "${input.localPath}" && gh issue create --title "${escapedTitle}" --body "${escapedBody}"`
    );
    issueUrl = result.trim();
  } catch (error) {
    console.error("Failed to create GitHub issue:", error);
    // Continue even if gh fails (might not be in a gh-configured repo)
  }

  // Update plan status
  const now = new Date().toISOString();
  const result = await db
    .update(schema.plans)
    .set({
      status: "committed",
      githubIssueUrl: issueUrl,
      updatedAt: now,
    })
    .where(eq(schema.plans.id, input.planId))
    .returning();

  const updatedPlan = result[0];
  if (!updatedPlan) {
    throw new Error("Failed to update plan");
  }

  broadcast({
    type: "plan.updated",
    repoId: plan.repoId,
    data: updatedPlan,
  });

  return c.json(updatedPlan);
});

function createIssueBody(
  plan: { id: number; title: string; contentMd: string },
  branchNaming: BranchNamingRule | null
): string {
  const truncatedContent =
    plan.contentMd.length > 500
      ? plan.contentMd.substring(0, 500) + "..."
      : plan.contentMd;

  return `## Goal
${plan.title}

## Project Rules
### Branch Naming
- Pattern: \`${branchNaming?.pattern ?? "N/A"}\`
- Examples: ${branchNaming?.examples?.map((e) => `\`${e}\``).join(", ") ?? "N/A"}

## Plan Content
${truncatedContent}

---
*Created by Vibe Tree | planId: ${plan.id}*
`;
}
