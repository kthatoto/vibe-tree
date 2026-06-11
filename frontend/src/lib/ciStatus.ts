import type { GitHubCheck } from "./api";

export type ChecksStatus = "pending" | "success" | "failure" | null;

/** Parse the JSON checks array stored on a branch link / PR. Returns [] on failure. */
export function parseChecks(checksJson: string | null | undefined): GitHubCheck[] {
  if (!checksJson) return [];
  try {
    const parsed = JSON.parse(checksJson);
    return Array.isArray(parsed) ? (parsed as GitHubCheck[]) : [];
  } catch {
    return [];
  }
}

/**
 * Compute the all-green status from a checks array, excluding any check whose
 * name is in `ignored`. Mirrors the backend rule (FAILURE/ERROR -> failure;
 * else all SUCCESS/SKIPPED -> success; else pending). Returns the `fallback`
 * (the backend-cached status) when there is nothing to recompute.
 */
export function effectiveChecksStatus(
  checksJson: string | null | undefined,
  ignored: Set<string>,
  fallback: ChecksStatus
): ChecksStatus {
  // No ignores → identical to the backend-computed status; skip parsing.
  if (ignored.size === 0) return fallback;
  const all = parseChecks(checksJson);
  // No per-check data to recompute from → trust the backend value.
  if (all.length === 0) return fallback;
  const checks = all.filter((c) => !ignored.has(c.name));
  // Everything ignored → nothing left to block the all-green judgment.
  if (checks.length === 0) return "success";
  const hasFailure = checks.some(
    (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR"
  );
  if (hasFailure) return "failure";
  const allSuccess = checks.every(
    (c) => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED"
  );
  if (allSuccess) return "success";
  return "pending";
}
