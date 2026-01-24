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

// 設計ツリー (Design Tree / Task Tree) - DEPRECATED: use planningSessions
export const treeSpecs = sqliteTable("tree_specs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  baseBranch: text("base_branch"), // default branch (develop, main, master, etc.)
  status: text("status").notNull().default("draft"), // 'draft' | 'confirmed' | 'generated'
  specJson: text("spec_json").notNull(), // JSON: { nodes: TreeSpecNode[], edges: TreeSpecEdge[] }
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Planning sessions (複数のプランニングセッション)
export const planningSessions = sqliteTable("planning_sessions", {
  id: text("id").primaryKey(), // uuid
  repoId: text("repo_id").notNull(),
  title: text("title").notNull().default("Untitled"),
  type: text("type").notNull().default("refinement"), // 'refinement' | 'planning' | 'execute'
  baseBranch: text("base_branch").notNull(),
  status: text("status").notNull().default("draft"), // 'draft' | 'confirmed' | 'discarded'
  nodesJson: text("nodes_json").notNull().default("[]"), // JSON array of task nodes
  edgesJson: text("edges_json").notNull().default("[]"), // JSON array of task edges
  chatSessionId: text("chat_session_id"), // linked chat session
  executeBranchesJson: text("execute_branches_json"), // JSON array of branch names for execute session ["branch1", "branch2"]
  currentExecuteIndex: integer("current_execute_index").default(0), // current index in executeBranchesJson
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

// Repo pins (saved repo/localPath pairs for quick access)
export const repoPins = sqliteTable("repo_pins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  localPath: text("local_path").notNull().unique(),
  label: text("label"), // optional display name
  baseBranch: text("base_branch"), // user-selected base branch
  lastUsedAt: text("last_used_at").notNull(),
  createdAt: text("created_at").notNull(),
});

// Agent sessions (Claude Code sessions)
export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(), // uuid
  repoId: text("repo_id").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch"),
  status: text("status").notNull(), // 'running' | 'stopped' | 'exited'
  pid: integer("pid"),
  startedAt: text("started_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  endedAt: text("ended_at"),
  exitCode: integer("exit_code"),
});

// Chat sessions (worktree単位の対話セッション)
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(), // uuid
  repoId: text("repo_id").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branchName: text("branch_name"),
  planId: integer("plan_id").references(() => plans.id),
  status: text("status").notNull().default("active"), // 'active' | 'archived'
  lastUsedAt: text("last_used_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Chat messages
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id),
  role: text("role").notNull(), // 'user' | 'assistant' | 'system'
  content: text("content").notNull(),
  chatMode: text("chat_mode"), // 'planning' | 'execution' | null
  instructionEditStatus: text("instruction_edit_status"), // null | 'committed' | 'rejected'
  createdAt: text("created_at").notNull(),
});

// Chat summaries (会話圧縮用)
export const chatSummaries = sqliteTable("chat_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id),
  summaryMarkdown: text("summary_markdown").notNull(),
  coveredUntilMessageId: integer("covered_until_message_id").notNull(),
  createdAt: text("created_at").notNull(),
});

// Terminal sessions (PTY sessions for worktrees)
export const terminalSessions = sqliteTable("terminal_sessions", {
  id: text("id").primaryKey(), // uuid
  repoId: text("repo_id").notNull(),
  worktreePath: text("worktree_path").notNull().unique(),
  pid: integer("pid"),
  status: text("status").notNull().default("stopped"), // 'running' | 'stopped'
  lastOutput: text("last_output"), // Last N KB of output for reconnection
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
});

// Requirements notes (PRD/Notion/分解メモ)
export const requirementsNotes = sqliteTable("requirements_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  planId: integer("plan_id").references(() => plans.id),
  noteType: text("note_type").notNull(), // 'prd' | 'notion' | 'memo' | 'task_breakdown'
  title: text("title"),
  content: text("content").notNull().default(""), // Optional - can be empty for notion links
  notionUrl: text("notion_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// External links (Notion, Figma, GitHub Issue, etc.) - per planning session
export const externalLinks = sqliteTable("external_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planningSessionId: text("planning_session_id").notNull(), // references planning_sessions.id
  linkType: text("link_type").notNull(), // 'notion' | 'figma' | 'github_issue' | 'github_pr' | 'url'
  url: text("url").notNull(),
  title: text("title"), // extracted or user-provided title
  contentCache: text("content_cache"), // cached content (markdown)
  lastFetchedAt: text("last_fetched_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Task instructions (per-branch memos)
export const taskInstructions = sqliteTable("task_instructions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  taskId: text("task_id").notNull(), // TreeSpecNode.id
  branchName: text("branch_name"),
  instructionMd: text("instruction_md").notNull(), // initial plan/instruction
  abstractedRules: text("abstracted_rules"), // JSON: extracted patterns/rules
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Agent runs (Claude Code実行ログ)
export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").references(() => chatSessions.id),
  repoId: text("repo_id").notNull(),
  worktreePath: text("worktree_path").notNull(),
  inputPromptDigest: text("input_prompt_digest"), // hash of prompt
  pid: integer("pid"), // Process ID for cancellation
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(), // 'running' | 'success' | 'failed' | 'cancelled'
  stdoutSnippet: text("stdout_snippet"),
  stderrSnippet: text("stderr_snippet"),
  createdAt: text("created_at").notNull(),
});

// Branch links (issues and PRs linked to branches)
export const branchLinks = sqliteTable("branch_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  branchName: text("branch_name").notNull(),
  linkType: text("link_type").notNull(), // 'issue' | 'pr'
  url: text("url").notNull(),
  number: integer("number"), // Issue or PR number
  title: text("title"), // Issue or PR title
  status: text("status"), // 'open' | 'merged' | 'closed'
  checksStatus: text("checks_status"), // PR: 'pending' | 'success' | 'failure'
  reviewDecision: text("review_decision"), // PR: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviewStatus: text("review_status"), // PR: 'none' | 'requested' | 'reviewed' | 'approved'
  checks: text("checks"), // JSON array of individual checks [{name, status, conclusion}]
  labels: text("labels"), // JSON array of label names
  reviewers: text("reviewers"), // JSON array of reviewer logins
  projectStatus: text("project_status"), // GitHub Projects status
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
