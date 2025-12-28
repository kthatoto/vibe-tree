// Shared types between backend and frontend

// Repo from GitHub
export interface Repo {
  id: string; // owner/name format
  name: string;
  fullName: string;
  url: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export interface BranchNamingRule {
  pattern: string;
  description: string;
  examples: string[];
}

export interface ProjectRule {
  id: number;
  repoId: string; // owner/name format
  ruleType: "branch_naming";
  ruleJson: BranchNamingRule;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus = "draft" | "committed";

export interface Plan {
  id: number;
  repoId: string;
  title: string;
  contentMd: string;
  status: PlanStatus;
  githubIssueUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PlanTaskStatus = "todo" | "doing" | "done" | "blocked";

export interface PlanTask {
  id: number;
  planId: number;
  title: string;
  description: string;
  status: PlanTaskStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

export type InstructionKind =
  | "director_suggestion"
  | "user_instruction"
  | "system_note";

export interface InstructionLog {
  id: number;
  repoId: string;
  planId: number | null;
  worktreePath: string | null;
  branchName: string | null;
  kind: InstructionKind;
  contentMd: string;
  createdAt: string;
}

// Scan types
export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  dirty: boolean;
  isActive?: boolean; // heartbeat active
  activeAgent?: string; // e.g., "claude"
}

export interface PRInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  branch: string;
  isDraft?: boolean;
  labels?: string[];
  assignees?: string[];
  reviewDecision?: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  checks?: string; // SUCCESS, FAILURE, PENDING
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface IssueInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  labels?: string[];
  assignees?: string[];
  parentIssue?: number;
  childIssues?: number[];
}

export type WarningSeverity = "warn" | "error";
export type WarningCode =
  | "BEHIND_PARENT"
  | "DIRTY"
  | "CI_FAIL"
  | "ORDER_BROKEN"
  | "BRANCH_NAMING_VIOLATION"
  | "TREE_DIVERGENCE"; // 設計ツリーとGit実態の乖離

export interface Warning {
  severity: WarningSeverity;
  code: WarningCode;
  message: string;
  meta?: Record<string, unknown>;
}

export interface TreeNode {
  branchName: string;
  badges: string[];
  pr?: PRInfo;
  issue?: IssueInfo;
  worktree?: WorktreeInfo;
  lastCommitAt: string;
  aheadBehind?: { ahead: number; behind: number };
}

export type EdgeConfidence = "high" | "medium" | "low";

export interface TreeEdge {
  parent: string;
  child: string;
  confidence: EdgeConfidence;
  isDesigned?: boolean; // true if from tree_specs (設計ツリー)
}

export interface RestartInfo {
  worktreePath: string;
  cdCommand: string;
  restartPromptMd: string;
}

// 設計ツリー (tree_specs)
export interface TreeSpec {
  id: number;
  repoId: string;
  specJson: {
    nodes: TreeSpecNode[];
    edges: TreeSpecEdge[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface TreeSpecNode {
  branchName: string;
  intendedIssue?: number;
  intendedPr?: number;
  description?: string;
}

export interface TreeSpecEdge {
  parent: string;
  child: string;
}

export interface ScanSnapshot {
  nodes: TreeNode[];
  edges: TreeEdge[];
  warnings: Warning[];
  worktrees: WorktreeInfo[];
  rules: { branchNaming: BranchNamingRule | null };
  restart: RestartInfo | null;
  treeSpec?: TreeSpec; // 設計ツリー
}

// WebSocket message types
export type WSMessageType =
  | "projectRules.updated"
  | "plan.updated"
  | "scan.updated"
  | "instructions.logged";

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  repoId?: string;
  data?: T;
}
