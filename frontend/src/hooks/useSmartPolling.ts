import { useEffect, useRef, useCallback, useState } from "react";

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

interface SmartPollingState {
  /** Current polling interval in ms */
  interval: number;
  /** Time of last scan */
  lastScanTime: number;
  /** Time of next scheduled scan */
  nextScanTime: number | null;
  /** Whether currently scanning */
  isScanning: boolean;
}

/**
 * Polling intervals in milliseconds
 */
export const INTERVALS = {
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
}: SmartPollingOptions): SmartPollingState {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<SmartPollingState>({
    interval: INTERVALS.ACTIVE_CLEAN,
    lastScanTime: 0,
    nextScanTime: null,
    isScanning: false,
  });

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
      setState(prev => ({ ...prev, nextScanTime: null }));
      return;
    }

    const interval = getInterval();
    const nextScanTime = Date.now() + interval;
    setState(prev => ({ ...prev, interval, nextScanTime }));

    timerRef.current = setTimeout(() => {
      // Don't scan if we're editing
      if (isEditingEdge) {
        scheduleNextPoll();
        return;
      }

      // Trigger scan
      const now = Date.now();
      setState(prev => ({ ...prev, lastScanTime: now, isScanning: true }));
      onTriggerScan(localPath);

      // Schedule next
      scheduleNextPoll();
    }, interval);
  }, [enabled, localPath, isEditingEdge, getInterval, onTriggerScan]);

  /**
   * Mark scan as complete (call this from parent when scan finishes)
   */
  useEffect(() => {
    // This will be handled by the parent component listening to scan.updated
  }, []);

  /**
   * Handle visibility change - reschedule with appropriate interval
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Window became visible - check if we should scan immediately
        const timeSinceLastScan = Date.now() - state.lastScanTime;
        const interval = getInterval();

        if (timeSinceLastScan >= interval && localPath && !isEditingEdge) {
          // It's been long enough, scan now
          const now = Date.now();
          setState(prev => ({ ...prev, lastScanTime: now, isScanning: true }));
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
  }, [getInterval, localPath, isEditingEdge, onTriggerScan, scheduleNextPoll, state.lastScanTime]);

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
      setState(prev => ({ ...prev, nextScanTime: null }));
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

  return state;
}
