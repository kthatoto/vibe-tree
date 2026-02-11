import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Get DB path from environment or use default
function getDbPath(): string {
  if (process.env.VIBE_TREE_DB) {
    return process.env.VIBE_TREE_DB;
  }

  // Try to find the DB in common locations
  const possiblePaths = [
    path.join(process.cwd(), ".vibetree", "vibetree.sqlite"),
    path.join(process.env.HOME || "", ".vibetree", "vibetree.sqlite"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    "Database not found. Please set VIBE_TREE_DB environment variable."
  );
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
  }
  return db;
}

// Get the base storage path (same directory as the DB)
export function getStorageBasePath(): string {
  const dbPath = getDbPath();
  // DB is at .vibetree/vibetree.sqlite, so storage is at .vibetree/storage/
  return path.join(path.dirname(dbPath), "storage");
}

// Helper functions for common operations

export function getSession(sessionId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM planning_sessions WHERE id = ?`
    )
    .get(sessionId) as PlanningSessionRow | undefined;
}

export function getSessionByRepoAndBranch(repoId: string, branchName: string) {
  const db = getDb();
  // Find session that has this branch in executeBranchesJson
  const sessions = db
    .prepare(
      `SELECT * FROM planning_sessions
       WHERE repo_id = ?
       AND type IN ('execute', 'planning')
       AND status = 'draft'
       ORDER BY updated_at DESC`
    )
    .all(repoId) as PlanningSessionRow[];

  for (const session of sessions) {
    if (session.execute_branches_json) {
      const branches = JSON.parse(session.execute_branches_json) as string[];
      if (branches.includes(branchName)) {
        return session;
      }
    }
  }
  return undefined;
}

export function getInstruction(repoId: string, branchName: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM task_instructions
       WHERE repo_id = ? AND branch_name = ?`
    )
    .get(repoId, branchName) as TaskInstructionRow | undefined;
}

export function getTodos(repoId: string, branchName: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM task_todos
       WHERE repo_id = ? AND branch_name = ?
       ORDER BY order_index ASC`
    )
    .all(repoId, branchName) as TaskTodoRow[];
}

export function getQuestions(planningSessionId: string, branchName?: string) {
  const db = getDb();
  if (branchName) {
    return db
      .prepare(
        `SELECT * FROM planning_questions
         WHERE planning_session_id = ? AND (branch_name = ? OR branch_name IS NULL)
         ORDER BY order_index ASC`
      )
      .all(planningSessionId, branchName) as PlanningQuestionRow[];
  }
  return db
    .prepare(
      `SELECT * FROM planning_questions
       WHERE planning_session_id = ?
       ORDER BY order_index ASC`
    )
    .all(planningSessionId) as PlanningQuestionRow[];
}

// Type definitions for DB rows (matching schema)
export interface PlanningSessionRow {
  id: string;
  repo_id: string;
  title: string;
  type: string;
  base_branch: string;
  status: string;
  nodes_json: string;
  edges_json: string;
  chat_session_id: string | null;
  execute_branches_json: string | null;
  current_execute_index: number;
  created_at: string;
  updated_at: string;
}

export interface TaskInstructionRow {
  id: number;
  repo_id: string;
  task_id: string;
  branch_name: string | null;
  instruction_md: string;
  abstracted_rules: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskTodoRow {
  id: number;
  repo_id: string;
  branch_name: string;
  planning_session_id: string | null;
  title: string;
  description: string | null;
  status: string;
  order_index: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface PlanningQuestionRow {
  id: number;
  planning_session_id: string;
  branch_name: string | null;
  question: string;
  assumption: string | null;
  status: string;
  answer: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
}
