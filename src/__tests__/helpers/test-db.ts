import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema";

let testSqlite: Database;
let testDb: ReturnType<typeof drizzle>;

export function setupTestDb() {
  testSqlite = new Database(":memory:");
  testDb = drizzle(testSqlite, { schema });

  testSqlite.run(`
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

  testSqlite.run(`
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

  testSqlite.run(`
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

  testSqlite.run(`
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

  testSqlite.run(`
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

  testSqlite.run(`
    CREATE TABLE planning_sessions (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      title TEXT,
      type TEXT NOT NULL DEFAULT 'refinement',
      base_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      nodes_json TEXT NOT NULL DEFAULT '[]',
      edges_json TEXT NOT NULL DEFAULT '[]',
      chat_session_id TEXT,
      execute_branches_json TEXT,
      current_execute_index INTEGER DEFAULT 0,
      selected_worktree_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
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

  testSqlite.run(`
    CREATE TABLE repo_pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      label TEXT,
      base_branch TEXT,
      cached_branches_json TEXT,
      cached_edges_json TEXT,
      cached_snapshot_json TEXT,
      cached_snapshot_updated_at TEXT,
      cached_snapshot_version INTEGER DEFAULT 0,
      last_used_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT,
      status TEXT NOT NULL,
      pid INTEGER,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER
    )
  `);

  testSqlite.run(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT,
      plan_id INTEGER REFERENCES plans(id),
      status TEXT NOT NULL DEFAULT 'active',
      last_used_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      chat_mode TEXT,
      instruction_edit_status TEXT,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE chat_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      summary_markdown TEXT NOT NULL,
      covered_until_message_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE terminal_sessions (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'stopped',
      last_output TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE requirements_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      plan_id INTEGER REFERENCES plans(id),
      note_type TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      notion_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE external_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_session_id TEXT NOT NULL,
      branch_name TEXT,
      link_type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      content_cache TEXT,
      last_fetched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE task_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      branch_name TEXT,
      instruction_md TEXT NOT NULL,
      abstracted_rules TEXT,
      confirmed_at TEXT,
      confirmed_content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES chat_sessions(id),
      repo_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      input_prompt_digest TEXT,
      pid INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      stdout_snippet TEXT,
      stderr_snippet TEXT,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE task_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      planning_session_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      order_index INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE planning_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_session_id TEXT NOT NULL,
      branch_name TEXT,
      question TEXT NOT NULL,
      assumption TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE branch_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      link_type TEXT NOT NULL,
      url TEXT NOT NULL,
      number INTEGER,
      title TEXT,
      status TEXT,
      checks_status TEXT,
      review_decision TEXT,
      review_status TEXT,
      checks TEXT,
      labels TEXT,
      reviewers TEXT,
      project_status TEXT,
      base_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE branch_descriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE chat_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      segment_index INTEGER NOT NULL,
      start_message_id INTEGER NOT NULL,
      end_message_id INTEGER,
      summary_markdown TEXT,
      token_estimate INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES chat_sessions(id),
      message_id INTEGER REFERENCES chat_messages(id),
      artifact_type TEXT NOT NULL,
      ref_id TEXT NOT NULL UNIQUE,
      content_hash TEXT,
      content TEXT NOT NULL,
      summary_markdown TEXT,
      token_estimate INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE figma_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_link_id INTEGER NOT NULL REFERENCES external_links(id),
      file_key TEXT NOT NULL,
      node_id TEXT,
      snapshot_type TEXT NOT NULL,
      content TEXT NOT NULL,
      version TEXT,
      fetched_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      message_id INTEGER REFERENCES chat_messages(id),
      prompt_tokens INTEGER,
      included_segments TEXT,
      included_artifacts TEXT,
      compression_ratio INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE branch_external_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      link_type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      content_cache TEXT,
      last_fetched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE repo_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      description TEXT,
      synced_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE repo_collaborators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      login TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      role TEXT,
      synced_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE repo_teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      synced_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE branch_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      file_size INTEGER,
      description TEXT,
      source_type TEXT,
      source_url TEXT,
      created_at TEXT NOT NULL
    )
  `);

  testSqlite.run(`
    CREATE TABLE scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      scan_session_id TEXT,
      log_type TEXT NOT NULL,
      message TEXT NOT NULL,
      html TEXT,
      branch_name TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )
  `);

  return { testDb, testSqlite };
}

export function clearAllTables() {
  const tables = [
    "scan_logs", "branch_files", "repo_teams", "repo_collaborators", "repo_labels",
    "branch_external_links", "context_snapshots", "figma_snapshots", "artifacts",
    "chat_segments", "branch_descriptions", "branch_links", "planning_questions",
    "task_todos", "agent_runs", "task_instructions", "external_links",
    "requirements_notes", "terminal_sessions", "chat_summaries", "chat_messages",
    "chat_sessions", "agent_sessions", "repo_pins", "worktree_activity",
    "planning_sessions", "tree_specs", "instructions_log", "plan_tasks",
    "plans", "project_rules",
  ];
  for (const table of tables) {
    testSqlite.run(`DELETE FROM ${table}`);
  }
}

export function closeDb() {
  testSqlite.close();
}

export { testDb, testSqlite };
