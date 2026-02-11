import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type TaskTodo, type PlanningQuestion, type BranchLink, type TaskInstruction, type GitHubLabel, type GitHubCheck } from "../lib/api";
import { wsClient } from "../lib/ws";
import ExecuteBranchTree from "./ExecuteBranchTree";
import ExecuteTodoList from "./ExecuteTodoList";
import PlanningQuestionsPanel from "./PlanningQuestionsPanel";
import "./ExecuteSidebar.css";

interface ExecuteSidebarProps {
  repoId: string;
  executeBranches: string[];
  currentExecuteIndex: number;
  planningSessionId?: string;
  onManualBranchSwitch?: (branchIndex: number) => void;
  onBranchCompleted?: (branchName: string) => void;
  workingBranch?: string | null;
}

export function ExecuteSidebar({
  repoId,
  executeBranches,
  currentExecuteIndex,
  planningSessionId,
  onManualBranchSwitch,
  onBranchCompleted,
  workingBranch,
}: ExecuteSidebarProps) {
  // Preview branch (clicked but not switched to)
  const [previewBranch, setPreviewBranch] = useState<string | null>(null);

  // Active tab: "info", "instruction", "todo", or "questions"
  const [activeTab, setActiveTab] = useState<"info" | "instruction" | "todo" | "questions">("info");

  // All todos for all branches (for completion tracking)
  const [allTodos, setAllTodos] = useState<Map<string, TaskTodo[]>>(new Map());

  // All questions for all branches (for badge counts)
  const [allQuestions, setAllQuestions] = useState<PlanningQuestion[]>([]);

  // All branch links for all branches (for PR status in tree)
  const [allBranchLinks, setAllBranchLinks] = useState<Map<string, BranchLink[]>>(new Map());

  // Branch links and instruction for display branch
  const [branchLinks, setBranchLinks] = useState<BranchLink[]>([]);
  const [instruction, setInstruction] = useState<TaskInstruction | null>(null);
  const [instructionLoading, setInstructionLoading] = useState(false);

  // Current branch (actual execution target)
  const currentBranch = executeBranches[currentExecuteIndex] || null;

  // Display branch (preview if set, otherwise current)
  const displayBranch = previewBranch || currentBranch;

  // Reset preview when current branch changes
  useEffect(() => {
    setPreviewBranch(null);
  }, [currentExecuteIndex]);

  // Load branch links and instruction for display branch
  useEffect(() => {
    if (!repoId || !displayBranch) {
      setBranchLinks([]);
      setInstruction(null);
      return;
    }
    setInstructionLoading(true);
    Promise.all([
      api.getBranchLinks(repoId, displayBranch).catch(() => []),
      api.getTaskInstruction(repoId, displayBranch).catch(() => null),
    ])
      .then(async ([links, inst]) => {
        // If no PR link found, try to detect one
        if (!links.some((l) => l.linkType === "pr")) {
          try {
            const result = await api.detectPr(repoId, displayBranch);
            if (result.found && result.link) {
              links = [result.link, ...links];
            }
          } catch {
            // Ignore detection errors
          }
        }
        setBranchLinks(links);
        setInstruction(inst);
      })
      .finally(() => setInstructionLoading(false));
  }, [repoId, displayBranch]);

  // Load all todos for all branches
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const loadAllTodos = async () => {
      const todosMap = new Map<string, TaskTodo[]>();
      await Promise.all(
        executeBranches.map(async (branch) => {
          try {
            const todos = await api.getTodos(repoId, branch);
            todosMap.set(branch, todos);
          } catch {
            todosMap.set(branch, []);
          }
        })
      );
      setAllTodos(todosMap);
    };

    loadAllTodos();
  }, [repoId, executeBranches]);

  // Load all branch links for all branches (with PR auto-detection)
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const loadAllBranchLinks = async () => {
      try {
        // Use batch API for single request
        const batchResult = await api.getBranchLinksBatch(repoId, executeBranches);
        const linksMap = new Map<string, BranchLink[]>();

        // Find branches without PR links - detect in parallel
        const branchesNeedingDetection: string[] = [];
        for (const branch of executeBranches) {
          const links = batchResult[branch] || [];
          linksMap.set(branch, links);
          if (!links.some((l) => l.linkType === "pr")) {
            branchesNeedingDetection.push(branch);
          }
        }

        // Detect PRs in parallel for branches that need it
        if (branchesNeedingDetection.length > 0) {
          const detectionResults = await Promise.allSettled(
            branchesNeedingDetection.map((branch) => api.detectPr(repoId, branch))
          );

          detectionResults.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value.found && result.value.link) {
              const branch = branchesNeedingDetection[index];
              const currentLinks = linksMap.get(branch) || [];
              linksMap.set(branch, [result.value.link, ...currentLinks]);
            }
          });
        }

        setAllBranchLinks(linksMap);
      } catch {
        // Fallback: set empty map
        const linksMap = new Map<string, BranchLink[]>();
        executeBranches.forEach((branch) => linksMap.set(branch, []));
        setAllBranchLinks(linksMap);
      }
    };

    loadAllBranchLinks();
  }, [repoId, executeBranches]);

  // WebSocket updates for branch links
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const unsubCreated = wsClient.on("branchLink.created", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && executeBranches.includes(data.branchName)) {
        setAllBranchLinks((prev) => {
          const newMap = new Map(prev);
          const current = newMap.get(data.branchName) || [];
          if (!current.some((l) => l.id === data.id)) {
            newMap.set(data.branchName, [data, ...current]);
          }
          return newMap;
        });
      }
    });

    const unsubUpdated = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && executeBranches.includes(data.branchName)) {
        setAllBranchLinks((prev) => {
          const newMap = new Map(prev);
          const current = newMap.get(data.branchName) || [];
          newMap.set(data.branchName, current.map((l) => (l.id === data.id ? data : l)));
          return newMap;
        });
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
    };
  }, [repoId, executeBranches]);

  // WebSocket updates for todos
  useEffect(() => {
    const updateTodosForBranch = (branchName: string, updater: (todos: TaskTodo[]) => TaskTodo[]) => {
      setAllTodos((prev) => {
        const newMap = new Map(prev);
        const current = newMap.get(branchName) || [];
        newMap.set(branchName, updater(current));
        return newMap;
      });
    };

    const unsubCreated = wsClient.on("todo.created", (msg) => {
      const todo = msg.data as TaskTodo;
      if (executeBranches.includes(todo.branchName)) {
        updateTodosForBranch(todo.branchName, (todos) =>
          [...todos, todo].sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubUpdated = wsClient.on("todo.updated", (msg) => {
      const todo = msg.data as TaskTodo;
      if (executeBranches.includes(todo.branchName)) {
        updateTodosForBranch(todo.branchName, (todos) =>
          todos.map((t) => (t.id === todo.id ? todo : t)).sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubDeleted = wsClient.on("todo.deleted", (msg) => {
      const data = msg.data as { id: number; branchName: string };
      if (executeBranches.includes(data.branchName)) {
        updateTodosForBranch(data.branchName, (todos) =>
          todos.filter((t) => t.id !== data.id)
        );
      }
    });

    const unsubReordered = wsClient.on("todo.reordered", (msg) => {
      const data = msg.data as { branchName: string; todos: TaskTodo[] };
      if (executeBranches.includes(data.branchName)) {
        setAllTodos((prev) => {
          const newMap = new Map(prev);
          newMap.set(data.branchName, data.todos);
          return newMap;
        });
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
      unsubReordered();
    };
  }, [executeBranches]);

  // Load questions
  useEffect(() => {
    if (!planningSessionId) return;
    api.getQuestions(planningSessionId)
      .then(setAllQuestions)
      .catch(console.error);
  }, [planningSessionId]);

  // WebSocket updates for questions
  useEffect(() => {
    if (!planningSessionId) return;

    const unsubQCreated = wsClient.on("question.created", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => [...prev, q].sort((a, b) => a.orderIndex - b.orderIndex));
      }
    });

    const unsubQUpdated = wsClient.on("question.updated", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => prev.map((item) => (item.id === q.id ? q : item)));
      }
    });

    const unsubQAnswered = wsClient.on("question.answered", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => prev.map((item) => (item.id === q.id ? q : item)));
      }
    });

    const unsubQDeleted = wsClient.on("question.deleted", (msg) => {
      const data = msg.data as { id: number; planningSessionId: string };
      if (data.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => prev.filter((q) => q.id !== data.id));
      }
    });

    return () => {
      unsubQCreated();
      unsubQUpdated();
      unsubQAnswered();
      unsubQDeleted();
    };
  }, [planningSessionId]);

  // Compute completed branches (all todos completed)
  const completedBranches = useMemo(() => {
    const completed = new Set<string>();
    allTodos.forEach((todos, branchName) => {
      if (todos.length > 0 && todos.every((t) => t.status === "completed")) {
        completed.add(branchName);
      }
    });
    return completed;
  }, [allTodos]);

  // Track previously completed branches to avoid duplicate callbacks
  const prevCompletedRef = useRef<Set<string>>(new Set());

  // Notify when current branch is completed
  useEffect(() => {
    if (!currentBranch || !onBranchCompleted) return;

    // Check if current branch just became completed
    const isNowCompleted = completedBranches.has(currentBranch);
    const wasCompleted = prevCompletedRef.current.has(currentBranch);

    if (isNowCompleted && !wasCompleted) {
      // Branch just completed - notify parent
      onBranchCompleted(currentBranch);
    }

    // Update prev ref
    prevCompletedRef.current = new Set(completedBranches);
  }, [completedBranches, currentBranch, onBranchCompleted]);

  // Compute todo counts per branch
  const branchTodoCounts = useMemo(() => {
    const counts = new Map<string, { total: number; completed: number }>();
    allTodos.forEach((todos, branchName) => {
      counts.set(branchName, {
        total: todos.length,
        completed: todos.filter((t) => t.status === "completed").length,
      });
    });
    return counts;
  }, [allTodos]);

  // Compute question counts per branch
  const branchQuestionCounts = useMemo(() => {
    const counts = new Map<string, { total: number; pending: number; answered: number; acknowledged: number }>();
    executeBranches.forEach((branch) => {
      const branchQuestions = allQuestions.filter((q) => q.branchName === branch);
      counts.set(branch, {
        total: branchQuestions.length,
        pending: branchQuestions.filter((q) => q.status === "pending").length,
        answered: branchQuestions.filter((q) => q.status === "answered" && !q.acknowledged).length,
        acknowledged: branchQuestions.filter((q) => q.status === "answered" && q.acknowledged).length,
      });
    });
    return counts;
  }, [allQuestions, executeBranches]);

  // Count pending questions for display branch
  const displayBranchQuestionCount = useMemo(() => {
    if (!displayBranch) return { total: 0, pending: 0, answered: 0 };
    const branchQuestions = allQuestions.filter((q) => q.branchName === displayBranch);
    return {
      total: branchQuestions.length,
      pending: branchQuestions.filter((q) => q.status === "pending").length,
      answered: branchQuestions.filter((q) => q.status === "answered" && !q.acknowledged).length,
    };
  }, [allQuestions, displayBranch]);

  // Handle preview branch selection
  const handlePreviewBranch = useCallback((branch: string) => {
    setPreviewBranch(branch === previewBranch ? null : branch);
  }, [previewBranch]);

  // Handle switch to branch
  const handleSwitchToBranch = useCallback(() => {
    if (!previewBranch || !onManualBranchSwitch) return;
    const index = executeBranches.indexOf(previewBranch);
    if (index !== -1) {
      onManualBranchSwitch(index);
      setPreviewBranch(null);
    }
  }, [previewBranch, executeBranches, onManualBranchSwitch]);

  if (!displayBranch) {
    return (
      <div className="execute-sidebar execute-sidebar--empty">
        <p>No branches selected</p>
      </div>
    );
  }

  const isCurrent = displayBranch === currentBranch;
  const prLink = branchLinks.find((l) => l.linkType === "pr");
  const issueLink = branchLinks.find((l) => l.linkType === "issue");

  return (
    <div className="execute-sidebar">
      {/* Branch Tree (compact) */}
      <div className="execute-sidebar__branches">
        <ExecuteBranchTree
          branches={executeBranches}
          selectedBranchIndex={previewBranch ? executeBranches.indexOf(previewBranch) : currentExecuteIndex}
          aiBranchIndex={workingBranch ? executeBranches.indexOf(workingBranch) : null}
          onBranchSelect={(_branch, index) => handlePreviewBranch(executeBranches[index])}
          completedBranches={completedBranches}
          branchTodoCounts={branchTodoCounts}
          branchQuestionCounts={branchQuestionCounts}
          branchLinks={allBranchLinks}
        />
      </div>

      {/* Branch Header - simplified, details in Info tab */}
      <div className="execute-sidebar__branch-header">
        <div className="execute-sidebar__branch-name">
          {displayBranch}
          {isCurrent ? (
            <span className="execute-sidebar__current-badge">Current</span>
          ) : (
            onManualBranchSwitch && (
              <button
                className="execute-sidebar__switch-btn"
                onClick={handleSwitchToBranch}
              >
                Switch
              </button>
            )
          )}
        </div>
      </div>

      {/* Tabs - using planning-panel classes for consistent styling */}
      <div className="planning-panel__sidebar-tabs">
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "info" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("info")}
        >
          Info
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "instruction" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("instruction")}
        >
          Instruction
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "todo" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("todo")}
        >
          ToDo
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "questions" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("questions")}
        >
          Questions
          {(displayBranchQuestionCount.pending > 0 || displayBranchQuestionCount.answered > 0) && (
            <span className="execute-sidebar__tab-badge">
              {displayBranchQuestionCount.pending + displayBranchQuestionCount.answered}
            </span>
          )}
        </button>
      </div>

      {/* Tab Content - using planning-panel classes for consistent styling */}
      <div className="planning-panel__sidebar-content">
        {activeTab === "info" && (
          <div className="execute-sidebar__info-tab">
            {/* Issue Section */}
            <div className="execute-sidebar__links-section">
              <div className="execute-sidebar__links-header">
                <h4>Issue</h4>
              </div>
              {issueLink ? (() => {
                const rawLabels = issueLink.labels ? JSON.parse(issueLink.labels) : [];
                const labels: GitHubLabel[] = rawLabels.map((l: string | GitHubLabel) =>
                  typeof l === "string" ? { name: l, color: "6b7280" } : l
                );
                const getTextColor = (bgColor: string) => {
                  const r = parseInt(bgColor.slice(0, 2), 16);
                  const g = parseInt(bgColor.slice(2, 4), 16);
                  const b = parseInt(bgColor.slice(4, 6), 16);
                  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                  return luminance > 0.5 ? "#000" : "#fff";
                };
                return (
                  <div className="execute-sidebar__link-item">
                    <a
                      href={issueLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="execute-sidebar__link-url"
                    >
                      <span className="execute-sidebar__link-number">#{issueLink.number}</span>
                      {issueLink.title}
                    </a>
                    {issueLink.projectStatus && (
                      <span className="execute-sidebar__link-project">{issueLink.projectStatus}</span>
                    )}
                    {labels.length > 0 && (
                      <div className="execute-sidebar__link-labels">
                        {labels.map((l, i) => (
                          <span
                            key={i}
                            className="execute-sidebar__link-label"
                            style={{ backgroundColor: `#${l.color}`, color: getTextColor(l.color) }}
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })() : (
                <div className="execute-sidebar__no-links">No issue linked</div>
              )}
            </div>

            {/* PR Section */}
            <div className="execute-sidebar__links-section">
              <div className="execute-sidebar__links-header">
                <h4>PR</h4>
              </div>
              {prLink ? (() => {
                const rawLabels = prLink.labels ? JSON.parse(prLink.labels) : [];
                const labels: GitHubLabel[] = rawLabels.map((l: string | GitHubLabel) =>
                  typeof l === "string" ? { name: l, color: "6b7280" } : l
                );
                const reviewers = prLink.reviewers ? JSON.parse(prLink.reviewers) as string[] : [];
                const checks: GitHubCheck[] = prLink.checks ? JSON.parse(prLink.checks) : [];
                const passedChecks = checks.filter((c) => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED").length;
                const totalChecks = checks.length;
                const getTextColor = (bgColor: string) => {
                  const r = parseInt(bgColor.slice(0, 2), 16);
                  const g = parseInt(bgColor.slice(2, 4), 16);
                  const b = parseInt(bgColor.slice(4, 6), 16);
                  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                  return luminance > 0.5 ? "#000" : "#fff";
                };
                return (
                  <div className="execute-sidebar__link-item execute-sidebar__link-item--detailed">
                    <div className="execute-sidebar__link-main">
                      <a
                        href={prLink.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="execute-sidebar__link-url"
                      >
                        <span className="execute-sidebar__link-number">#{prLink.number}</span>
                        {prLink.title}
                      </a>
                    </div>
                    <div className="execute-sidebar__link-meta">
                      {totalChecks > 0 && (
                        <span className={`execute-sidebar__ci-badge execute-sidebar__ci-badge--${prLink.checksStatus}`}>
                          <span className="execute-sidebar__ci-badge-icon">
                            {prLink.checksStatus === "success" ? "✓" : prLink.checksStatus === "failure" ? "✗" : "●"}
                          </span>
                          <span className="execute-sidebar__ci-badge-count">{passedChecks}/{totalChecks}</span>
                        </span>
                      )}
                      {prLink.reviewDecision && (
                        <span className={`execute-sidebar__review-badge execute-sidebar__review-badge--${prLink.reviewDecision.toLowerCase().replace("_", "-")}`}>
                          {prLink.reviewDecision === "APPROVED" ? "Approved" :
                           prLink.reviewDecision === "CHANGES_REQUESTED" ? "Changes" :
                           prLink.reviewDecision === "REVIEW_REQUIRED" ? "Review Required" : prLink.reviewDecision}
                        </span>
                      )}
                      {prLink.projectStatus && (
                        <span className="execute-sidebar__link-project">{prLink.projectStatus}</span>
                      )}
                      <span className="execute-sidebar__link-reviewers">
                        {reviewers.length > 0 ? (
                          reviewers.map((r, i) => (
                            <span key={i} className="execute-sidebar__link-reviewer">{r}</span>
                          ))
                        ) : (
                          <span className="execute-sidebar__link-reviewer execute-sidebar__link-reviewer--none">No Reviewers</span>
                        )}
                      </span>
                    </div>
                    {labels.length > 0 && (
                      <div className="execute-sidebar__pr-labels">
                        {labels.map((l, i) => (
                          <span
                            key={i}
                            className="execute-sidebar__pr-label"
                            style={{ backgroundColor: `#${l.color}`, color: getTextColor(l.color) }}
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })() : (
                <div className="execute-sidebar__no-links">No PR linked</div>
              )}
            </div>
          </div>
        )}

        {activeTab === "instruction" && (
          <div className="planning-panel__instruction">
            {instructionLoading ? (
              <div className="planning-panel__instruction-loading">Loading...</div>
            ) : instruction?.instructionMd ? (
              <div className="planning-panel__instruction-view">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {instruction.instructionMd}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="planning-panel__instruction-empty">
                No instruction set for this branch
              </span>
            )}
          </div>
        )}

        {activeTab === "todo" && (
          <div className="planning-panel__todo-section">
            <ExecuteTodoList
              repoId={repoId}
              branchName={displayBranch}
              planningSessionId={planningSessionId}
              disabled={!isCurrent}
            />
          </div>
        )}

        {activeTab === "questions" && planningSessionId && (
          <div className="planning-panel__questions-section">
            <PlanningQuestionsPanel
              planningSessionId={planningSessionId}
              branchName={displayBranch}
              disabled={!isCurrent}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default ExecuteSidebar;
