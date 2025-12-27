const API_BASE = "/api";

export interface Repo {
  id: number;
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BranchNamingRule {
  id: number;
  repoId: number;
  pattern: string;
  description: string;
  examples: string[];
}

export interface Plan {
  id: number;
  repoId: number;
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

export interface TreeNode {
  branchName: string;
  badges: string[];
  pr?: {
    number: number;
    title: string;
    state: string;
    url: string;
    branch: string;
    checks?: string;
  };
  worktree?: {
    path: string;
    branch: string;
    commit: string;
    dirty: boolean;
  };
  lastCommitAt: string;
  aheadBehind?: { ahead: number; behind: number };
}

export interface TreeEdge {
  parent: string;
  child: string;
  confidence: "high" | "medium" | "low";
}

export interface ScanSnapshot {
  nodes: TreeNode[];
  edges: TreeEdge[];
  warnings: Warning[];
  worktrees: Array<{
    path: string;
    branch: string;
    commit: string;
    dirty: boolean;
  }>;
  rules: { branchNaming: BranchNamingRule | null };
  restart: {
    worktreePath: string;
    cdCommand: string;
    restartPromptMd: string;
  } | null;
}

export interface InstructionLog {
  id: number;
  repoId: number;
  planId: number | null;
  worktreePath: string | null;
  branchName: string | null;
  kind: "director_suggestion" | "user_instruction" | "system_note";
  contentMd: string;
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

  // Repos
  getRepos: () => fetchJson<Repo[]>(`${API_BASE}/repos`),
  createRepo: (path: string, name?: string) =>
    fetchJson<Repo>(`${API_BASE}/repos`, {
      method: "POST",
      body: JSON.stringify({ path, name }),
    }),
  getRepo: (id: number) => fetchJson<Repo>(`${API_BASE}/repos/${id}`),

  // Branch Naming
  getBranchNaming: (repoId: number) =>
    fetchJson<BranchNamingRule>(
      `${API_BASE}/project-rules/branch-naming?repoId=${repoId}`
    ),
  updateBranchNaming: (data: {
    repoId: number;
    pattern: string;
    description: string;
    examples: string[];
  }) =>
    fetchJson<BranchNamingRule>(`${API_BASE}/project-rules/branch-naming`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Plan
  getCurrentPlan: (repoId: number) =>
    fetchJson<Plan | null>(`${API_BASE}/plan/current?repoId=${repoId}`),
  startPlan: (repoId: number, title: string) =>
    fetchJson<Plan>(`${API_BASE}/plan/start`, {
      method: "POST",
      body: JSON.stringify({ repoId, title }),
    }),
  updatePlan: (planId: number, contentMd: string) =>
    fetchJson<Plan>(`${API_BASE}/plan/update`, {
      method: "POST",
      body: JSON.stringify({ planId, contentMd }),
    }),
  commitPlan: (planId: number) =>
    fetchJson<Plan>(`${API_BASE}/plan/commit`, {
      method: "POST",
      body: JSON.stringify({ planId }),
    }),

  // Scan
  scan: (repoId: number) =>
    fetchJson<ScanSnapshot>(`${API_BASE}/scan`, {
      method: "POST",
      body: JSON.stringify({ repoId }),
    }),
  getRestartPrompt: (repoId: number, planId?: number, worktreePath?: string) => {
    const params = new URLSearchParams({ repoId: String(repoId) });
    if (planId) params.set("planId", String(planId));
    if (worktreePath) params.set("worktreePath", worktreePath);
    return fetchJson<{ cdCommand: string; restartPromptMd: string }>(
      `${API_BASE}/scan/restart-prompt?${params}`
    );
  },

  // Instructions
  logInstruction: (data: {
    repoId: number;
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
  getInstructionLogs: (repoId: number) =>
    fetchJson<InstructionLog[]>(`${API_BASE}/instructions/logs?repoId=${repoId}`),
};
