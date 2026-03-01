import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";

// Create in-memory database for testing
let sqlite: Database;
let testDb: ReturnType<typeof drizzle>;

function setupTestDb() {
  sqlite = new Database(":memory:");
  testDb = drizzle(sqlite, { schema });

  // Create tables (repos table removed - fetched from gh CLI now)
  sqlite.run(`
    CREATE TABLE project_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.run(`
    CREATE TABLE plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      github_issue_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.run(`
    CREATE TABLE plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES plans(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.run(`
    CREATE TABLE instructions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      plan_id INTEGER REFERENCES plans(id),
      worktree_path TEXT,
      branch_name TEXT,
      kind TEXT NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  sqlite.run(`
    CREATE TABLE tree_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      base_branch TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.run(`
    CREATE TABLE worktree_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worktree_path TEXT NOT NULL UNIQUE,
      repo_id TEXT NOT NULL,
      branch_name TEXT,
      active_agent TEXT,
      last_seen_at TEXT NOT NULL,
      note TEXT
    )
  `);
}

function clearDb() {
  sqlite.run("DELETE FROM instructions_log");
  sqlite.run("DELETE FROM plan_tasks");
  sqlite.run("DELETE FROM plans");
  sqlite.run("DELETE FROM project_rules");
  sqlite.run("DELETE FROM tree_specs");
  sqlite.run("DELETE FROM worktree_activity");
}

describe("Database Schema", () => {
  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearDb();
  });

  test("can insert project_rules with string repoId", async () => {
    const now = new Date().toISOString();
    const repoId = "kthatoto/vibe-tree";

    const rules = await testDb
      .insert(schema.projectRules)
      .values({
        repoId,
        ruleType: "branch_naming",
        ruleJson: JSON.stringify({ pattern: "vt/{planId}/{taskSlug}" }),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(rules.length).toBe(1);
    expect(rules[0]?.ruleType).toBe("branch_naming");
    expect(rules[0]?.repoId).toBe("kthatoto/vibe-tree");
  });

  test("can insert and query plans", async () => {
    const now = new Date().toISOString();
    const repoId = "owner/repo-name";

    const plans = await testDb
      .insert(schema.plans)
      .values({
        repoId,
        title: "Test Plan",
        contentMd: "# Test",
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(plans.length).toBe(1);
    expect(plans[0]?.title).toBe("Test Plan");
    expect(plans[0]?.status).toBe("draft");
    expect(plans[0]?.repoId).toBe("owner/repo-name");
  });

  test("can update plan status", async () => {
    const now = new Date().toISOString();
    const repoId = "owner/repo";

    const plans = await testDb
      .insert(schema.plans)
      .values({
        repoId,
        title: "Test Plan",
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const planId = plans[0]?.id!;

    const updated = await testDb
      .update(schema.plans)
      .set({ status: "committed", updatedAt: now })
      .where(eq(schema.plans.id, planId))
      .returning();

    expect(updated[0]?.status).toBe("committed");
  });

  test("can insert instructions_log", async () => {
    const now = new Date().toISOString();
    const repoId = "org/project";

    const logs = await testDb
      .insert(schema.instructionsLog)
      .values({
        repoId,
        kind: "user_instruction",
        contentMd: "Do something",
        createdAt: now,
      })
      .returning();

    expect(logs.length).toBe(1);
    expect(logs[0]?.kind).toBe("user_instruction");
    expect(logs[0]?.repoId).toBe("org/project");
  });

  test("can insert plan_tasks", async () => {
    const now = new Date().toISOString();
    const repoId = "owner/repo";

    const plans = await testDb
      .insert(schema.plans)
      .values({
        repoId,
        title: "Test Plan",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const planId = plans[0]?.id!;

    const tasks = await testDb
      .insert(schema.planTasks)
      .values({
        planId,
        title: "Task 1",
        description: "First task",
        status: "todo",
        orderIndex: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(tasks.length).toBe(1);
    expect(tasks[0]?.title).toBe("Task 1");
    expect(tasks[0]?.status).toBe("todo");
  });

  test("can insert and query tree_specs", async () => {
    const now = new Date().toISOString();
    const repoId = "kthatoto/vibe-tree";
    const specJson = JSON.stringify({
      nodes: [
        { id: "task-1", title: "Setup project", status: "done" },
        { id: "task-2", title: "Implement auth", status: "doing", branchName: "feature/auth" },
      ],
      edges: [{ parent: "task-1", child: "task-2" }],
    });

    const specs = await testDb
      .insert(schema.treeSpecs)
      .values({
        repoId,
        baseBranch: "main",
        specJson,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(specs.length).toBe(1);
    expect(specs[0]?.repoId).toBe("kthatoto/vibe-tree");
    expect(specs[0]?.baseBranch).toBe("main");

    const parsed = JSON.parse(specs[0]?.specJson ?? "{}");
    expect(parsed.nodes.length).toBe(2);
    expect(parsed.edges.length).toBe(1);
  });

  test("can insert and query worktree_activity", async () => {
    const now = new Date().toISOString();
    const repoId = "owner/repo";

    const activities = await testDb
      .insert(schema.worktreeActivity)
      .values({
        worktreePath: "/path/to/worktree",
        repoId,
        branchName: "feature/test",
        activeAgent: "claude",
        lastSeenAt: now,
        note: "Working on feature",
      })
      .returning();

    expect(activities.length).toBe(1);
    expect(activities[0]?.worktreePath).toBe("/path/to/worktree");
    expect(activities[0]?.activeAgent).toBe("claude");
  });

  test("worktree_path is unique", async () => {
    const now = new Date().toISOString();
    const repoId = "owner/repo";

    await testDb.insert(schema.worktreeActivity).values({
      worktreePath: "/unique/path",
      repoId,
      lastSeenAt: now,
    });

    // Try to insert duplicate
    expect(() => {
      sqlite.run(
        "INSERT INTO worktree_activity (worktree_path, repo_id, last_seen_at) VALUES ('/unique/path', 'another/repo', ?)",
        [now]
      );
    }).toThrow();
  });
});

describe("Shared Types", () => {
  test("BranchNamingRule structure", () => {
    const rule = {
      pattern: "vt/{planId}/{taskSlug}",
      description: "Test",
      examples: ["vt/1/feature"],
    };
    expect(rule.pattern).toBeDefined();
    expect(Array.isArray(rule.examples)).toBe(true);
  });

  test("Warning structure", () => {
    const warning = {
      severity: "warn" as const,
      code: "DIRTY" as const,
      message: "Test warning",
      meta: { branch: "test" },
    };
    expect(["warn", "error"]).toContain(warning.severity);
  });

  test("TreeNode structure", () => {
    const node = {
      branchName: "main",
      badges: ["dirty"],
      lastCommitAt: new Date().toISOString(),
      aheadBehind: { ahead: 0, behind: 0 },
    };
    expect(node.branchName).toBeDefined();
    expect(Array.isArray(node.badges)).toBe(true);
  });

  test("TreeSpec structure", () => {
    const spec = {
      id: 1,
      repoId: "owner/repo",
      specJson: {
        nodes: [{ branchName: "main" }],
        edges: [],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(spec.repoId).toBe("owner/repo");
    expect(Array.isArray(spec.specJson.nodes)).toBe(true);
  });
});
