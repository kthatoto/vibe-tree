import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq } from "drizzle-orm";
import { broadcast } from "../ws";

export const reposRouter = new Hono();

// GET /api/repos
reposRouter.get("/", async (c) => {
  const repos = await db.select().from(schema.repos);
  return c.json(repos);
});

// POST /api/repos - Register a new repo
reposRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { path, name } = body;

  if (!path) {
    return c.json({ error: "path is required" }, 400);
  }

  const repoName = name || path.split("/").pop() || "unknown";
  const now = new Date().toISOString();

  // Insert repo
  const result = await db
    .insert(schema.repos)
    .values({
      path,
      name: repoName,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const repo = result[0];

  // Initialize branch_naming rule
  const defaultBranchNaming = {
    pattern: "vt/{planId}/{taskSlug}",
    description: "Default branch naming pattern for Vibe Tree",
    examples: [
      "vt/1/add-auth",
      "vt/2/fix-bug",
      "vt/3/refactor-api",
    ],
  };

  await db.insert(schema.projectRules).values({
    repoId: repo.id,
    ruleType: "branch_naming",
    ruleJson: JSON.stringify(defaultBranchNaming),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return c.json(repo, 201);
});

// GET /api/repos/:id
reposRouter.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const repo = await db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, id));
  if (repo.length === 0) {
    return c.json({ error: "Repo not found" }, 404);
  }
  return c.json(repo[0]);
});
