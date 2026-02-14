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
  patterns: string[];
}

export interface WorktreeSettings {
  createScript?: string;
  postCreateScript?: string;
  postDeleteScript?: string;
  checkoutPreference?: "main" | "first" | "ask";
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
  reviewStatus?: "none" | "requested" | "reviewed" | "approved";
  reviewers?: string[];
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
  remoteAheadBehind?: { ahead: number; behind: number };
}

export interface TreeEdge {
  parent: string;
  child: string;
  confidence: "high" | "medium" | "low";
  isDesigned?: boolean;
}

export type TaskStatus = "todo" | "doing" | "done";
export type TreeSpecStatus = "draft" | "confirmed" | "generated";

export interface TreeSpecNode {
  id: string; // UUID for task identification
  title: string; // タスク名
  description?: string; // 完了条件/メモ
  status: TaskStatus;
  branchName?: string; // 未確定ならundefined
  worktreePath?: string; // Path to worktree (set after creation)
  chatSessionId?: string; // Linked chat session ID
  prUrl?: string; // PR URL (set after creation)
  prNumber?: number; // PR number (set after creation)
}

export interface TreeSpecEdge {
  parent: string; // node id
  child: string; // node id
}

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
  baseBranch: string | null;
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

// Terminal types
export type TerminalSessionStatus = "running" | "stopped";

export interface TerminalSession {
  id: string;
  repoId: string;
  worktreePath: string;
  pid: number | null;
  status: TerminalSessionStatus;
  lastOutput: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

// Requirements types
export type RequirementsNoteType = "prd" | "notion" | "memo" | "task_breakdown";

export interface RequirementsNote {
  id: number;
  repoId: string;
  planId: number | null;
  noteType: RequirementsNoteType;
  title: string | null;
  content: string;
  notionUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// External Links types
export type ExternalLinkType = "notion" | "figma" | "github_issue" | "github_pr" | "url";

export interface ExternalLink {
  id: number;
  planningSessionId: string;
  branchName: string | null; // null = session-level, set = branch-specific
  linkType: ExternalLinkType;
  url: string;
  title: string | null;
  contentCache: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Planning Session types
export type PlanningSessionStatus = "draft" | "confirmed" | "discarded";
export type PlanningSessionType = "refinement" | "planning" | "execute";

export interface TaskNode {
  id: string;
  title: string;
  description?: string;
  branchName?: string;
  issueUrl?: string; // GitHub issue URL
}

export interface TaskEdge {
  parent: string;
  child: string;
}

export interface PlanningSession {
  id: string;
  repoId: string;
  title: string;
  type: PlanningSessionType;
  baseBranch: string;
  status: PlanningSessionStatus;
  nodes: TaskNode[];
  edges: TaskEdge[];
  chatSessionId: string | null;
  executeBranches: string[] | null; // Selected branches for execute session
  currentExecuteIndex: number; // Current index in executeBranches
  selectedWorktreePath: string | null; // Selected worktree path for execute session
  createdAt: string;
  updatedAt: string;
}

// Task Instruction types
export type InstructionConfirmationStatus = "unconfirmed" | "confirmed" | "changed";

export interface TaskInstruction {
  id: number | null;
  repoId: string;
  taskId: string | null;
  branchName: string | null;
  instructionMd: string;
  abstractedRules?: string | null;
  confirmedAt?: string | null;
  confirmedContentHash?: string | null;
  confirmationStatus: InstructionConfirmationStatus;
  createdAt?: string;
  updatedAt?: string;
}

// Task Todo types
export type TaskTodoStatus = "pending" | "in_progress" | "completed";
export type TaskTodoSource = "user" | "ai";

export interface TaskTodo {
  id: number;
  repoId: string;
  branchName: string;
  planningSessionId: string | null;
  title: string;
  description: string | null;
  status: TaskTodoStatus;
  orderIndex: number;
  source: TaskTodoSource;
  createdAt: string;
  updatedAt: string;
}

// Planning Question types
export type PlanningQuestionStatus = "pending" | "answered" | "skipped";

export interface PlanningQuestion {
  id: number;
  planningSessionId: string;
  branchName: string | null;
  question: string;
  assumption: string | null;
  status: PlanningQuestionStatus;
  answer: string | null;
  acknowledged: boolean;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

// Branch Link types
export type BranchLinkType = "issue" | "pr";

// Branch Resource types
export type BranchExternalLinkType = "figma" | "notion" | "github_issue" | "url";

export interface BranchExternalLink {
  id: number;
  repoId: string;
  branchName: string;
  linkType: BranchExternalLinkType;
  url: string;
  title: string | null;
  description: string | null;
  contentCache: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BranchFile {
  id: number;
  repoId: string;
  branchName: string;
  filePath: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  description: string | null;
  sourceType: string | null; // 'figma_mcp' | 'upload' | 'screenshot'
  sourceUrl: string | null;
  createdAt: string;
}

export interface GitHubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface BranchLink {
  id: number;
  repoId: string;
  branchName: string;
  linkType: BranchLinkType;
  url: string;
  number: number | null;
  title: string | null;
  status: string | null;
  checksStatus: string | null;
  reviewDecision: string | null; // 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: string | null; // JSON array of GitHubCheck
  labels: string | null; // JSON array
  reviewers: string | null; // JSON array
  projectStatus: string | null;
  baseBranch: string | null; // PR base branch (target branch)
  createdAt: string;
  updatedAt: string;
}

export interface BranchDescription {
  id: number;
  repoId: string;
  branchName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
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
  updateBranchNaming: (data: { repoId: string; patterns: string[] }) =>
    fetchJson<BranchNamingRule>(`${API_BASE}/project-rules/branch-naming`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Worktree Settings
  getWorktreeSettings: (repoId: string) =>
    fetchJson<WorktreeSettings & { id: number | null; repoId: string }>(
      `${API_BASE}/project-rules/worktree?repoId=${encodeURIComponent(repoId)}`
    ),
  updateWorktreeSettings: (data: {
    repoId: string;
    createScript?: string;
    postCreateScript?: string;
    postDeleteScript?: string;
    checkoutPreference?: "main" | "first" | "ask";
    worktreeCreateCommand?: string;
    worktreeDeleteCommand?: string;
  }) =>
    fetchJson<WorktreeSettings>(`${API_BASE}/project-rules/worktree`, {
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
  getSnapshot: (pinId: number) =>
    fetchJson<{ snapshot: ScanSnapshot; version: number }>(`${API_BASE}/scan/snapshot/${pinId}`),
  startScan: (localPath: string) =>
    fetchJson<{ started: boolean; repoId: string }>(`${API_BASE}/scan`, {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),
  // Legacy scan (for compatibility) - now just starts scan
  scan: (localPath: string) =>
    fetchJson<{ started: boolean; repoId: string }>(`${API_BASE}/scan`, {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),
  fetch: (localPath: string) =>
    fetchJson<{ success: boolean; branchStatus: Record<string, { ahead: number; behind: number }> }>(`${API_BASE}/scan/fetch`, {
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
  cleanupStaleData: (localPath: string) =>
    fetchJson<{
      success: boolean;
      repoId: string;
      cleanupResults: Record<string, number>;
      totalDeleted: number;
      actualBranchCount: number;
    }>(`${API_BASE}/scan/cleanup-stale`, {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),

  // Tree Spec
  getTreeSpec: (repoId: string) =>
    fetchJson<TreeSpec | null>(`${API_BASE}/tree-spec?repoId=${encodeURIComponent(repoId)}`),
  updateTreeSpec: (data: {
    repoId: string;
    baseBranch?: string;
    nodes: TreeSpecNode[];
    edges: TreeSpecEdge[];
    siblingOrder?: Record<string, string[]>;
  }) =>
    fetchJson<TreeSpec>(`${API_BASE}/tree-spec`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  confirmTreeSpec: (repoId: string) =>
    fetchJson<TreeSpec>(`${API_BASE}/tree-spec/confirm`, {
      method: "POST",
      body: JSON.stringify({ repoId }),
    }),
  unconfirmTreeSpec: (repoId: string) =>
    fetchJson<TreeSpec>(`${API_BASE}/tree-spec/unconfirm`, {
      method: "POST",
      body: JSON.stringify({ repoId }),
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
  updateRepoPin: (id: number, updates: { label?: string; baseBranch?: string | null }) =>
    fetchJson<RepoPin>(`${API_BASE}/repo-pins/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
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
  createTree: (
    repoId: string,
    localPath: string,
    tasks: Array<{
      id: string;
      branchName: string;
      parentBranch: string;
      worktreeName: string;
      title?: string;
      description?: string;
    }>,
    options?: { createPrs?: boolean; baseBranch?: string }
  ) =>
    fetchJson<{
      success: boolean;
      worktreesDir: string;
      results: Array<{
        taskId: string;
        branchName: string;
        worktreePath: string;
        chatSessionId: string;
        prUrl?: string;
        prNumber?: number;
        success: boolean;
        error?: string;
      }>;
      summary: { total: number; success: number; failed: number };
    }>(`${API_BASE}/branch/create-tree`, {
      method: "POST",
      body: JSON.stringify({
        repoId,
        localPath,
        tasks,
        createPrs: options?.createPrs ?? false,
        baseBranch: options?.baseBranch,
      }),
    }),

  // Chat
  getChatSessions: (repoId: string) =>
    fetchJson<ChatSession[]>(`${API_BASE}/chat/sessions?repoId=${encodeURIComponent(repoId)}`),
  createChatSession: (repoId: string, worktreePath: string, branchName: string, planId?: number) =>
    fetchJson<ChatSession>(`${API_BASE}/chat/sessions`, {
      method: "POST",
      body: JSON.stringify({ repoId, worktreePath, branchName, planId }),
    }),
  createChatPlanningSession: (repoId: string, localPath: string) =>
    fetchJson<ChatSession>(`${API_BASE}/chat/sessions/planning`, {
      method: "POST",
      body: JSON.stringify({ repoId, localPath }),
    }),
  archiveChatSession: (sessionId: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/chat/sessions/archive`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  getChatMessages: (sessionId: string, options?: { limit?: number; before?: number }) => {
    const params = new URLSearchParams({ sessionId });
    if (options?.limit) params.append("limit", String(options.limit));
    if (options?.before) params.append("before", String(options.before));
    return fetchJson<ChatMessage[]>(`${API_BASE}/chat/messages?${params.toString()}`);
  },
  checkChatRunning: (sessionId: string) =>
    fetchJson<{ isRunning: boolean }>(`${API_BASE}/chat/running?sessionId=${encodeURIComponent(sessionId)}`),
  cancelChat: (sessionId: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/chat/cancel`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  sendChatMessage: (sessionId: string, userMessage: string, context?: string, chatMode?: ChatMode, quickMode?: boolean) =>
    fetchJson<{ userMessage: ChatMessage; runId: number; status: string }>(`${API_BASE}/chat/send`, {
      method: "POST",
      body: JSON.stringify({ sessionId, userMessage, context, chatMode, quickMode }),
    }),
  updateInstructionEditStatus: (messageId: number, status: InstructionEditStatus) =>
    fetchJson<{ success: boolean; status: InstructionEditStatus }>(
      `${API_BASE}/chat/messages/${messageId}/instruction-status`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }
    ),
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
  getStreamingState: (sessionId: string) =>
    fetchJson<{
      isStreaming: boolean;
      runId?: number;
      chunks: Array<{
        type: "thinking" | "text" | "tool_use" | "tool_result";
        content?: string;
        toolName?: string;
        toolInput?: unknown;
      }>;
    }>(`${API_BASE}/chat/streaming/${sessionId}`),

  // Get artifact by reference ID
  getArtifact: (refId: string) =>
    fetchJson<{
      refId: string;
      artifactType: string;
      content: string;
      summary: string | null;
      tokenEstimate: number | null;
      metadata: Record<string, unknown> | null;
      createdAt: string;
    }>(`${API_BASE}/chat/artifacts/${refId}`),

  // Get context compression stats
  getContextStats: (sessionId: string) =>
    fetchJson<{
      messageCount: number;
      coveredMessages: number;
      uncoveredMessages: number;
      summaryCount: number;
      artifactCount: number;
      totalRawTokens: number;
      artifactsTokensSaved: number;
      latestSummary: {
        coveredUntilMessageId: number;
        createdAt: string;
      } | null;
    }>(`${API_BASE}/chat/context-stats/${sessionId}`),

  // Terminal
  createTerminalSession: (repoId: string, worktreePath: string) =>
    fetchJson<TerminalSession>(`${API_BASE}/term/sessions`, {
      method: "POST",
      body: JSON.stringify({ repoId, worktreePath }),
    }),
  startTerminalSession: (sessionId: string, cols?: number, rows?: number) =>
    fetchJson<{ id: string; status: string; pid: number; message?: string }>(
      `${API_BASE}/term/sessions/${sessionId}/start`,
      {
        method: "POST",
        body: JSON.stringify({ cols, rows }),
      }
    ),
  stopTerminalSession: (sessionId: string) =>
    fetchJson<{ id: string; status: string }>(`${API_BASE}/term/sessions/${sessionId}/stop`, {
      method: "POST",
    }),
  getTerminalSession: (sessionId: string) =>
    fetchJson<TerminalSession>(`${API_BASE}/term/sessions/${sessionId}`),

  // Requirements
  getRequirements: (repoId: string) =>
    fetchJson<RequirementsNote[]>(`${API_BASE}/requirements?repoId=${encodeURIComponent(repoId)}`),
  createRequirement: (data: {
    repoId: string;
    planId?: number;
    noteType: RequirementsNoteType;
    title?: string;
    content?: string;
    notionUrl?: string;
  }) =>
    fetchJson<RequirementsNote>(`${API_BASE}/requirements`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateRequirement: (id: number, data: {
    noteType?: RequirementsNoteType;
    title?: string;
    content?: string;
    notionUrl?: string;
  }) =>
    fetchJson<RequirementsNote>(`${API_BASE}/requirements/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteRequirement: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/requirements/${id}`, {
      method: "DELETE",
    }),
  parseTasks: (content: string) =>
    fetchJson<{ tasks: { title: string; description?: string }[] }>(
      `${API_BASE}/requirements/parse-tasks`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      }
    ),

  // External Links
  getExternalLinks: (planningSessionId: string, branchName?: string) =>
    fetchJson<ExternalLink[]>(`${API_BASE}/external-links?planningSessionId=${encodeURIComponent(planningSessionId)}${branchName ? `&branchName=${encodeURIComponent(branchName)}` : ''}`),
  addExternalLink: (planningSessionId: string, url: string, title?: string, branchName?: string) =>
    fetchJson<ExternalLink>(`${API_BASE}/external-links`, {
      method: "POST",
      body: JSON.stringify({ planningSessionId, url, title, branchName }),
    }),
  refreshExternalLink: (id: number) =>
    fetchJson<ExternalLink>(`${API_BASE}/external-links/${id}/refresh`, {
      method: "POST",
    }),
  updateExternalLink: (id: number, title: string) =>
    fetchJson<ExternalLink>(`${API_BASE}/external-links/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteExternalLink: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/external-links/${id}`, {
      method: "DELETE",
    }),

  // Planning Sessions
  getPlanningSessions: (repoId: string) =>
    fetchJson<PlanningSession[]>(`${API_BASE}/planning-sessions?repoId=${encodeURIComponent(repoId)}`),
  getPlanningSession: (id: string) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions/${id}`),
  createPlanningSession: (repoId: string, baseBranch: string, title?: string, type?: PlanningSessionType, executeBranches?: string[]) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions`, {
      method: "POST",
      body: JSON.stringify({ repoId, baseBranch, title, type, executeBranches }),
    }),
  updatePlanningSession: (id: string, data: {
    title?: string;
    type?: PlanningSessionType;
    baseBranch?: string;
    nodes?: TaskNode[];
    edges?: TaskEdge[];
  }) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  confirmPlanningSession: (id: string) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions/${id}/confirm`, {
      method: "POST",
    }),
  unconfirmPlanningSession: (id: string) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions/${id}/unconfirm`, {
      method: "POST",
    }),
  discardPlanningSession: (id: string) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions/${id}/discard`, {
      method: "POST",
    }),
  deletePlanningSession: (id: string) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/planning-sessions/${id}`, {
      method: "DELETE",
    }),
  updateExecuteBranches: (id: string, executeBranches: string[]) =>
    fetchJson<PlanningSession>(`${API_BASE}/planning-sessions/${id}/execute-branches`, {
      method: "PATCH",
      body: JSON.stringify({ executeBranches }),
    }),
  advanceExecuteTask: (id: string) =>
    fetchJson<PlanningSession & { completed?: boolean; currentBranch?: string }>(
      `${API_BASE}/planning-sessions/${id}/advance-task`,
      {
        method: "POST",
      }
    ),
  generateSessionTitle: (id: string, messageCount: number) =>
    fetchJson<{ title: string; updated: boolean }>(
      `${API_BASE}/planning-sessions/${id}/generate-title`,
      {
        method: "POST",
        body: JSON.stringify({ messageCount }),
      }
    ),
  selectWorktree: (id: string, worktreePath: string | null) =>
    fetchJson<PlanningSession>(
      `${API_BASE}/planning-sessions/${id}/select-worktree`,
      {
        method: "POST",
        body: JSON.stringify({ worktreePath }),
      }
    ),

  // Worktrees API
  getWorktrees: (localPath: string) =>
    fetchJson<WorktreeInfo[]>(`${API_BASE}/worktrees?localPath=${encodeURIComponent(localPath)}`),
  getWorktreesByRepo: (repoId: string) =>
    fetchJson<{ localPath: string; worktrees: WorktreeInfo[] }>(
      `${API_BASE}/worktrees/by-repo?repoId=${encodeURIComponent(repoId)}`
    ),

  // Task Instructions
  getTaskInstruction: (repoId: string, branchName: string) =>
    fetchJson<TaskInstruction>(
      `${API_BASE}/instructions/task?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
    ),
  getTaskInstructions: async (repoId: string, branchNames: string[]) => {
    // Fetch multiple task instructions in parallel
    const results = await Promise.all(
      branchNames.map(async (branchName) => {
        try {
          const instruction = await fetchJson<TaskInstruction>(
            `${API_BASE}/instructions/task?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
          );
          return { branchName, instruction: instruction?.instructionMd || null };
        } catch {
          return { branchName, instruction: null };
        }
      })
    );
    return results;
  },
  updateTaskInstruction: (repoId: string, branchName: string, instructionMd: string) =>
    fetchJson<TaskInstruction>(`${API_BASE}/instructions/task`, {
      method: "PATCH",
      body: JSON.stringify({ repoId, branchName, instructionMd }),
    }),
  confirmTaskInstruction: (repoId: string, branchName: string) =>
    fetchJson<TaskInstruction>(`${API_BASE}/instructions/task/confirm`, {
      method: "POST",
      body: JSON.stringify({ repoId, branchName }),
    }),
  unconfirmTaskInstruction: (repoId: string, branchName: string) =>
    fetchJson<TaskInstruction>(`${API_BASE}/instructions/task/unconfirm`, {
      method: "POST",
      body: JSON.stringify({ repoId, branchName }),
    }),

  // Worktree
  createWorktree: (localPath: string, branchName: string) =>
    fetchJson<{ worktreePath: string; branchName: string }>(
      `${API_BASE}/branch/create-worktree`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName }),
      }
    ),

  // Checkout
  checkout: (localPath: string, branchName: string) =>
    fetchJson<{ success: boolean; branchName: string }>(
      `${API_BASE}/branch/checkout`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName }),
      }
    ),

  // Pull
  pull: (localPath: string, branchName: string, worktreePath?: string) =>
    fetchJson<{ success: boolean; branchName: string; output: string }>(
      `${API_BASE}/branch/pull`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, worktreePath }),
      }
    ),

  // Check if branch can be deleted
  checkBranchDeletable: (localPath: string, branchName: string, parentBranch?: string) =>
    fetchJson<{ deletable: boolean; reason: string | null }>(
      `${API_BASE}/branch/check-deletable`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, parentBranch }),
      }
    ),

  // Delete branch
  deleteBranch: (localPath: string, branchName: string, force?: boolean) =>
    fetchJson<{ success: boolean; branchName: string }>(
      `${API_BASE}/branch/delete`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, force }),
      }
    ),

  // Clean up orphaned branch data
  cleanupOrphanedBranchData: (localPath: string) =>
    fetchJson<{
      success: boolean;
      cleaned: {
        chatSessions: number;
        chatMessages: number;
        taskInstructions: number;
        branchLinks: number;
        instructionsLog: number;
      };
      existingBranches: number;
    }>(`${API_BASE}/branch/cleanup-orphaned`, {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),

  // Delete worktree
  deleteWorktree: (localPath: string, worktreePath: string) =>
    fetchJson<{ success: boolean; worktreePath: string; branchName: string | null }>(
      `${API_BASE}/branch/delete-worktree`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, worktreePath }),
      }
    ),

  // Rebase onto parent
  rebase: (localPath: string, branchName: string, parentBranch: string, worktreePath?: string) =>
    fetchJson<{ success: boolean; branchName: string; parentBranch: string; output: string }>(
      `${API_BASE}/branch/rebase`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, parentBranch, worktreePath }),
      }
    ),

  // Merge parent into current branch
  mergeParent: (localPath: string, branchName: string, parentBranch: string, worktreePath?: string) =>
    fetchJson<{ success: boolean; branchName: string; parentBranch: string; output: string }>(
      `${API_BASE}/branch/merge-parent`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, parentBranch, worktreePath }),
      }
    ),

  // Push branch to remote
  push: (localPath: string, branchName: string, worktreePath?: string, force?: boolean) =>
    fetchJson<{ success: boolean; branchName: string; output: string }>(
      `${API_BASE}/branch/push`,
      {
        method: "POST",
        body: JSON.stringify({ localPath, branchName, worktreePath, force }),
      }
    ),

  // Branch Links
  getBranchLinks: (repoId: string, branchName: string) =>
    fetchJson<BranchLink[]>(
      `${API_BASE}/branch-links?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
    ),
  getBranchLinksBatch: (repoId: string, branches: string[]) =>
    fetchJson<Record<string, BranchLink[]>>(
      `${API_BASE}/branch-links/batch?repoId=${encodeURIComponent(repoId)}&branches=${encodeURIComponent(branches.join(","))}`
    ),
  getRepoLabels: (repoId: string) =>
    fetchJson<Record<string, string>>(
      `${API_BASE}/branch-links/repo-labels?repoId=${encodeURIComponent(repoId)}`
    ),
  createBranchLink: (data: {
    repoId: string;
    branchName: string;
    linkType: BranchLinkType;
    url: string;
    number?: number;
    title?: string;
    status?: string;
  }) =>
    fetchJson<BranchLink>(`${API_BASE}/branch-links`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateBranchLink: (id: number, data: { title?: string; status?: string }) =>
    fetchJson<BranchLink>(`${API_BASE}/branch-links/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteBranchLink: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/branch-links/${id}`, {
      method: "DELETE",
    }),
  refreshBranchLink: (id: number) =>
    fetchJson<BranchLink>(`${API_BASE}/branch-links/${id}/refresh`, {
      method: "POST",
    }),
  detectPr: (repoId: string, branchName: string) =>
    fetchJson<{ found: boolean; link?: BranchLink }>(`${API_BASE}/branch-links/detect`, {
      method: "POST",
      body: JSON.stringify({ repoId, branchName }),
    }),

  // Branch Descriptions
  getBranchDescription: (repoId: string, branchName: string) =>
    fetchJson<BranchDescription | null>(
      `${API_BASE}/branch-descriptions?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
    ),
  getBranchDescriptionsBatch: (repoId: string, branches: string[]) =>
    fetchJson<Record<string, string>>(
      `${API_BASE}/branch-descriptions/batch?repoId=${encodeURIComponent(repoId)}&branches=${encodeURIComponent(branches.join(","))}`
    ),
  updateBranchDescription: (repoId: string, branchName: string, description: string) =>
    fetchJson<BranchDescription>(`${API_BASE}/branch-descriptions`, {
      method: "PUT",
      body: JSON.stringify({ repoId, branchName, description }),
    }),

  // Todos
  getTodos: (repoId: string, branchName: string) =>
    fetchJson<TaskTodo[]>(
      `${API_BASE}/todos?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
    ),
  createTodo: (data: {
    repoId: string;
    branchName: string;
    planningSessionId?: string;
    title: string;
    description?: string;
    status?: TaskTodoStatus;
    orderIndex?: number;
    source?: TaskTodoSource;
  }) =>
    fetchJson<TaskTodo>(`${API_BASE}/todos`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateTodo: (id: number, data: {
    title?: string;
    description?: string;
    status?: TaskTodoStatus;
    orderIndex?: number;
  }) =>
    fetchJson<TaskTodo>(`${API_BASE}/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteTodo: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/todos/${id}`, {
      method: "DELETE",
    }),
  reorderTodos: (repoId: string, branchName: string, todoIds: number[]) =>
    fetchJson<TaskTodo[]>(`${API_BASE}/todos/reorder`, {
      method: "POST",
      body: JSON.stringify({ repoId, branchName, todoIds }),
    }),

  // Questions
  getQuestions: (planningSessionId: string) =>
    fetchJson<PlanningQuestion[]>(
      `${API_BASE}/questions?planningSessionId=${encodeURIComponent(planningSessionId)}`
    ),
  createQuestion: (data: {
    planningSessionId: string;
    branchName?: string;
    question: string;
    assumption?: string;
  }) =>
    fetchJson<PlanningQuestion>(`${API_BASE}/questions`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateQuestion: (id: number, data: {
    question?: string;
    assumption?: string;
    status?: PlanningQuestionStatus;
    answer?: string;
    acknowledged?: boolean;
  }) =>
    fetchJson<PlanningQuestion>(`${API_BASE}/questions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteQuestion: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/questions/${id}`, {
      method: "DELETE",
    }),
  answerQuestion: (id: number, answer: string) =>
    fetchJson<PlanningQuestion>(`${API_BASE}/questions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),

  // Branch Resources - External Links
  getBranchExternalLinks: (repoId: string, branchName: string) =>
    fetchJson<BranchExternalLink[]>(
      `${API_BASE}/branch-resources/links?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
    ),
  getBranchExternalLinksBatch: (repoId: string, branches: string[]) =>
    fetchJson<Record<string, BranchExternalLink[]>>(
      `${API_BASE}/branch-resources/links/batch?repoId=${encodeURIComponent(repoId)}&branches=${encodeURIComponent(branches.join(","))}`
    ),
  createBranchExternalLink: (data: {
    repoId: string;
    branchName: string;
    url: string;
    title?: string;
    description?: string;
  }) =>
    fetchJson<BranchExternalLink>(`${API_BASE}/branch-resources/links`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateBranchExternalLink: (id: number, data: { title?: string; description?: string }) =>
    fetchJson<BranchExternalLink>(`${API_BASE}/branch-resources/links/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteBranchExternalLink: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/branch-resources/links/${id}`, {
      method: "DELETE",
    }),

  // Branch Resources - Files
  getBranchFiles: (repoId: string, branchName: string) =>
    fetchJson<BranchFile[]>(
      `${API_BASE}/branch-resources/files?repoId=${encodeURIComponent(repoId)}&branchName=${encodeURIComponent(branchName)}`
    ),
  getBranchFilesBatch: (repoId: string, branches: string[]) =>
    fetchJson<Record<string, BranchFile[]>>(
      `${API_BASE}/branch-resources/files/batch?repoId=${encodeURIComponent(repoId)}&branches=${encodeURIComponent(branches.join(","))}`
    ),
  uploadBranchFile: async (data: {
    repoId: string;
    branchName: string;
    file: File;
    description?: string;
    sourceType?: string;
    sourceUrl?: string;
  }) => {
    const formData = new FormData();
    formData.append("file", data.file);
    formData.append("repoId", data.repoId);
    formData.append("branchName", data.branchName);
    if (data.description) formData.append("description", data.description);
    if (data.sourceType) formData.append("sourceType", data.sourceType);
    if (data.sourceUrl) formData.append("sourceUrl", data.sourceUrl);

    const res = await fetch(`${API_BASE}/branch-resources/files`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || `HTTP error: ${res.status}`);
    }
    return res.json() as Promise<BranchFile>;
  },
  updateBranchFile: (id: number, data: { description?: string }) =>
    fetchJson<BranchFile>(`${API_BASE}/branch-resources/files/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteBranchFile: (id: number) =>
    fetchJson<{ success: boolean }>(`${API_BASE}/branch-resources/files/${id}`, {
      method: "DELETE",
    }),
  getBranchFileUrl: (id: number) => `${API_BASE}/branch-resources/files/${id}/download`,
};
