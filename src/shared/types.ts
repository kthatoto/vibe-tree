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
  patterns: string[]; // Multiple patterns allowed (e.g., ["feat_{taskSlug}", "feat_{issueId}_{taskSlug}"])
}

export interface WorktreeSettings {
  // Custom worktree creation script. Placeholders: {worktreePath}, {branchName}, {localPath}
  // If empty, uses default: git worktree add "{worktreePath}" "{branchName}"
  createScript?: string;
  // Script to run after worktree creation (in worktree directory)
  // Runs as a shell script (each line executed sequentially)
  postCreateScript?: string;
  // Script to run after worktree deletion (in main repository directory)
  postDeleteScript?: string;
  // Which worktree to use for checkout when multiple exist
  // "main" = always use main repo, "first" = use first worktree found, "ask" = show selection
  checkoutPreference?: "main" | "first" | "ask";
  // Custom command to run after worktree creation
  // Placeholders: {repo} = repository name, {branch} = branch name, {path} = worktree full path
  worktreeCreateCommand?: string;
  // Custom command to run after worktree deletion
  // Placeholders: {repo} = repository name, {branch} = branch name, {path} = worktree full path
  worktreeDeleteCommand?: string;
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
  reviewStatus?: "none" | "requested" | "reviewed" | "approved"; // Computed review status
  reviewers?: string[]; // Requested reviewers (excluding bots like GitHub Copilot)
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
  remoteAheadBehind?: { ahead: number; behind: number }; // vs origin
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

// TreeSpec status
export type TreeSpecStatus = "draft" | "confirmed" | "generated";

// 設計ツリー (tree_specs) - タスク戦略ツール
export interface TreeSpec {
  id: number;
  repoId: string;
  baseBranch: string; // default branch (develop, main, master, etc.)
  status: TreeSpecStatus;
  specJson: {
    nodes: TreeSpecNode[];
    edges: TreeSpecEdge[];
  };
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = "todo" | "doing" | "done";

export interface TreeSpecNode {
  id: string; // UUID for task identification
  title: string; // タスク名
  description?: string; // 完了条件/メモ
  status: TaskStatus;
  branchName?: string; // 未確定ならundefined
  worktreePath?: string; // Path to worktree (set after creation)
  chatSessionId?: string; // Linked chat session ID
}

export interface TreeSpecEdge {
  parent: string; // node id
  child: string; // node id
}

export interface ScanSnapshot {
  repoId: string;
  defaultBranch: string; // detected default branch (develop, main, master, etc.)
  branches: string[]; // all branch names for UI selection
  nodes: TreeNode[];
  edges: TreeEdge[];
  warnings: Warning[];
  worktrees: WorktreeInfo[];
  rules: { branchNaming: BranchNamingRule | null };
  restart: RestartInfo | null;
  treeSpec?: TreeSpec; // 設計ツリー (タスクツリー)
}

// Repo pins (saved repo/localPath pairs)
export interface RepoPin {
  id: number;
  repoId: string;
  localPath: string;
  label: string | null;
  baseBranch: string | null; // user-selected base branch
  lastUsedAt: string;
  createdAt: string;
}

// Agent status
export interface AgentStatus {
  repoId: string;
  pid: number;
  startedAt: string;
  localPath: string;
}

// Agent session
export type AgentSessionStatus = "running" | "stopped" | "exited";

export interface AgentSession {
  id: string;
  repoId: string;
  worktreePath: string;
  branch: string | null;
  status: AgentSessionStatus;
  pid: number | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

// Agent output event data
export interface AgentOutputData {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
}

// Chat session (worktree単位の対話)
export type ChatSessionStatus = "active" | "archived";

export interface ChatSession {
  id: string;
  repoId: string;
  worktreePath: string;
  branchName: string | null;
  planId: number | null;
  status: ChatSessionStatus;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatMode = "planning" | "execution";
export type InstructionEditStatus = "committed" | "rejected";

export interface ChatMessage {
  id: number;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  chatMode?: ChatMode | null;
  instructionEditStatus?: InstructionEditStatus | null;
  createdAt: string;
}

export interface ChatSummary {
  id: number;
  sessionId: string;
  summaryMarkdown: string;
  coveredUntilMessageId: number;
  createdAt: string;
}

export type AgentRunStatus = "running" | "success" | "failed";

export interface AgentRun {
  id: number;
  sessionId: string | null;
  repoId: string;
  worktreePath: string;
  inputPromptDigest: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: AgentRunStatus;
  stdoutSnippet: string | null;
  stderrSnippet: string | null;
  createdAt: string;
}

// Chat send response
export interface ChatSendResponse {
  assistantMessage: ChatMessage;
  updatedScan?: ScanSnapshot;
}

// WebSocket message types
export type WSMessageType =
  | "projectRules.updated"
  | "plan.updated"
  | "scan.updated"
  | "instructions.logged"
  | "agent.started"
  | "agent.finished"
  | "agent.stopped"
  | "agent.output"
  | "chat.message"
  | "taskInstruction.created"
  | "taskInstruction.updated"
  | "taskInstruction.confirmed"
  | "taskInstruction.unconfirmed";

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  repoId?: string;
  data?: T;
}
