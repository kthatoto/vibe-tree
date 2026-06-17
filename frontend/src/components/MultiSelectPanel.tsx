import { useMemo, useState, useCallback, useEffect } from "react";
import { api, type BranchLink, type TreeEdge, type RepoLabel, type RepoCollaborator, type TreeNode, type PrShortcut } from "../lib/api";
import type { MergeStateUpdate } from "../lib/mergeProgress";
import { LabelChip, UserChip, TeamChip } from "./atoms/Chips";
import { WorktreeSelector } from "./atoms/WorktreeSelector";
import "./TaskDetailPanel.css";

// Max number of branches to operate on concurrently for bulk PR operations.
const BULK_CONCURRENCY = 8;

// Run an async task over items with bounded concurrency.
async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

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
  // Add all descendants of the currently selected branches to the selection
  onSelectDescendants?: () => void;
  // For bulk operations
  repoId: string;
  localPath: string;
  branchLinks: Map<string, BranchLink[]>;
  edges: TreeEdge[];
  nodes: TreeNode[];
  defaultBranch: string;
  // Favorite PR shortcuts (named label+reviewer sets, defined in settings)
  prShortcuts: PrShortcut[];
  // For resolving label colors
  repoLabels: RepoLabel[];
  repoCollaborators: RepoCollaborator[];
  onRefreshBranches?: () => void;
  onBranchesDeleted?: (deletedBranches: string[]) => void;
  // Show/hide the per-node "refreshing" spinner on the branch graph
  onBranchStatusRefreshStart?: (branches: string[]) => void;
  onBranchStatusRefreshEnd?: (branches: string[]) => void;
  // Report per-branch merge progress to the graph (and clear it)
  onMergeStateChange?: (updates: MergeStateUpdate[]) => void;
  onMergeStatesClear?: () => void;
}

export default function MultiSelectPanel({
  selectedBranches,
  checkedBranches,
  onCheckAll,
  onUncheckAll,
  onClearSelection,
  onSelectDescendants,
  repoId,
  localPath,
  branchLinks,
  edges,
  nodes,
  defaultBranch,
  prShortcuts,
  repoLabels,
  repoCollaborators,
  onRefreshBranches,
  onBranchesDeleted,
  onBranchStatusRefreshStart,
  onBranchStatusRefreshEnd,
  onMergeStateChange,
  onMergeStatesClear,
}: MultiSelectPanelProps) {
  const selectedList = useMemo(() => [...selectedBranches], [selectedBranches]);

  // How many not-yet-selected descendants the "select descendants" action would add
  const descendantsToAdd = useMemo(() => {
    if (selectedBranches.size === 0) return 0;
    const toAdd = new Set<string>();
    const stack = [...selectedBranches];
    while (stack.length > 0) {
      const branch = stack.pop()!;
      for (const e of edges) {
        if (e.parent === branch && !selectedBranches.has(e.child) && !toAdd.has(e.child)) {
          toAdd.add(e.child);
          stack.push(e.child);
        }
      }
    }
    return toAdd.size;
  }, [selectedBranches, edges]);

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


  // Get branches with PRs
  const branchesWithPRs = useMemo(() => {
    return selectedList.filter((branch) => {
      const links = branchLinks.get(branch);
      return links?.some((l) => l.linkType === "pr" && l.status === "open");
    });
  }, [selectedList, branchLinks]);

  // Get branches without PR links
  const branchesWithoutPRs = useMemo(() => {
    return selectedList.filter((branch) => {
      if (branch === defaultBranch) return false;
      const links = branchLinks.get(branch);
      return !links?.some((l) => l.linkType === "pr");
    });
  }, [selectedList, branchLinks, defaultBranch]);

  // Detect PRs whose baseBranch differs from Graph parent
  const mismatchedBaseBranches = useMemo(() => {
    const parentMap = new Map<string, string>();
    edges.forEach((e) => parentMap.set(e.child, e.parent));

    const mismatches: { branch: string; linkId: number; currentBase: string; suggestedBase: string }[] = [];
    for (const branch of branchesWithPRs) {
      const links = branchLinks.get(branch);
      const prLink = links?.find((l) => l.linkType === "pr" && l.status === "open");
      if (!prLink?.baseBranch) continue;
      const graphParent = parentMap.get(branch);
      if (graphParent && prLink.baseBranch !== graphParent) {
        mismatches.push({
          branch,
          linkId: prLink.id,
          currentBase: prLink.baseBranch,
          suggestedBase: graphParent,
        });
      }
    }
    return mismatches;
  }, [branchesWithPRs, branchLinks, edges]);

  // Get PR info for selected branches (sorted by branch name)
  const prInfoList = useMemo(() => {
    return selectedList
      .map((branch) => {
        const links = branchLinks.get(branch);
        const prLink = links?.find((l) => l.linkType === "pr" && l.status === "open");
        return { branch, url: prLink?.url ?? null, title: prLink?.title ?? null };
      })
      .sort((a, b) => a.branch.localeCompare(b.branch));
  }, [selectedList, branchLinks]);

  const prUrls = useMemo(() => {
    return prInfoList.filter((p) => p.url).map((p) => p.url!);
  }, [prInfoList]);

  // Build copy text: <PR URL> <branch> <title> per line
  const copyText = useMemo(() => {
    return prInfoList
      .map((p) => [p.url, p.branch, p.title].filter(Boolean).join(" "))
      .join("\n");
  }, [prInfoList]);

  // Cmd+C to copy branch info
  const [showCopied, setShowCopied] = useState(false);
  useEffect(() => {
    const handleCopy = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && copyText) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        // Don't override if user has text selected
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        e.preventDefault();
        navigator.clipboard.writeText(copyText);
        setShowCopied(true);
        setTimeout(() => setShowCopied(false), 1500);
      }
    };
    document.addEventListener("keydown", handleCopy);
    return () => document.removeEventListener("keydown", handleCopy);
  }, [copyText]);

  // Node map for quick lookup
  const nodeMap = useMemo(() => {
    const map = new Map<string, TreeNode>();
    nodes.forEach((n) => map.set(n.branchName, n));
    return map;
  }, [nodes]);

  // Check if a branch is deletable:
  // - Not the default branch
  // - PR is merged OR closed OR no commits (ahead=0) OR no PR attached
  // - Branch not in local git but has DB data → deletable (cleanup only)
  const isDeletable = useCallback(
    (branch: string): { deletable: boolean; reason?: string } => {
      if (branch === defaultBranch) {
        return { deletable: false, reason: "default branch" };
      }

      const node = nodeMap.get(branch);
      const links = branchLinks.get(branch);
      const prLink = links?.find((l) => l.linkType === "pr");

      // If branch doesn't exist locally but has DB data, allow cleanup
      if (!node) {
        // If there's any data to clean up (links, etc.), allow deletion
        if (links && links.length > 0) {
          return { deletable: true };
        }
        return { deletable: false, reason: "not found" };
      }

      // Check if has worktree
      if (node.worktree) {
        return { deletable: false, reason: "has worktree" };
      }

      // If PR exists and is open, not deletable
      if (prLink) {
        if (prLink.status === "merged") {
          return { deletable: true };
        }
        if (prLink.status === "closed") {
          // Closed PR (not merged) - allow deletion
          return { deletable: true };
        }
        if (prLink.status === "open") {
          return { deletable: false, reason: "PR is open" };
        }
      }

      // No PR - check if has commits
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
  // Stacked merge confirmation state
  const [showStackedMergeConfirm, setShowStackedMergeConfirm] = useState(false);

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

  // Get the open PR link (with number/base) for a branch
  const getPRLink = useCallback(
    (branch: string): BranchLink | null =>
      branchLinks.get(branch)?.find((l) => l.linkType === "pr" && l.status === "open") ?? null,
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
      const visited = new Set<string>();
      while (parentMap.has(current)) {
        if (visited.has(current)) break; // Prevent infinite loop on circular refs
        visited.add(current);
        current = parentMap.get(current)!;
        depth++;
      }
      return depth;
    };
    return [...selectedList].sort((a, b) => getDepth(a) - getDepth(b));
  }, [selectedList, parentMap]);

  // Selected branches with an open PR, ordered by the actual PR base chain so a
  // PR is always merged after the (selected) PR it is based on. This guarantees
  // e.g. develop←PR1←PR2 merges PR1 first, then PR2 (retargeted to develop).
  const stackedMergeBranches = useMemo(() => {
    const openPr = (b: string) =>
      branchLinks.get(b)?.find((l) => l.linkType === "pr" && l.status === "open") ?? null;
    const prBranches = selectedList.filter((b) => {
      const link = openPr(b);
      return !!link && link.number != null;
    });
    const prSet = new Set(prBranches);
    // Only PRs whose base chain (within the selection) bottoms out at the default
    // branch are mergeable into it via stacked merge. A PR whose root targets some
    // other branch is "dangling" and must NOT look mergeable into the default branch.
    const rootedCache = new Map<string, boolean>();
    const isRootedAtDefault = (b: string, seen: Set<string>): boolean => {
      const cached = rootedCache.get(b);
      if (cached !== undefined) return cached;
      if (seen.has(b)) return false; // cycle: not rooted
      seen.add(b);
      const base = openPr(b)?.baseBranch;
      const result =
        !base || base === defaultBranch
          ? true
          : prSet.has(base)
            ? isRootedAtDefault(base, seen)
            : false; // base is a non-selected, non-default branch → dangling
      rootedCache.set(b, result);
      return result;
    };
    const rooted = prBranches.filter((b) => isRootedAtDefault(b, new Set()));
    // Topological sort by PR base branch (base not in the remaining set → ready)
    const remaining = new Set(rooted);
    const ordered: string[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining].filter((b) => {
        const base = openPr(b)?.baseBranch;
        return !base || !remaining.has(base);
      });
      const batch = ready.length > 0 ? ready : [...remaining]; // break cycles defensively
      for (const b of batch) {
        ordered.push(b);
        remaining.delete(b);
      }
    }
    return ordered;
  }, [selectedList, branchLinks, defaultBranch]);

  // Run a one-op-per-item bulk operation across branches in parallel (bounded concurrency).
  const runBulkPerItem = async <T,>(
    items: T[],
    labelOf: (item: T) => string,
    run: (item: T) => Promise<{ success: boolean; message?: string }>
  ) => {
    if (items.length === 0) return;
    setProgress({ total: items.length, completed: 0, current: null, results: [], status: "running" });
    const results: BulkOperationProgress["results"] = [];
    let completed = 0;
    await forEachWithConcurrency(items, BULK_CONCURRENCY, async (item) => {
      const label = labelOf(item);
      setProgress((p) => ({ ...p, current: label }));
      try {
        const r = await run(item);
        results.push({ branch: label, success: r.success, message: r.message });
      } catch (e: unknown) {
        results.push({ branch: label, success: false, message: e instanceof Error ? e.message : String(e) });
      }
      completed++;
      setProgress((p) => ({ ...p, completed, results: [...results] }));
    });
    setProgress((p) => ({ ...p, current: null, status: "done" }));
  };

  // Apply a favorite PR shortcut (its labels + reviewers, add-only) to the
  // selected branches' open PRs in one bulk operation. Branches are processed
  // in parallel; within a single PR the operations run sequentially so
  // concurrent edits don't race on the same PR.
  const handleApplyShortcut = async (shortcut: PrShortcut) => {
    if (progress.status === "running") return;

    const targetBranches = branchesWithPRs;
    const labels = shortcut.labels;
    const reviewers = shortcut.reviewers;
    const totalOps = targetBranches.length * (labels.length + reviewers.length);
    if (totalOps === 0) return;

    setProgress({ total: totalOps, completed: 0, current: null, results: [], status: "running" });

    const results: BulkOperationProgress["results"] = [];
    let completed = 0;
    const record = (branch: string, success: boolean, message?: string) => {
      results.push({ branch, success, message });
      completed++;
      setProgress((p) => ({ ...p, completed, results: [...results] }));
    };

    await forEachWithConcurrency(targetBranches, BULK_CONCURRENCY, async (branch) => {
      const linkId = getPRLinkId(branch);
      for (const label of labels) {
        const opLabel = `${branch} (+${label})`;
        if (!linkId) { record(opLabel, false, "No PR found"); continue; }
        setProgress((p) => ({ ...p, current: opLabel }));
        try {
          await api.addPrLabel(linkId, label);
          record(opLabel, true);
        } catch (e: unknown) {
          record(opLabel, false, e instanceof Error ? e.message : String(e));
        }
      }
      for (const reviewer of reviewers) {
        const opLabel = `${branch} (+${reviewer})`;
        if (!linkId) { record(opLabel, false, "No PR found"); continue; }
        setProgress((p) => ({ ...p, current: opLabel }));
        try {
          await api.addPrReviewer(linkId, reviewer);
          record(opLabel, true);
        } catch (e: unknown) {
          record(opLabel, false, e instanceof Error ? e.message : String(e));
        }
      }
    });

    setProgress((p) => ({ ...p, current: null, status: "done" }));
    onRefreshBranches?.();
  };

  // Sync base branches to match Graph parent (parallel)
  const handleSyncBaseBranches = async () => {
    if (mismatchedBaseBranches.length === 0) return;
    await runBulkPerItem(
      mismatchedBaseBranches,
      (m) => `${m.branch}: → ${m.suggestedBase}`,
      async ({ linkId, suggestedBase }) => {
        await api.changePrBaseBranch(linkId, suggestedBase);
        return { success: true };
      }
    );
    onRefreshBranches?.();
  };

  // Refresh all PRs (parallel)
  const handleRefreshPRs = async () => {
    if (branchesWithPRs.length === 0) return;
    onBranchStatusRefreshStart?.(branchesWithPRs);
    try {
      await runBulkPerItem(
        branchesWithPRs,
        (branch) => branch,
        async (branch) => {
          const linkId = getPRLinkId(branch);
          if (!linkId) return { success: false, message: "No PR found" };
          await api.refreshBranchLink(linkId);
          return { success: true };
        }
      );
    } finally {
      onBranchStatusRefreshEnd?.(branchesWithPRs);
    }
    onRefreshBranches?.();
  };

  // Detect PRs for branches without PR links (parallel)
  const handleDetectPRs = async () => {
    if (branchesWithoutPRs.length === 0) return;
    await runBulkPerItem(
      branchesWithoutPRs,
      (branch) => branch,
      async (branch) => {
        const result = await api.detectPr(repoId, branch);
        return { success: true, message: result.found ? `PR #${result.link?.number}` : "No PR found" };
      }
    );
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

  // Stacked merge: merge the selected PRs into the default branch in dependency
  // order. Each PR is retargeted to the default branch (if needed), waited on
  // until mergeable, then merged. Stops on the first failure.
  const handleStackedMerge = async () => {
    setShowStackedMergeConfirm(false);
    const prs = stackedMergeBranches
      .map((b) => ({ branch: b, link: getPRLink(b) }))
      .filter((x): x is { branch: string; link: BranchLink } => !!x.link && x.link.number != null);
    if (prs.length === 0) return;

    const linkOf = new Map(prs.map((p) => [p.branch, p.link]));
    const branchSet = new Set(prs.map((p) => p.branch));
    // parent = the selected PR whose branch is this PR's base; null = chain root
    const parentOf = new Map<string, string | null>();
    for (const { branch, link } of prs) {
      const base = link.baseBranch;
      parentOf.set(branch, base && branchSet.has(base) ? base : null);
    }
    const childrenOf = (b: string) => prs.filter((p) => parentOf.get(p.branch) === b).map((p) => p.branch);

    setProgress({ total: prs.length, completed: 0, current: null, results: [], status: "running" });
    onMergeStatesClear?.();
    onMergeStateChange?.(prs.map((p) => [p.branch, { phase: "waiting" }] as MergeStateUpdate));
    const results: BulkOperationProgress["results"] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let completed = 0;
    const merged = new Set<string>();
    const failed = new Set<string>();
    const record = (branch: string, success: boolean, message?: string) => {
      results.push({ branch, success, message });
      completed++;
      setProgress((p) => ({ ...p, completed, results: [...results] }));
    };

    // Merge a single PR: re-target it to the default branch if needed, wait
    // patiently until it is truly mergeable (CLEAN), then merge. Throws on failure.
    const mergeOne = async (branch: string, link: BranchLink) => {
      const prNumber = link.number!;
      // Non-roots: the parent was just merged → its branch is being deleted and
      // GitHub is re-targeting this PR to the default branch. Give it time.
      if (parentOf.get(branch) !== null) {
        setProgress((p) => ({ ...p, current: `${branch}: waiting for re-target…` }));
        onMergeStateChange?.([[branch, { phase: "active", message: "waiting for re-target…" }]]);
        await sleep(10000);
      }
      setProgress((p) => ({ ...p, current: `${branch}: checking…` }));
      onMergeStateChange?.([[branch, { phase: "active", message: "checking…" }]]);
      let retargeted = false;
      for (let i = 0; i < 20; i++) {
        const st = await api.getPrMergeStatus(repoId, prNumber);
        if (st.state === "MERGED") return; // already merged
        if (st.state !== "OPEN") throw new Error(`PR is ${st.state.toLowerCase()}`);
        if (st.mergeable === "CONFLICTING") throw new Error("has conflicts");
        if (st.baseRefName && st.baseRefName !== defaultBranch) {
          if (!retargeted) {
            setProgress((p) => ({ ...p, current: `${branch}: → ${defaultBranch}` }));
            onMergeStateChange?.([[branch, { phase: "active", message: `→ ${defaultBranch}` }]]);
            await api.changePrBaseBranch(link.id, defaultBranch);
            retargeted = true;
            await sleep(2000);
          }
          await sleep(3000);
          continue; // re-check the base
        }
        const mss = st.mergeStateStatus;
        if (st.mergeable === "MERGEABLE" && (mss === "CLEAN" || mss === "UNSTABLE" || mss === "HAS_HOOKS")) {
          setProgress((p) => ({ ...p, current: `${branch}: merging…` }));
          onMergeStateChange?.([[branch, { phase: "active", message: "merging…" }]]);
          await api.mergePr(repoId, prNumber);
          return;
        }
        if (st.mergeable === "MERGEABLE" && (mss === "BLOCKED" || mss === "BEHIND" || mss === "DRAFT")) {
          throw new Error(mss.toLowerCase());
        }
        await sleep(3000); // UNKNOWN → keep waiting patiently
      }
      throw new Error("not mergeable (timed out)");
    };

    // Run a chain from this PR: merge it, then run its children. Children of the
    // same parent run in parallel; independent chains (separate roots) run in
    // parallel too. A failure stops only its own subtree.
    const runFrom = async (branch: string): Promise<void> => {
      const link = linkOf.get(branch)!;
      try {
        await mergeOne(branch, link);
        merged.add(branch);
        record(branch, true);
        onMergeStateChange?.([[branch, { phase: "merged" }]]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.add(branch);
        record(branch, false, message);
        onMergeStateChange?.([[branch, { phase: "failed", message }]]);
        return; // do not merge descendants of a failed PR
      }
      await Promise.all(childrenOf(branch).map((c) => runFrom(c)));
    };

    const roots = prs.filter((p) => parentOf.get(p.branch) === null).map((p) => p.branch);
    await Promise.all(roots.map((r) => runFrom(r)));

    // Descendants of a failed PR were never attempted → mark them skipped
    for (const { branch } of prs) {
      if (!merged.has(branch) && !failed.has(branch)) {
        record(branch, false, "skipped (ancestor not merged)");
        onMergeStateChange?.([[branch, { phase: "skipped", message: "skipped (ancestor not merged)" }]]);
      }
    }

    const anyFailed = results.some((r) => !r.success);
    setProgress((p) => ({ ...p, current: null, status: anyFailed ? "error" : "done" }));
    onRefreshBranches?.();
  };

  // Press "m" to open the stacked merge confirmation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "m") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (stackedMergeBranches.length > 0 && progress.status !== "running") {
        e.preventDefault();
        setShowStackedMergeConfirm(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [stackedMergeBranches.length, progress.status]);

  // Reset progress
  const handleResetProgress = () => {
    setProgress({
      total: 0,
      completed: 0,
      current: null,
      results: [],
      status: "idle",
    });
    onMergeStatesClear?.();
  };

  const isOperationRunning = progress.status === "running";

  return (
    <div className="task-detail-panel">
      <div className="task-detail-panel__header">
        <h3>{selectedBranches.size} branches selected</h3>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {onSelectDescendants && descendantsToAdd > 0 && (
            <button
              className="task-detail-panel__fetch-btn"
              onClick={onSelectDescendants}
              title="Add all descendants of the selected branches to the selection"
              disabled={isOperationRunning}
            >
              {`+ Descendants (${descendantsToAdd})`}
            </button>
          )}
          <button
            className="task-detail-panel__close"
            onClick={onClearSelection}
            title="Clear selection"
            disabled={isOperationRunning}
          >
            ×
          </button>
        </div>
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
              const prLink = branchLinks.get(branch)?.find((l) => l.linkType === "pr" && l.status === "open");
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
                  {prLink && (
                    <a
                      href={prLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: "#22c55e", fontSize: 10, textDecoration: "none", flexShrink: 0 }}
                      title={prLink.url}
                    >
                      PR
                    </a>
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

        {/* Branches textarea */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 4 }}>Branches ({selectedList.length}):</div>
          <textarea
            readOnly
            value={prInfoList.map((p) => p.branch).join("\n")}
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
              minHeight: 40,
            }}
          />
        </div>

        {/* PR Links textarea */}
        {prUrls.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 4 }}>PR Links ({prUrls.length}):</div>
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
                minHeight: 40,
              }}
            />
          </div>
        )}

        {/* Cmd+C hint */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          {showCopied && <span style={{ color: "#22c55e", fontSize: 11 }}>Copied!</span>}
          <span style={{ color: "#6b7280", fontSize: 10, marginLeft: "auto" }}>Cmd+C to copy all</span>
        </div>

        {/* Detect PRs for branches without PR links */}
        {branchesWithoutPRs.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <button
              onClick={handleDetectPRs}
              disabled={isOperationRunning}
              style={{
                width: "100%",
                padding: "8px 12px",
                background: isOperationRunning ? "#1f2937" : "#14532d",
                border: `1px solid ${isOperationRunning ? "#374151" : "#22c55e"}`,
                borderRadius: 6,
                color: isOperationRunning ? "#6b7280" : "#4ade80",
                cursor: isOperationRunning ? "not-allowed" : "pointer",
                fontSize: 13,
                textAlign: "left",
              }}
            >
              <div style={{ fontWeight: 500 }}>
                Detect PRs ({branchesWithoutPRs.length})
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                Find existing PRs for branches without links
              </div>
            </button>
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

              {/* Stacked Merge */}
              {stackedMergeBranches.length > 0 && (
                <button
                  onClick={() => setShowStackedMergeConfirm(true)}
                  disabled={isOperationRunning}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    background: isOperationRunning ? "#1f2937" : "#064e3b",
                    border: `1px solid ${isOperationRunning ? "#374151" : "#10b981"}`,
                    borderRadius: 6,
                    color: isOperationRunning ? "#6b7280" : "#6ee7b7",
                    cursor: isOperationRunning ? "not-allowed" : "pointer",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                >
                  <div style={{ fontWeight: 500 }}>
                    ⤵ Stacked Merge ({stackedMergeBranches.length}) → {defaultBranch}
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                    Merge PRs into {defaultBranch} in dependency order
                  </div>
                </button>
              )}

              {/* Sync Base Branches */}
              {mismatchedBaseBranches.length > 0 && (
                <button
                  onClick={handleSyncBaseBranches}
                  disabled={isOperationRunning}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    background: isOperationRunning ? "#1f2937" : "#78350f",
                    border: `1px solid ${isOperationRunning ? "#374151" : "#f59e0b"}`,
                    borderRadius: 6,
                    color: isOperationRunning ? "#6b7280" : "#fbbf24",
                    cursor: isOperationRunning ? "not-allowed" : "pointer",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                >
                  <div style={{ fontWeight: 500 }}>
                    Sync Base Branches ({mismatchedBaseBranches.length})
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                    Align PR base branches with Graph
                  </div>
                </button>
              )}

              {/* Apply favorite PR shortcut (labels + reviewers, add-only, one-click) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>
                  {prShortcuts.length === 0
                    ? "No shortcuts — define them in Settings → PR → Shortcuts"
                    : `Apply shortcut → ${branchesWithPRs.length} PR${branchesWithPRs.length === 1 ? "" : "s"}`}
                </div>
                {prShortcuts.map((shortcut, i) => {
                  const isEmpty = shortcut.labels.length === 0 && shortcut.reviewers.length === 0;
                  const displayName = shortcut.name || `Shortcut ${i + 1}`;
                  return (
                    <button
                      key={i}
                      onClick={() => handleApplyShortcut(shortcut)}
                      disabled={isOperationRunning || isEmpty}
                      title={isEmpty ? "This shortcut is empty" : `Apply "${displayName}" to ${branchesWithPRs.length} PR(s)`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        background: isOperationRunning || isEmpty ? "#1f2937" : "#0f172a",
                        border: `1px solid ${isOperationRunning || isEmpty ? "#374151" : "#334155"}`,
                        borderRadius: 6,
                        color: isOperationRunning || isEmpty ? "#6b7280" : "#e5e7eb",
                        cursor: isOperationRunning || isEmpty ? "not-allowed" : "pointer",
                        fontSize: 13,
                        textAlign: "left",
                      }}
                    >
                      {i < 9 && (
                        <kbd
                          style={{
                            flexShrink: 0,
                            fontSize: 10,
                            fontFamily: "monospace",
                            color: "#9ca3af",
                            background: "#1f2937",
                            border: "1px solid #374151",
                            borderRadius: 4,
                            padding: "1px 5px",
                          }}
                        >
                          ⇧{i + 1}
                        </kbd>
                      )}
                      <span style={{ flexShrink: 0, fontWeight: 600 }}>{displayName}</span>
                      {isEmpty ? (
                        <span style={{ fontSize: 11, color: "#6b7280" }}>(empty)</span>
                      ) : (
                        <span style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", minWidth: 0 }}>
                          {shortcut.labels.map((labelName) => {
                            const info = repoLabels.find((l) => l.name === labelName);
                            return <LabelChip key={`l-${labelName}`} name={labelName} color={info?.color ?? "6b7280"} />;
                          })}
                          {shortcut.reviewers.map((reviewer) => {
                            if (reviewer.startsWith("team/")) {
                              return <TeamChip key={`r-${reviewer}`} slug={reviewer.slice("team/".length)} />;
                            }
                            const c = repoCollaborators.find((rc) => rc.login === reviewer);
                            return <UserChip key={`r-${reviewer}`} login={reviewer} name={c?.name} avatarUrl={c?.avatarUrl} />;
                          })}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

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

      {showStackedMergeConfirm && (
        <div
          className="task-detail-panel__modal-overlay"
          onClick={() => setShowStackedMergeConfirm(false)}
        >
          <div
            className="task-detail-panel__modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 420 }}
          >
            <h4 style={{ margin: "0 0 12px", color: "#6ee7b7" }}>
              Stacked merge {stackedMergeBranches.length} PR{stackedMergeBranches.length === 1 ? "" : "s"} → {defaultBranch}?
            </h4>
            <p style={{ margin: "0 0 16px", color: "#9ca3af", fontSize: 13 }}>
              Merged from the root into {defaultBranch}. Each PR is re-targeted to {defaultBranch} after its parent merges. Independent chains run in parallel; a conflict / non-mergeable PR stops only its own chain.
            </p>
            <div
              style={{
                maxHeight: 180,
                overflowY: "auto",
                background: "#0f172a",
                borderRadius: 4,
                padding: 8,
                marginBottom: 16,
              }}
            >
              {stackedMergeBranches.map((branch, i) => (
                <div
                  key={branch}
                  style={{ fontSize: 12, color: "#e5e7eb", padding: "2px 0", fontFamily: "monospace" }}
                >
                  {i + 1}. {branch}{getPRLink(branch)?.number ? ` (#${getPRLink(branch)!.number})` : ""}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowStackedMergeConfirm(false)}
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
                autoFocus
                onClick={handleStackedMerge}
                style={{
                  padding: "8px 16px",
                  background: "#059669",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Merge {stackedMergeBranches.length} PR{stackedMergeBranches.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
