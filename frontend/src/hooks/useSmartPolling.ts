import { useEffect, useRef, useCallback } from "react";

interface SmartPollingOptions {
  /** Local path of the repository */
  localPath: string | null;
  /** Whether the user is editing edges */
  isEditingEdge: boolean;
  /** Whether any worktree is dirty */
  hasDirtyWorktree: boolean;
  /** Callback to trigger a scan */
  onTriggerScan: (localPath: string) => void;
  /** Whether polling is enabled */
  enabled?: boolean;
}

/**
 * Polling intervals in milliseconds
 */
const INTERVALS = {
  /** Active window + dirty worktree: more frequent updates */
  ACTIVE_DIRTY: 30 * 1000, // 30s
  /** Active window + clean: moderate updates */
  ACTIVE_CLEAN: 60 * 1000, // 60s
  /** Hidden/inactive window: infrequent updates */
  HIDDEN: 300 * 1000, // 5min
} as const;

/**
 * Smart polling hook that adjusts polling frequency based on:
 * - Window visibility (active vs hidden)
 * - Edit mode (pause during edge editing)
 * - Dirty worktree status (more frequent when changes detected)
 */
export function useSmartPolling({
  localPath,
  isEditingEdge,
  hasDirtyWorktree,
  onTriggerScan,
  enabled = true,
}: SmartPollingOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScanTimeRef = useRef<number>(0);

  /**
   * Calculate the appropriate polling interval based on current state
   */
  const getInterval = useCallback(() => {
    // Document hidden = long interval
    if (document.visibilityState === "hidden") {
      return INTERVALS.HIDDEN;
    }

    // Active + dirty worktree = short interval
    if (hasDirtyWorktree) {
      return INTERVALS.ACTIVE_DIRTY;
    }

    // Active + clean = moderate interval
    return INTERVALS.ACTIVE_CLEAN;
  }, [hasDirtyWorktree]);

  /**
   * Schedule the next poll
   */
  const scheduleNextPoll = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    if (!enabled || !localPath || isEditingEdge) {
      return;
    }

    const interval = getInterval();
    timerRef.current = setTimeout(() => {
      // Don't scan if we're editing
      if (isEditingEdge) {
        scheduleNextPoll();
        return;
      }

      // Trigger scan
      const now = Date.now();
      lastScanTimeRef.current = now;
      onTriggerScan(localPath);

      // Schedule next
      scheduleNextPoll();
    }, interval);
  }, [enabled, localPath, isEditingEdge, getInterval, onTriggerScan]);

  /**
   * Handle visibility change - reschedule with appropriate interval
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Window became visible - check if we should scan immediately
        const timeSinceLastScan = Date.now() - lastScanTimeRef.current;
        const interval = getInterval();

        if (timeSinceLastScan >= interval && localPath && !isEditingEdge) {
          // It's been long enough, scan now
          lastScanTimeRef.current = Date.now();
          onTriggerScan(localPath);
        }
      }
      // Reschedule with new interval
      scheduleNextPoll();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [getInterval, localPath, isEditingEdge, onTriggerScan, scheduleNextPoll]);

  /**
   * Start/stop polling when dependencies change
   */
  useEffect(() => {
    if (enabled && localPath && !isEditingEdge) {
      scheduleNextPoll();
    } else {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, localPath, isEditingEdge, scheduleNextPoll]);

  /**
   * Reschedule when dirty status changes (to adjust interval)
   */
  useEffect(() => {
    scheduleNextPoll();
  }, [hasDirtyWorktree, scheduleNextPoll]);
}
