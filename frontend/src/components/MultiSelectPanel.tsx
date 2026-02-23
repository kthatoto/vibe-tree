import { useMemo, useState, useCallback } from "react";
import { api, type BranchLink, type TreeEdge, type RepoLabel, type RepoCollaborator } from "../lib/api";
import { Dropdown, DropdownItem, DropdownEmpty } from "./atoms/Dropdown";
import { LabelChip, UserChip } from "./atoms/Chips";

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
  // Quick labels/reviewers (pre-selected in settings)
  quickLabels: string[];
  quickReviewers: string[];
  // For resolving label colors
  repoLabels: RepoLabel[];
  repoCollaborators: RepoCollaborator[];
  onRefreshBranches?: () => void;
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
  quickLabels,
  quickReviewers,
  repoLabels,
  repoCollaborators,
  onRefreshBranches,
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

  // Get branches with PRs
  const branchesWithPRs = useMemo(() => {
    return selectedList.filter((branch) => {
      const links = branchLinks.get(branch);
      return links?.some((l) => l.linkType === "pr" && l.status === "open");
    });
  }, [selectedList, branchLinks]);

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

  // Bulk add label
  const handleBulkAddLabel = async (labelName: string) => {
    setShowLabelDropdown(false);
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
        await api.addPrLabel(linkId, labelName);
        results.push({ branch, success: true });
      } catch (e) {
        results.push({ branch, success: false, message: String(e) });
      }
      setProgress((p) => ({ ...p, completed: p.completed + 1, results: [...results] }));
    }

    setProgress((p) => ({ ...p, current: null, status: "done" }));
    onRefreshBranches?.();
  };

  // Bulk add reviewer
  const handleBulkAddReviewer = async (reviewer: string) => {
    setShowReviewerDropdown(false);
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
        await api.addPrReviewer(linkId, reviewer);
        results.push({ branch, success: true });
      } catch (e) {
        results.push({ branch, success: false, message: String(e) });
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
        await api.rebase(localPath, branch, parentBranch);
        results.push({ branch, success: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ branch, success: false, message });
        // Stop on first error for rebase (subsequent rebases depend on previous)
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

  const isOperationRunning = progress.status === "running";

  return (
    <div className="panel">
      <div className="panel__header">
        <h3>{selectedBranches.size} branches selected</h3>
        <button
          className="btn-icon btn-icon--small"
          onClick={onClearSelection}
          title="Clear selection"
          style={{ marginLeft: "auto" }}
          disabled={isOperationRunning}
        >
          ×
        </button>
      </div>

      <div style={{ padding: "16px", overflowY: "auto", maxHeight: "calc(100vh - 300px)" }}>
        {/* Progress display */}
        {progress.status !== "idle" && (
          <div
            style={{
              marginBottom: 16,
              padding: 12,
              background: progress.status === "error" ? "#7f1d1d" : "#1e3a5f",
              borderRadius: 6,
              border: `1px solid ${progress.status === "error" ? "#ef4444" : "#3b82f6"}`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ color: "#e5e7eb", fontSize: 13, fontWeight: 500 }}>
                {progress.status === "running"
                  ? "Processing..."
                  : progress.status === "done"
                  ? "Completed"
                  : "Error"}
              </div>
              {progress.status !== "running" && (
                <button
                  onClick={handleResetProgress}
                  style={{
                    padding: "2px 8px",
                    background: "#374151",
                    border: "none",
                    borderRadius: 4,
                    color: "#9ca3af",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  Dismiss
                </button>
              )}
            </div>

            {/* Progress bar */}
            <div style={{ background: "#374151", borderRadius: 4, height: 8, marginBottom: 8 }}>
              <div
                style={{
                  background: progress.status === "error" ? "#ef4444" : "#3b82f6",
                  borderRadius: 4,
                  height: "100%",
                  width: `${(progress.completed / progress.total) * 100}%`,
                  transition: "width 0.3s",
                }}
              />
            </div>

            <div style={{ color: "#9ca3af", fontSize: 11 }}>
              {progress.completed} / {progress.total}
              {progress.current && (
                <span style={{ marginLeft: 8, color: "#6b7280" }}>Current: {progress.current}</span>
              )}
            </div>

            {/* Results */}
            {progress.results.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 100, overflowY: "auto" }}>
                {progress.results.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 11,
                      color: r.success ? "#4ade80" : "#f87171",
                      display: "flex",
                      gap: 4,
                    }}
                  >
                    <span>{r.success ? "✓" : "✗"}</span>
                    <span>{r.branch}</span>
                    {r.message && <span style={{ color: "#6b7280" }}>- {r.message}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Selected branches list */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>Selected branches:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {displayedBranches.map((branch) => {
              const hasPR = branchLinks.get(branch)?.some((l) => l.linkType === "pr" && l.status === "open");
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
                  {hasPR && (
                    <span style={{ color: "#22c55e", fontSize: 10 }} title="Has open PR">
                      PR
                    </span>
                  )}
                  {branch}
                </div>
              );
            })}
            {remainingCount > 0 && (
              <div style={{ color: "#6b7280", fontSize: 12, paddingLeft: 8 }}>...and {remainingCount} more</div>
            )}
          </div>
        </div>

        {/* PR Bulk Operations */}
        {branchesWithPRs.length > 0 && (
          <div style={{ borderTop: "1px solid #374151", paddingTop: 16, marginBottom: 16 }}>
            <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>
              PR operations ({branchesWithPRs.length} branches with PRs):
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Add Label */}
              <Dropdown
                isOpen={showLabelDropdown}
                onClose={() => setShowLabelDropdown(false)}
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
                    + Add Label to All PRs
                    {quickLabels.length === 0 && (
                      <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>(no quick labels)</span>
                    )}
                  </button>
                }
              >
                {quickLabels.length === 0 ? (
                  <DropdownEmpty>No quick labels configured</DropdownEmpty>
                ) : (
                  quickLabels.map((labelName) => {
                    const label = getLabelInfo(labelName);
                    return (
                      <DropdownItem key={labelName} onClick={() => handleBulkAddLabel(labelName)}>
                        <LabelChip name={labelName} color={label?.color || "6b7280"} />
                      </DropdownItem>
                    );
                  })
                )}
              </Dropdown>

              {/* Add Reviewer */}
              <Dropdown
                isOpen={showReviewerDropdown}
                onClose={() => setShowReviewerDropdown(false)}
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
                    + Add Reviewer to All PRs
                    {quickReviewers.length === 0 && (
                      <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>(no quick reviewers)</span>
                    )}
                  </button>
                }
              >
                {quickReviewers.length === 0 ? (
                  <DropdownEmpty>No quick reviewers configured</DropdownEmpty>
                ) : (
                  quickReviewers.map((reviewerName) => {
                    const info = getReviewerInfo(reviewerName);
                    if (info.isTeam) {
                      const teamSlug = reviewerName.replace("team/", "");
                      return (
                        <DropdownItem key={reviewerName} onClick={() => handleBulkAddReviewer(reviewerName)}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 14 }}>👥</span>
                            <span>{teamSlug}</span>
                          </span>
                        </DropdownItem>
                      );
                    }
                    return (
                      <DropdownItem key={reviewerName} onClick={() => handleBulkAddReviewer(reviewerName)}>
                        <UserChip
                          login={info.login}
                          avatarUrl={"avatarUrl" in info ? info.avatarUrl : undefined}
                        />
                      </DropdownItem>
                    );
                  })
                )}
              </Dropdown>
            </div>
          </div>
        )}

        {/* Serial Rebase */}
        <div style={{ borderTop: "1px solid #374151", paddingTop: 16, marginBottom: 16 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>Branch operations:</div>
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
    </div>
  );
}
