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
 * - Simply pick top N PRs by score (no special treatment for worktree)
 */
export function selectPRsToRefresh(
  allPRs: CachedPR[],
  context: PRRefreshContext,
  options: {
    maxTotal?: number;      // Max PRs to refresh
  } = {}
): ScoredPR[] {
  const { maxTotal = 5 } = options;

  // Score all PRs
  const scoredPRs: ScoredPR[] = allPRs.map(pr => ({
    branchName: pr.branchName,
    score: calculatePRScore(pr, context),
    isLocal: context.localBranches.has(pr.branchName),
  }));

  // Sort by score descending and take top N
  scoredPRs.sort((a, b) => b.score - a.score);

  return scoredPRs.slice(0, maxTotal);
}
