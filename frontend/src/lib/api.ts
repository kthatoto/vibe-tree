const API_BASE = "/api";

// Repo from GitHub (fetched via gh CLI)
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

export interface Plan {
  id: number;
  repoId: string;
  title: string;
  contentMd: string;
  status: "draft" | "committed";
  githubIssueUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Warning {
  severity: "warn" | "error";
  code: string;
  message: string;
  meta?: Record<string, unknown>;
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
  reviewDecision?: string;
  checks?: string;
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

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  dirty: boolean;
  isActive?: boolean;
  activeAgent?: string;
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

export interface TreeEdge {
  parent: string;
  child: string;
  confidence: "high" | "medium" | "low";
  isDesigned?: boolean;
}

export type TaskStatus = "todo" | "doing" | "done";

export interface TreeSpecNode {
  id: string; // UUID for task identification
  title: string; // タスク名
  description?: string; // 完了条件/メモ
  status: TaskStatus;
  branchName?: string; // 未確定ならundefined
  // Legacy fields (optional for backward compat)
  intendedIssue?: number;
  intendedPr?: number;
}

export interface TreeSpecEdge {
  parent: string; // node id
  child: string; // node id
}

export interface TreeSpec {
  id: number;
  repoId: string;
  baseBranch: string; // default branch (develop, main, master, etc.)
  specJson: {
    nodes: TreeSpecNode[];
    edges: TreeSpecEdge[];
  };
  createdAt: string;
  updatedAt: string;
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
  restart: {
    worktreePath: string;
    cdCommand: string;
    restartPromptMd: string;
  } | null;
  treeSpec?: TreeSpec;
}

export interface InstructionLog {
  id: number;
  repoId: string;
  planId: number | null;
  worktreePath: string | null;
  branchName: string | null;
  kind: "director_suggestion" | "user_instruction" | "system_note";
  contentMd: string;
  createdAt: string;
}

export interface RepoPin {
  id: number;
  repoId: string;
  localPath: string;
  label: string | null;
  lastUsedAt: string;
  createdAt: string;
}

export interface AgentStatus {
  pid: number;
  repoId: string;
  localPath: string;
  startedAt: string;
}

export interface AiStartResult {
  status: "started" | "already_running";
  sessionId: string;
  pid: number;
  repoId: string;
  startedAt: string;
  localPath: string;
  branch?: string | null;
}

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

export interface AgentOutputData {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
}

// Chat types
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

export interface ChatMessage {
  id: number;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
}

export interface ChatSummary {
  id: number;
  sessionId: string;
  summaryMarkdown: string;
  coveredUntilMessageId: number;
  createdAt: string;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || `HTTP error: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Health
  health: () => fetchJson<{ status: string }>(`${API_BASE}/health`),

  // Repos (fetched from gh CLI)
  getRepos: () => fetchJson<Repo[]>(`${API_BASE}/repos`),
  getRepo: (owner: string, name: string) =>
    fetchJson<Repo>(`${API_BASE}/repos/${owner}/${name}`),

  // Branch Naming
  getBranchNaming: (repoId: string) =>
    fetchJson<BranchNamingRule & { id: number; repoId: string }>(
      `${API_BASE}/project-rules/branch-naming?repoId=${encodeURIComponent(repoId)}`
    ),
  updateBranchNaming: (data: {
    repoId: string;
    pattern: string;
    description: string;
    examples: string[];
  }) =>
    fetchJson<BranchNamingRule>(`${API_BASE}/project-rules/branch-naming`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Plan
  getCurrentPlan: (repoId: string) =>
    fetchJson<Plan | null>(`${API_BASE}/plan/current?repoId=${encodeURIComponent(repoId)}`),
  startPlan: (repoId: string, title: string) =>
    fetchJson<Plan>(`${API_BASE}/plan/start`, {
      method: "POST",
      body: JSON.stringify({ repoId, title }),
    }),
  updatePlan: (planId: number, contentMd: string) =>
    fetchJson<Plan>(`${API_BASE}/plan/update`, {
      method: "POST",
      body: JSON.stringify({ planId, contentMd }),
    }),
  commitPlan: (planId: number, localPath: string) =>
    fetchJson<Plan>(`${API_BASE}/plan/commit`, {
      method: "POST",
      body: JSON.stringify({ planId, localPath }),
    }),

  // Scan
  scan: (localPath: string) =>
    fetchJson<ScanSnapshot>(`${API_BASE}/scan`, {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),
  getRestartPrompt: (
    repoId: string,
    localPath: string,
    planId?: number,
    worktreePath?: string
  ) => {
    const params = new URLSearchParams({
      repoId,
      localPath,
    });
    if (planId) params.set("planId", String(planId));
    if (worktreePath) params.set("worktreePath", worktreePath);
    return fetchJson<{ cdCommand: string; restartPromptMd: string }>(
      `${API_BASE}/scan/restart-prompt?${params}`
    );
  },

  // Tree Spec
  getTreeSpec: (repoId: string) =>
    fetchJson<TreeSpec | null>(`${API_BASE}/tree-spec?repoId=${encodeURIComponent(repoId)}`),
  updateTreeSpec: (data: {
    repoId: string;
    baseBranch?: string;
    nodes: TreeSpecNode[];
    edges: TreeSpecEdge[];
  }) =>
    fetchJson<TreeSpec>(`${API_BASE}/tree-spec`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Instructions
  logInstruction: (data: {
    repoId: string;
    planId?: number;
    worktreePath?: string;
    branchName?: string;
    kind: "director_suggestion" | "user_instruction" | "system_note";
    contentMd: string;
  }) =>
    fetchJson<InstructionLog>(`${API_BASE}/instructions/log`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getInstructionLogs: (repoId: string) =>
    fetchJson<InstructionLog[]>(
      `${API_BASE}/instructions/logs?repoId=${encodeURIComponent(repoId)}`
    ),

  // Repo Pins
  getRepoPins: () => fetchJson<RepoPin[]>(`${API_BASE}/repo-pins`),
  createRepoPin: (localPath: string, label?: string) =>
    fetchJson<RepoPin>(`${API_BASE}/repo-pins`, {
      method: "POST",
      body: JSON.stringify({ localPath, label }),
    }),
  useRepoPin: (id: number) =>
    fetchJson<RepoPin>(`${API_BASE}/repo-pins/use`, {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  deleteRepoPin: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/repo-pins/${id}`, {
      method: "DELETE",
    }),

  // AI Agent
  aiStart: (localPath: string, planId?: number, branch?: string) =>
    fetchJson<AiStartResult>(`${API_BASE}/ai/start`, {
      method: "POST",
      body: JSON.stringify({ localPath, planId, branch }),
    }),
  aiStop: (pid: number) =>
    fetchJson<{ status: string; pid: number }>(`${API_BASE}/ai/stop`, {
      method: "POST",
      body: JSON.stringify({ pid }),
    }),
  aiStatus: () =>
    fetchJson<{ agents: AgentSession[] }>(`${API_BASE}/ai/status`),
  aiSessions: (repoId?: string) => {
    const params = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return fetchJson<{ sessions: AgentSession[] }>(`${API_BASE}/ai/sessions${params}`);
  },

  // Branch
  createBranch: (localPath: string, branchName: string, baseBranch: string) =>
    fetchJson<{ success: boolean; branchName: string; baseBranch: string }>(
      `${API_BASE}/branch/create`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, baseBranch }),
      }
    ),

  // Chat
  getChatSessions: (repoId: string) =>
    fetchJson<ChatSession[]>(`${API_BASE}/chat/sessions?repoId=${encodeURIComponent(repoId)}`),
  createChatSession: (repoId: string, worktreePath: string, planId?: number) =>
    fetchJson<ChatSession>(`${API_BASE}/chat/sessions`, {
      method: "POST",
      body: JSON.stringify({ repoId, worktreePath, planId }),
    }),
  archiveChatSession: (sessionId: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/chat/sessions/archive`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  getChatMessages: (sessionId: string) =>
    fetchJson<ChatMessage[]>(`${API_BASE}/chat/messages?sessionId=${encodeURIComponent(sessionId)}`),
  sendChatMessage: (sessionId: string, userMessage: string) =>
    fetchJson<{ assistantMessage: ChatMessage }>(`${API_BASE}/chat/send`, {
      method: "POST",
      body: JSON.stringify({ sessionId, userMessage }),
    }),
  summarizeChat: (sessionId: string) =>
    fetchJson<ChatSummary | { message: string }>(`${API_BASE}/chat/summarize`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  purgeChat: (sessionId: string, keepLastN?: number) =>
    fetchJson<{ deleted: number; remaining: number }>(`${API_BASE}/chat/purge`, {
      method: "POST",
      body: JSON.stringify({ sessionId, keepLastN: keepLastN ?? 50 }),
    }),
};
