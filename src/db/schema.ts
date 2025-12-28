import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Project rules (branch naming, etc.)
export const projectRules = sqliteTable("project_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(), // owner/name format (e.g., "kthatoto/vibe-tree")
  ruleType: text("rule_type").notNull(), // 'branch_naming'
  ruleJson: text("rule_json").notNull(), // JSON string
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Plans
export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  title: text("title").notNull(),
  contentMd: text("content_md").notNull().default(""),
  status: text("status").notNull().default("draft"), // 'draft' | 'committed'
  githubIssueUrl: text("github_issue_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Plan tasks
export const planTasks = sqliteTable("plan_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: integer("plan_id")
    .notNull()
    .references(() => plans.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("todo"), // 'todo' | 'doing' | 'done' | 'blocked'
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Instructions log
export const instructionsLog = sqliteTable("instructions_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  planId: integer("plan_id").references(() => plans.id),
  worktreePath: text("worktree_path"),
  branchName: text("branch_name"),
  kind: text("kind").notNull(), // 'director_suggestion' | 'user_instruction' | 'system_note'
  contentMd: text("content_md").notNull(),
  createdAt: text("created_at").notNull(),
});

// 設計ツリー (Design Tree)
export const treeSpecs = sqliteTable("tree_specs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  specJson: text("spec_json").notNull(), // JSON: { nodes: TreeSpecNode[], edges: TreeSpecEdge[] }
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Worktree activity (heartbeat cache)
export const worktreeActivity = sqliteTable("worktree_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  worktreePath: text("worktree_path").notNull().unique(),
  repoId: text("repo_id").notNull(),
  branchName: text("branch_name"),
  activeAgent: text("active_agent"), // 'claude' | null
  lastSeenAt: text("last_seen_at").notNull(),
  note: text("note"),
});
