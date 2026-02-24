import { useMemo, useState, useCallback } from "react";
import { api, type BranchLink, type TreeEdge, type RepoLabel, type RepoCollaborator, type TreeNode } from "../lib/api";
import { Dropdown } from "./atoms/Dropdown";
import { LabelChip, UserChip, TeamChip } from "./atoms/Chips";
import { WorktreeSelector } from "./atoms/WorktreeSelector";
import "./TaskDetailPanel.css";

interface BulkOperationProgress {
  total: number;
  completed: number;
  current: string | null;
  results: { branch: string; success: boolean; message?: string }[];
  status: "idle" | "running" | "done" | "error";
}

interface MultiSelectPanelProps {
  selectedBranches: Set<string>;
  checkedBranches: Set<string>;
  onCheckAll: () => void;
  onUncheckAll: () => void;
  onClearSelection: () => void;
  // For bulk operations
  localPath: string;
  branchLinks: Map<string, BranchLink[]>;
  edges: TreeEdge[];
  nodes: TreeNode[];
  defaultBranch: string;
  // Quick labels/reviewers (pre-selected in settings)
  quickLabels: string[];
  quickReviewers: string[];
  // For resolving label colors
  repoLabels: RepoLabel[];
  repoCollaborators: RepoCollaborator[];
  onRefreshBranches?: () => void;
  onBranchesDeleted?: (deletedBranches: string[]) => void;
}

export default function MultiSelectPanel({
  selectedBranches,
  checkedBranches,
  onCheckAll,
  onUncheckAll,
  onClearSelection,
  localPath,
  branchLinks,
  edges,
  nodes,
  defaultBranch,
  quickLabels,
  quickReviewers,
  repoLabels,
  repoCollaborators,
  onRefreshBranches,
  onBranchesDeleted,
}: MultiSelectPanelProps) {
  const selectedList = useMemo(() => [...selectedBranches], [selectedBranches]);
  const displayLimit = 10;
  const displayedBranches = selectedList.slice(0, displayLimit);
  const remainingCount = selectedList.length - displayLimit;

  // Bulk operation state
  const [progress, setProgress] = useState<BulkOperationProgress>({
    total: 0,
    completed: 0,
    current: null,
    results: [],
    status: "idle",
  });

  // Dropdown states
  const [showLabelDropdown, setShowLabelDropdown] = useState(false);
  const [showReviewerDropdown, setShowReviewerDropdown] = useState(false);

  // Selected items in dropdowns (before applying)
  const [pendingLabels, setPendingLabels] = useState<Set<string>>(new Set());
  const [pendingReviewers, setPendingReviewers] = useState<Set<string>>(new Set());

  // Get branches with PRs
  const branchesWithPRs = useMemo(() => {
    return selectedList.filter((branch) => {
      const links = branchLinks.get(branch);
      return links?.some((l) => l.linkType === "pr" && l.status === "open");
    });
  }, [selectedList, branchLinks]);

  // Get PR URLs for selected branches (sorted)
  const prUrls = useMemo(() => {
    return selectedList
      .map((branch) => {
        const links = branchLinks.get(branch);
        const prLink = links?.find((l) => l.linkType === "pr" && l.status === "open");
        return prLink?.url ?? null;
      })
      .filter((url): url is string => url !== null)
      .sort();
  }, [selectedList, branchLinks]);

  // Node map for quick lookup
  const nodeMap = useMemo(() => {
    const map = new Map<string, TreeNode>();
    nodes.forEach((n) => map.set(n.branchName, n));
    return map;
  }, [nodes]);

  // Check if a branch is deletable:
  // - Not the default branch
  // - PR is merged OR no commits (ahead=0) OR no PR attached
  const isDeletable = useCallback(
    (branch: string): { deletable: boolean; reason?: string } => {
      if (branch === defaultBranch) {
        return { deletable: false, reason: "default branch" };
      }

      const node = nodeMap.get(branch);
      if (!node) {
        return { deletable: false, reason: "not found" };
      }

      // Check if has worktree
      if (node.worktree) {
        return { deletable: false, reason: "has worktree" };
      }

      const links = branchLinks.get(branch);
      const prLink = links?.find((l) => l.linkType === "pr");

      // If PR exists and is open, not deletable (unless merged)
      if (prLink) {
        if (prLink.status === "merged") {
          return { deletable: true };
        }
        if (prLink.status === "open") {
          return { deletable: false, reason: "PR is open" };
        }
      }

      // No PR or PR is closed - check if has commits
      if (node.aheadBehind && node.aheadBehind.ahead > 0) {
        return { deletable: false, reason: "has commits" };
      }

      return { deletable: true };
    },
    [defaultBranch, nodeMap, branchLinks]
  );

  // Get deletable branches and reasons
  const deletableInfo = useMemo(() => {
    const deletable: string[] = [];
    const notDeletable: { branch: string; reason: string }[] = [];

    selectedList.forEach((branch) => {
      const result = isDeletable(branch);
      if (result.deletable) {
        deletable.push(branch);
      } else {
        notDeletable.push({ branch, reason: result.reason || "unknown" });
      }
    });

    return { deletable, notDeletable, allDeletable: notDeletable.length === 0 };
  }, [selectedList, isDeletable]);

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Worktree selection state for serial rebase
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null);
  const [showWorktreeSelector, setShowWorktreeSelector] = useState(false);

  // Get PR link ID for a branch
  const getPRLinkId = useCallback(
    (branch: string): number | null => {
      const links = branchLinks.get(branch);
      const prLink = links?.find((l) => l.linkType === "pr" && l.status === "open");
      return prLink?.id ?? null;
    },
    [branchLinks]
  );

  // Check if all selected branches are checked/unchecked
  const allChecked = useMemo(() => {
    return selectedList.every((b) => checkedBranches.has(b));
  }, [selectedList, checkedBranches]);

  const noneChecked = useMemo(() => {
    return selectedList.every((b) => !checkedBranches.has(b));
  }, [selectedList, checkedBranches]);

  // Parent map for rebase (shared between sort and rebase handler)
  const parentMap = useMemo(() => {
    const map = new Map<string, string>();
    edges.forEach((e) => map.set(e.child, e.parent));
    return map;
  }, [edges]);

  // Sort branches by dependency order for serial rebase
  const sortedBranchesForRebase = useMemo(() => {
    const getDepth = (branch: string): number => {
      let depth = 0;
      let current = branch;
      while (parentMap.has(current)) {
        current = parentMap.get(current)!;
        depth++;
      }
      return depth;
    };
    return [...selectedList].sort((a, b) => getDepth(a) - getDepth(b));
  }, [selectedList, parentMap]);

  // Resolve label info from name
  const getLabelInfo = useCallback(
    (name: string) => repoLabels.find((l) => l.name === name),
    [repoLabels]
  );

  // Resolve reviewer info from login
  const getReviewerInfo = useCallback(
    (login: string) => {
      if (login.startsWith("team/")) {
        return { login, isTeam: true };
      }
      const collab = repoCollaborators.find((c) => c.login === login);
      return collab ? { ...collab, isTeam: false } : { login, isTeam: false };
    },
    [repoCollaborators]
  );

  // Toggle label selection
  const togglePendingLabel = (labelName: string) => {
    setPendingLabels((prev) => {
      const next = new Set(prev);
      if (next.has(labelName)) {
        next.delete(labelName);
      } else {
        next.add(labelName);
      }
      return next;
    });
  };

  // Toggle reviewer selection
  const togglePendingReviewer = (reviewer: string) => {
    setPendingReviewers((prev) => {
      const next = new Set(prev);
      if (next.has(reviewer)) {
        next.delete(reviewer);
      } else {
        next.add(reviewer);
      }
      return next;
    });
  };

  // Apply labels
  const handleApplyLabels = async () => {
    if (pendingLabels.size === 0) return;
    setShowLabelDropdown(false);

    const targetBranches = branchesWithPRs;
    const labelsToAdd = [...pendingLabels];
    const totalOps = targetBranches.length * labelsToAdd.length;

    setProgress({
      total: totalOps,
      completed: 0,
      current: null,
      results: [],
      status: "running",
    });

    const results: BulkOperationProgress["results"] = [];
    let completed = 0;

    for (const branch of targetBranches) {
      const linkId = getPRLinkId(branch);
      if (!linkId) {
        for (const label of labelsToAdd) {
          results.push({ branch: `${branch} (${label})`, success: false, message: "No PR found" });
          completed++;
        }
        setProgress((p) => ({ ...p, completed, results: [...results] }));
        continue;
      }

      for (const label of labelsToAdd) {
        setProgress((p) => ({ ...p, current: `${branch}: ${label}` }));
        try {
          await api.addPrLabel(linkId, label);
          results.push({ branch: `${branch} (${label})`, success: true });
        } catch (e) {
          results.push({ branch: `${branch} (${label})`, success: false, message: String(e) });
        }
        completed++;
        setProgress((p) => ({ ...p, completed, results: [...results] }));
      }
    }

    setProgress((p) => ({ ...p, current: null, status: "done" }));
    setPendingLabels(new Set());
    onRefreshBranches?.();
  };

  // Apply reviewers
  const handleApplyReviewers = async () => {
    if (pendingReviewers.size === 0) return;
    setShowReviewerDropdown(false);

    const targetBranches = branchesWithPRs;
    const reviewersToAdd = [...pendingReviewers];
    const totalOps = targetBranches.length * reviewersToAdd.length;

    setProgress({
      total: totalOps,
      completed: 0,
      current: null,
      results: [],
      status: "running",
    });

    const results: BulkOperationProgress["results"] = [];
    let completed = 0;

    for (const branch of targetBranches) {
      const linkId = getPRLinkId(branch);
      if (!linkId) {
        for (const reviewer of reviewersToAdd) {
          results.push({ branch: `${branch} (${reviewer})`, success: false, message: "No PR found" });
          completed++;
        }
        setProgress((p) => ({ ...p, completed, results: [...results] }));
        continue;
      }

      for (const reviewer of reviewersToAdd) {
        setProgress((p) => ({ ...p, current: `${branch}: ${reviewer}` }));
        try {
          await api.addPrReviewer(linkId, reviewer);
          results.push({ branch: `${branch} (${reviewer})`, success: true });
        } catch (e) {
          results.push({ branch: `${branch} (${reviewer})`, success: false, message: String(e) });
        }
        completed++;
        setProgress((p) => ({ ...p, completed, results: [...results] }));
      }
    }

    setProgress((p) => ({ ...p, current: null, status: "done" }));
    setPendingReviewers(new Set());
    onRefreshBranches?.();
  };

  // Refresh all PRs
  const handleRefreshPRs = async () => {
    const targetBranches = branchesWithPRs;
    if (targetBranches.length === 0) return;

    setProgress({
      total: targetBranches.length,
      completed: 0,
      current: null,
      results: [],
      status: "running",
    });

    const results: BulkOperationProgress["results"] = [];

    for (const branch of targetBranches) {
      setProgress((p) => ({ ...p, current: branch }));

      const linkId = getPRLinkId(branch);
      if (!linkId) {
        results.push({ branch, success: false, message: "No PR found" });
        setProgress((p) => ({ ...p, completed: p.completed + 1, results: [...results] }));
        continue;
      }

      try {
        await api.refreshBranchLink(linkId);
        results.push({ branch, success: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ branch, success: false, message });
      }
      setProgress((p) => ({ ...p, completed: p.completed + 1, results: [...results] }));
    }

    setProgress((p) => ({ ...p, current: null, status: "done" }));
    onRefreshBranches?.();
  };

  // Serial rebase
  const handleSerialRebase = async () => {
    const targetBranches = sortedBranchesForRebase;
    if (targetBranches.length === 0) return;

    setProgress({
      total: targetBranches.length,
      completed: 0,
      current: null,
      results: [],
      status: "running",
    });

    const results: BulkOperationProgress["results"] = [];

    for (const branch of targetBranches) {
      setProgress((p) => ({ ...p, current: branch }));

      const parentBranch = parentMap.get(branch);
      if (!parentBranch) {
        results.push({ branch, success: false, message: "No parent branch found" });
        setProgress((p) => ({ ...p, completed: p.completed + 1, results: [...results] }));
        continue;
      }

      try {
        // Use selected worktree if available, otherwise use main repo (temporary checkout)
        await api.rebase(localPath, branch, parentBranch, selectedWorktree ?? undefined);
        results.push({ branch, success: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ branch, success: false, message });
        setProgress((p) => ({
          ...p,
          completed: p.completed + 1,
          results: [...results],
          current: null,
          status: "error",
        }));
        return;
      }
      setProgress((p) => ({ ...p, completed: p.completed + 1, results: [...results] }));
    }

    setProgress((p) => ({ ...p, current: null, status: "done" }));
    onRefreshBranches?.();
  };

  // Bulk delete branches
  const handleBulkDelete = async () => {
    setShowDeleteConfirm(false);
    const targetBranches = deletableInfo.deletable;
    if (targetBranches.length === 0) return;

    setProgress({
      total: targetBranches.length,
      completed: 0,
      current: null,
      results: [],
      status: "running",
    });

    const results: BulkOperationProgress["results"] = [];
    const deletedBranches: string[] = [];

    for (const branch of targetBranches) {
      setProgress((p) => ({ ...p, current: branch }));

      try {
        await api.deleteBranch(localPath, branch, true); // force delete
        results.push({ branch, success: true });
        deletedBranches.push(branch);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ branch, success: false, message });
      }
      setProgress((p) => ({ ...p, completed: p.completed + 1, results: [...results] }));
    }

    setProgress((p) => ({ ...p, current: null, status: "done" }));

    if (deletedBranches.length > 0) {
      onBranchesDeleted?.(deletedBranches);
      onRefreshBranches?.();
    }
  };

  // Reset progress
  const handleResetProgress = () => {
    setProgress({
      total: 0,
      completed: 0,
      current: null,
      results: [],
      status: "idle",
    });
  };

  // Close dropdown and reset pending
  const closeLabelDropdown = () => {
    setShowLabelDropdown(false);
    setPendingLabels(new Set());
  };

  const closeReviewerDropdown = () => {
    setShowReviewerDropdown(false);
    setPendingReviewers(new Set());
  };

  const isOperationRunning = progress.status === "running";

  return (
    <div className="task-detail-panel">
      <div className="task-detail-panel__header">
        <h3>{selectedBranches.size} branches selected</h3>
        <button
          className="task-detail-panel__close"
          onClick={onClearSelection}
          title="Clear selection"
          style={{ marginLeft: "auto" }}
          disabled={isOperationRunning}
        >
          ×
        </button>
      </div>

      <div style={{ padding: "16px", flex: 1, overflowY: "auto" }}>
        {/* Selected branches list with inline progress */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ color: "#9ca3af", fontSize: 12 }}>Selected branches:</div>
            {progress.status !== "idle" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {progress.status === "running" && (
                  <span style={{ color: "#3b82f6", fontSize: 11 }}>
                    {progress.completed}/{progress.total}
                  </span>
                )}
                {progress.status === "done" && (
                  <span style={{ color: "#4ade80", fontSize: 11 }}>Done</span>
                )}
                {progress.status === "error" && (
                  <span style={{ color: "#f87171", fontSize: 11 }}>Error</span>
                )}
                {progress.status !== "running" && (
                  <button
                    onClick={handleResetProgress}
                    style={{
                      padding: "2px 6px",
                      background: "#374151",
                      border: "none",
                      borderRadius: 3,
                      color: "#9ca3af",
                      fontSize: 10,
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {displayedBranches.map((branch) => {
              const hasPR = branchLinks.get(branch)?.some((l) => l.linkType === "pr" && l.status === "open");
              // Find result for this branch (may match branch name or branch (label) format)
              const result = progress.results.find((r) => r.branch === branch || r.branch.startsWith(branch + " "));
              const isProcessing = progress.status === "running" && progress.current === branch;
              return (
                <div
                  key={branch}
                  style={{
                    padding: "4px 8px",
                    background: "#1f2937",
                    borderRadius: 4,
                    fontSize: 13,
                    color: "#e5e7eb",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {/* Status indicator */}
                  {result ? (
                    <span
                      style={{
                        color: result.success ? "#4ade80" : "#f87171",
                        fontSize: 12,
                        width: 14,
                        flexShrink: 0,
                      }}
                      title={result.message}
                    >
                      {result.success ? "✓" : "✗"}
                    </span>
                  ) : isProcessing ? (
                    <span style={{ color: "#3b82f6", fontSize: 12, width: 14, flexShrink: 0 }}>●</span>
                  ) : progress.status === "running" ? (
                    <span style={{ color: "#6b7280", fontSize: 12, width: 14, flexShrink: 0 }}>○</span>
                  ) : null}
                  {hasPR && (
                    <span style={{ color: "#22c55e", fontSize: 10 }} title="Has open PR">
                      PR
                    </span>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
                </div>
              );
            })}
            {remainingCount > 0 && (
              <div style={{ color: "#6b7280", fontSize: 12, paddingLeft: 8 }}>...and {remainingCount} more</div>
            )}
          </div>
        </div>

        {/* PR Links textarea */}
        {prUrls.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>PR Links ({prUrls.length}):</div>
            <textarea
              readOnly
              value={prUrls.join("\n")}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{
                width: "100%",
                padding: 8,
                background: "#0f172a",
                border: "1px solid #374151",
                borderRadius: 4,
                color: "#e5e7eb",
                fontSize: 12,
                fontFamily: "monospace",
                resize: "vertical",
                minHeight: 60,
              }}
            />
          </div>
        )}

        {/* PR Bulk Operations */}
        {branchesWithPRs.length > 0 && (
          <div style={{ borderTop: "1px solid #374151", paddingTop: 16, marginBottom: 16 }}>
            <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>
              PR operations ({branchesWithPRs.length} branches with PRs):
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Refresh PRs */}
              <button
                onClick={handleRefreshPRs}
                disabled={isOperationRunning}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  background: isOperationRunning ? "#1f2937" : "#0c4a6e",
                  border: `1px solid ${isOperationRunning ? "#374151" : "#0ea5e9"}`,
                  borderRadius: 6,
                  color: isOperationRunning ? "#6b7280" : "#7dd3fc",
                  cursor: isOperationRunning ? "not-allowed" : "pointer",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                ↻ Refresh All PRs
              </button>

              {/* Add Label */}
              <Dropdown
                isOpen={showLabelDropdown}
                onClose={closeLabelDropdown}
                trigger={
                  <button
                    onClick={() => setShowLabelDropdown(!showLabelDropdown)}
                    disabled={isOperationRunning || quickLabels.length === 0}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      background: "#1f2937",
                      border: "1px solid #374151",
                      borderRadius: 6,
                      color: isOperationRunning || quickLabels.length === 0 ? "#6b7280" : "#e5e7eb",
                      cursor: isOperationRunning || quickLabels.length === 0 ? "not-allowed" : "pointer",
                      fontSize: 13,
                      textAlign: "left",
                      opacity: isOperationRunning ? 0.5 : 1,
                    }}
                  >
                    + Add Labels to All PRs
                    {quickLabels.length === 0 && (
                      <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>(no quick labels)</span>
                    )}
                  </button>
                }
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {/* Label list with checkboxes */}
                  <div style={{ maxHeight: 180, overflowY: "auto" }}>
                    {quickLabels.map((labelName) => {
                      const label = getLabelInfo(labelName);
                      const isSelected = pendingLabels.has(labelName);
                      return (
                        <button
                          key={labelName}
                          onClick={() => togglePendingLabel(labelName)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            padding: "8px 12px",
                            background: isSelected ? "#374151" : "transparent",
                            border: "none",
                            color: "#e5e7eb",
                            fontSize: 12,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "#2d3748";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <span
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 3,
                              border: isSelected ? "none" : "1px solid #4b5563",
                              background: isSelected ? "#3b82f6" : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 10,
                              color: "#fff",
                              flexShrink: 0,
                            }}
                          >
                            {isSelected && "✓"}
                          </span>
                          <LabelChip name={labelName} color={label?.color || "6b7280"} />
                        </button>
                      );
                    })}
                  </div>
                  {/* Apply footer */}
                  <div
                    style={{
                      borderTop: "1px solid #374151",
                      padding: "8px 12px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>
                      {pendingLabels.size} selected
                    </span>
                    <button
                      onClick={handleApplyLabels}
                      disabled={pendingLabels.size === 0}
                      style={{
                        padding: "6px 16px",
                        background: pendingLabels.size === 0 ? "#374151" : "#3b82f6",
                        border: "none",
                        borderRadius: 4,
                        color: pendingLabels.size === 0 ? "#6b7280" : "#fff",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: pendingLabels.size === 0 ? "not-allowed" : "pointer",
                      }}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </Dropdown>

              {/* Add Reviewer */}
              <Dropdown
                isOpen={showReviewerDropdown}
                onClose={closeReviewerDropdown}
                trigger={
                  <button
                    onClick={() => setShowReviewerDropdown(!showReviewerDropdown)}
                    disabled={isOperationRunning || quickReviewers.length === 0}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      background: "#1f2937",
                      border: "1px solid #374151",
                      borderRadius: 6,
                      color: isOperationRunning || quickReviewers.length === 0 ? "#6b7280" : "#e5e7eb",
                      cursor: isOperationRunning || quickReviewers.length === 0 ? "not-allowed" : "pointer",
                      fontSize: 13,
                      textAlign: "left",
                      opacity: isOperationRunning ? 0.5 : 1,
                    }}
                  >
                    + Add Reviewers to All PRs
                    {quickReviewers.length === 0 && (
                      <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>(no quick reviewers)</span>
                    )}
                  </button>
                }
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {/* Reviewer list with checkboxes */}
                  <div style={{ maxHeight: 180, overflowY: "auto" }}>
                    {quickReviewers.map((reviewerName) => {
                      const info = getReviewerInfo(reviewerName);
                      const isSelected = pendingReviewers.has(reviewerName);
                      return (
                        <button
                          key={reviewerName}
                          onClick={() => togglePendingReviewer(reviewerName)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            padding: "8px 12px",
                            background: isSelected ? "#374151" : "transparent",
                            border: "none",
                            color: "#e5e7eb",
                            fontSize: 12,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "#2d3748";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <span
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 3,
                              border: isSelected ? "none" : "1px solid #4b5563",
                              background: isSelected ? "#3b82f6" : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 10,
                              color: "#fff",
                              flexShrink: 0,
                            }}
                          >
                            {isSelected && "✓"}
                          </span>
                          {info.isTeam ? (
                            <TeamChip slug={reviewerName.replace("team/", "")} />
                          ) : (
                            <UserChip
                              login={info.login}
                              avatarUrl={"avatarUrl" in info ? info.avatarUrl : undefined}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Apply footer */}
                  <div
                    style={{
                      borderTop: "1px solid #374151",
                      padding: "8px 12px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>
                      {pendingReviewers.size} selected
                    </span>
                    <button
                      onClick={handleApplyReviewers}
                      disabled={pendingReviewers.size === 0}
                      style={{
                        padding: "6px 16px",
                        background: pendingReviewers.size === 0 ? "#374151" : "#3b82f6",
                        border: "none",
                        borderRadius: 4,
                        color: pendingReviewers.size === 0 ? "#6b7280" : "#fff",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: pendingReviewers.size === 0 ? "not-allowed" : "pointer",
                      }}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </Dropdown>
            </div>
          </div>
        )}

        {/* Serial Rebase */}
        <div style={{ borderTop: "1px solid #374151", paddingTop: 16, marginBottom: 16 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>Branch operations:</div>

          {/* Worktree selector */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 4 }}>Work in:</div>
            <WorktreeSelector
              nodes={nodes}
              selectedWorktree={selectedWorktree}
              onSelect={setSelectedWorktree}
              isOpen={showWorktreeSelector}
              onOpen={() => setShowWorktreeSelector(true)}
              onClose={() => setShowWorktreeSelector(false)}
              disabled={isOperationRunning}
            />
          </div>

          <button
            onClick={handleSerialRebase}
            disabled={isOperationRunning || selectedList.length < 2}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: isOperationRunning || selectedList.length < 2 ? "#1f2937" : "#4c1d95",
              border: `1px solid ${isOperationRunning || selectedList.length < 2 ? "#374151" : "#7c3aed"}`,
              borderRadius: 6,
              color: isOperationRunning || selectedList.length < 2 ? "#6b7280" : "#c4b5fd",
              cursor: isOperationRunning || selectedList.length < 2 ? "not-allowed" : "pointer",
              fontSize: 13,
              textAlign: "left",
            }}
          >
            <div style={{ fontWeight: 500 }}>Serial Rebase</div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
              Rebase branches in dependency order
            </div>
          </button>
          {selectedList.length >= 2 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
              Order: {sortedBranchesForRebase.slice(0, 3).join(" → ")}
              {sortedBranchesForRebase.length > 3 && ` → ...`}
            </div>
          )}

          {/* Bulk Delete */}
          {deletableInfo.deletable.length > 0 && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isOperationRunning}
              style={{
                width: "100%",
                marginTop: 12,
                padding: "8px 12px",
                background: isOperationRunning ? "#1f2937" : "#7f1d1d",
                border: `1px solid ${isOperationRunning ? "#374151" : "#ef4444"}`,
                borderRadius: 6,
                color: isOperationRunning ? "#6b7280" : "#f87171",
                cursor: isOperationRunning ? "not-allowed" : "pointer",
                fontSize: 13,
                textAlign: "left",
              }}
            >
              <div style={{ fontWeight: 500 }}>
                Delete Branches ({deletableInfo.deletable.length})
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                {deletableInfo.allDeletable
                  ? "All selected branches can be deleted"
                  : `${deletableInfo.notDeletable.length} cannot be deleted`}
              </div>
            </button>
          )}
          {deletableInfo.notDeletable.length > 0 && deletableInfo.deletable.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
              Cannot delete: {deletableInfo.notDeletable.slice(0, 2).map((d) => d.branch).join(", ")}
              {deletableInfo.notDeletable.length > 2 && ` (+${deletableInfo.notDeletable.length - 2} more)`}
            </div>
          )}
        </div>

        {/* Filter Bulk actions */}
        <div style={{ borderTop: "1px solid #374151", paddingTop: 16 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>Filter operations:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={onCheckAll}
              disabled={allChecked || isOperationRunning}
              style={{
                padding: "8px 12px",
                background: allChecked || isOperationRunning ? "#1f2937" : "#14532d",
                border: `1px solid ${allChecked || isOperationRunning ? "#374151" : "#22c55e"}`,
                borderRadius: 6,
                color: allChecked || isOperationRunning ? "#6b7280" : "#4ade80",
                cursor: allChecked || isOperationRunning ? "not-allowed" : "pointer",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>Check All</span>
              <span style={{ color: "#9ca3af", fontSize: 11 }}>(hide in filter)</span>
            </button>
            <button
              onClick={onUncheckAll}
              disabled={noneChecked || isOperationRunning}
              style={{
                padding: "8px 12px",
                background: noneChecked || isOperationRunning ? "#1f2937" : "#7f1d1d",
                border: `1px solid ${noneChecked || isOperationRunning ? "#374151" : "#ef4444"}`,
                borderRadius: 6,
                color: noneChecked || isOperationRunning ? "#6b7280" : "#f87171",
                cursor: noneChecked || isOperationRunning ? "not-allowed" : "pointer",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>Uncheck All</span>
              <span style={{ color: "#9ca3af", fontSize: 11 }}>(show in filter)</span>
            </button>
          </div>
        </div>

        {/* Keyboard shortcuts hint */}
        <div style={{ marginTop: 16, padding: 12, background: "#1f2937", borderRadius: 6 }}>
          <div style={{ color: "#9ca3af", fontSize: 11, marginBottom: 6 }}>Selection shortcuts:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#6b7280" }}>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Click</kbd>
              Single select
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Cmd</kbd>+
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginLeft: 4, marginRight: 4 }}>
                Click
              </kbd>
              Toggle
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Shift</kbd>+
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginLeft: 4, marginRight: 4 }}>
                Click
              </kbd>
              Range select
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Drag</kbd>
              Rectangle select
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>ESC</kbd>
              Clear selection
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div
          className="task-detail-panel__modal-overlay"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="task-detail-panel__modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 400 }}
          >
            <h4 style={{ margin: "0 0 12px", color: "#f87171" }}>
              Delete {deletableInfo.deletable.length} Branches?
            </h4>
            <p style={{ margin: "0 0 16px", color: "#9ca3af", fontSize: 13 }}>
              This will permanently delete the following branches from git and clean up associated data:
            </p>
            <div
              style={{
                maxHeight: 150,
                overflowY: "auto",
                background: "#0f172a",
                borderRadius: 4,
                padding: 8,
                marginBottom: 16,
              }}
            >
              {deletableInfo.deletable.map((branch) => (
                <div
                  key={branch}
                  style={{ fontSize: 12, color: "#e5e7eb", padding: "2px 0" }}
                >
                  • {branch}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                style={{
                  padding: "8px 16px",
                  background: "#374151",
                  border: "none",
                  borderRadius: 6,
                  color: "#e5e7eb",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                style={{
                  padding: "8px 16px",
                  background: "#dc2626",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Delete {deletableInfo.deletable.length} Branches
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
