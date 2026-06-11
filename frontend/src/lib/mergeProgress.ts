// Shared types describing per-branch merge progress, surfaced on the branch graph.
// The merge orchestration (single PR merge in TaskDetailPanel, stacked merge in
// MultiSelectPanel) reports these states up to TreeDashboard, which passes the map
// to BranchGraph so each node can show where the merge has got to.

export type MergePhase =
  | "waiting" // queued in a stacked merge, not started yet
  | "active" // currently being merged (re-targeting / checking / merging)
  | "merged" // merged successfully
  | "failed" // merge failed (see message for the reason)
  | "skipped"; // not attempted because an ancestor failed

export interface MergeNodeState {
  phase: MergePhase;
  /** Substep label while active ("→ develop", "merging…"), or the failure reason. */
  message?: string;
}

/** One per-branch update; a `null` state clears that branch's entry. */
export type MergeStateUpdate = [branch: string, state: MergeNodeState | null];
