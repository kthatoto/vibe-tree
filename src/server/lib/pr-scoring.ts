/**
 * Smart PR refresh scoring and selection
 *
 * Prioritizes PRs that are more likely to have changed:
 * - CI pending (likely to change soon)
 * - Local/worktree branches (user is working on them)
 * - Stale cache (hasn't been updated recently)
 * - Random factor (ensures all PRs get updated eventually)
 */

export interface CachedPR {
  branchName: string;
  checksStatus: string | null;
  updatedAt: string | null;
}

export interface PRRefreshContext {
  localBranches: Set<string>;
  worktreeBranches: Set<string>;
  now: number;
}

export interface ScoredPR {
  branchName: string;
  score: number;
  isLocal: boolean;
}

const WEIGHTS = {
  // Local branch: moderate priority
  LOCAL_BRANCH: 20,
  // Worktree: handled separately (always included)
  WORKTREE: 0,
  // CI pending: likely to change soon
  CI_PENDING: 30,
  // Staleness: 2 points per minute since last update (max 60)
  // This ensures PRs get rotated over time
  STALENESS_PER_MIN: 2,
  STALENESS_MAX: 60,
  // Random factor for fairness (larger = more rotation)
  RANDOM_MAX: 25,
};

/**
 * Calculate refresh priority score for a PR
 */
export function calculatePRScore(
  pr: CachedPR,
  context: PRRefreshContext
): number {
  let score = 0;

  // 1. Worktree branch (highest priority - user is actively working)
  if (context.worktreeBranches.has(pr.branchName)) {
    score += WEIGHTS.WORKTREE;
  }
  // 2. Local branch (high priority)
  else if (context.localBranches.has(pr.branchName)) {
    score += WEIGHTS.LOCAL_BRANCH;
  }

  // 3. CI pending (likely to change soon)
  if (pr.checksStatus === "pending") {
    score += WEIGHTS.CI_PENDING;
  }

  // 4. Staleness (older = higher priority)
  if (pr.updatedAt) {
    const updatedAt = new Date(pr.updatedAt).getTime();
    const minutesSinceUpdate = (context.now - updatedAt) / 60000;
    score += Math.min(
      WEIGHTS.STALENESS_MAX,
      minutesSinceUpdate * WEIGHTS.STALENESS_PER_MIN
    );
  } else {
    // Never updated = max staleness
    score += WEIGHTS.STALENESS_MAX;
  }

  // 5. Random factor (ensures all PRs get updated eventually)
  score += Math.random() * WEIGHTS.RANDOM_MAX;

  return score;
}

/**
 * Select PRs to refresh based on scoring
 *
 * Strategy:
 * - ALWAYS include worktree branches (user is actively working)
 * - Fill remaining slots with rotating selection of other PRs
 */
export function selectPRsToRefresh(
  allPRs: CachedPR[],
  context: PRRefreshContext,
  options: {
    maxTotal?: number;      // Max PRs to refresh total (excluding worktree)
    otherMax?: number;      // Max non-worktree PRs
  } = {}
): ScoredPR[] {
  const {
    maxTotal = 5,
    otherMax = 3,
  } = options;

  // Separate worktree branches (always included) from others
  const worktreePRs: ScoredPR[] = [];
  const otherPRs: ScoredPR[] = [];

  for (const pr of allPRs) {
    const isWorktree = context.worktreeBranches.has(pr.branchName);
    const scored: ScoredPR = {
      branchName: pr.branchName,
      score: calculatePRScore(pr, context),
      isLocal: context.localBranches.has(pr.branchName),
    };

    if (isWorktree) {
      worktreePRs.push(scored);
    } else {
      otherPRs.push(scored);
    }
  }

  // Sort other PRs by score descending
  otherPRs.sort((a, b) => b.score - a.score);

  // Select: all worktree PRs + top N other PRs
  const selected: ScoredPR[] = [...worktreePRs];

  // Add other PRs up to limit
  for (const pr of otherPRs) {
    if (selected.length >= maxTotal) break;
    if (selected.length - worktreePRs.length >= otherMax) break;
    selected.push(pr);
  }

  return selected;
}
