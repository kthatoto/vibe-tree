import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable("repos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

export const projectRules = sqliteTable("project_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repos.id),
  ruleType: text("rule_type").notNull(), // 'branch_naming'
  ruleJson: text("rule_json").notNull(), // JSON string: { pattern, description, examples[] }
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repos.id),
  title: text("title").notNull(),
  contentMd: text("content_md").notNull().default(""),
  status: text("status").notNull().default("draft"), // 'draft' | 'committed'
  githubIssueUrl: text("github_issue_url"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

export const planTasks = sqliteTable("plan_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: integer("plan_id")
    .notNull()
    .references(() => plans.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("todo"), // 'todo' | 'doing' | 'done' | 'blocked'
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

export const instructionsLog = sqliteTable("instructions_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repos.id),
  planId: integer("plan_id").references(() => plans.id),
  worktreePath: text("worktree_path"),
  branchName: text("branch_name"),
  kind: text("kind").notNull(), // 'director_suggestion' | 'user_instruction' | 'system_note'
  contentMd: text("content_md").notNull(),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
