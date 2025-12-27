import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, desc } from "drizzle-orm";
import { broadcast } from "../ws";
import { execSync } from "child_process";

export const planRouter = new Hono();

// GET /api/plan/current?repoId=...
planRouter.get("/current", async (c) => {
  const repoId = parseInt(c.req.query("repoId") || "0");
  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  // Get the latest plan for this repo
  const plans = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.repoId, repoId))
    .orderBy(desc(schema.plans.createdAt))
    .limit(1);

  if (plans.length === 0) {
    return c.json(null);
  }

  return c.json(plans[0]);
});

// POST /api/plan/start
planRouter.post("/start", async (c) => {
  const body = await c.req.json();
  const { repoId, title } = body;

  if (!repoId || !title) {
    return c.json({ error: "repoId and title are required" }, 400);
  }

  const now = new Date().toISOString();

  const result = await db
    .insert(schema.plans)
    .values({
      repoId,
      title,
      contentMd: "",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const plan = result[0];

  broadcast({
    type: "plan.updated",
    repoId,
    data: plan,
  });

  return c.json(plan, 201);
});

// POST /api/plan/update
planRouter.post("/update", async (c) => {
  const body = await c.req.json();
  const { planId, contentMd } = body;

  if (!planId) {
    return c.json({ error: "planId is required" }, 400);
  }

  const now = new Date().toISOString();

  const result = await db
    .update(schema.plans)
    .set({
      contentMd,
      updatedAt: now,
    })
    .where(eq(schema.plans.id, planId))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Plan not found" }, 404);
  }

  const plan = result[0];

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
  const { planId } = body;

  if (!planId) {
    return c.json({ error: "planId is required" }, 400);
  }

  // Get plan
  const plans = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.id, planId));

  if (plans.length === 0) {
    return c.json({ error: "Plan not found" }, 404);
  }

  const plan = plans[0];

  // Get repo
  const repos = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, plan.repoId));

  if (repos.length === 0) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const repo = repos[0];

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

  const branchNaming = rules.length > 0 ? JSON.parse(rules[0].ruleJson) : null;

  // Create GitHub Issue with minimal summary
  const issueBody = `## Goal
${plan.title}

## Project Rules
### Branch Naming
- Pattern: \`${branchNaming?.pattern || "N/A"}\`
- Examples: ${branchNaming?.examples?.map((e: string) => `\`${e}\``).join(", ") || "N/A"}

## Plan Content
${plan.contentMd.substring(0, 500)}${plan.contentMd.length > 500 ? "..." : ""}

---
*Created by Vibe Tree | planId: ${plan.id}*
`;

  let issueUrl = null;
  try {
    const result = execSync(
      `cd "${repo.path}" && gh issue create --title "${plan.title.replace(/"/g, '\\"')}" --body "${issueBody.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
      { encoding: "utf-8" }
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
    .where(eq(schema.plans.id, planId))
    .returning();

  const updatedPlan = result[0];

  broadcast({
    type: "plan.updated",
    repoId: plan.repoId,
    data: updatedPlan,
  });

  return c.json(updatedPlan);
});
