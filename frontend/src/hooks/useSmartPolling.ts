import { useEffect, useRef, useCallback, useState } from "react";

// Debug mode helper
function isDebugMode(): boolean {
  return localStorage.getItem("vibe-tree-debug-mode") === "true";
}

interface SmartPollingOptions {
  /** Local path of the repository */
  localPath: string | null;
  /** Whether the user is editing edges */
  isEditingEdge: boolean;
  /** Whether any worktree is dirty */
  hasDirtyWorktree: boolean;
  /** Whether any PR has pending CI */
  hasPendingCI?: boolean;
  /** Callback to trigger a scan */
  onTriggerScan: (localPath: string) => void;
  /** Whether polling is enabled */
  enabled?: boolean;
}

type PollingMode = "burst" | "dirty" | "ci_pending" | "active" | "idle" | "super_idle" | "hidden" | "debug";

interface SmartPollingState {
  /** Current polling interval in ms */
  interval: number;
  /** Current polling mode */
  mode: PollingMode;
  /** Time of last scan */
  lastScanTime: number;
  /** Time of next scheduled scan */
  nextScanTime: number | null;
  /** Whether currently scanning */
  isScanning: boolean;
}

interface SmartPollingControls {
  /** Trigger burst mode (faster polling for next few scans) */
  triggerBurst: () => void;
  /** Mark that a change was detected */
  markChange: () => void;
  /** Notify that scan has completed - starts countdown for next scan */
  notifyScanComplete: () => void;
  /** Trigger an immediate scan (for initial load) */
  triggerImmediateScan: () => void;
}

/**
 * Polling intervals in milliseconds
 */
export const INTERVALS = {
  /** Burst mode: after PR update detected */
  BURST: 15 * 1000, // 15s
  /** Active window + dirty worktree */
  ACTIVE_DIRTY: 30 * 1000, // 30s
  /** Active window + pending CI */
  CI_PENDING: 60 * 1000, // 1min
  /** Active window + clean: moderate updates */
  ACTIVE_CLEAN: 60 * 1000, // 60s
  /** Idle tier 1: 5min without changes */
  IDLE_1: 3 * 60 * 1000, // 3min
  /** Idle tier 2: 10min without changes */
  IDLE_2: 5 * 60 * 1000, // 5min
  /** Hidden/inactive window: infrequent updates */
  HIDDEN: 5 * 60 * 1000, // 5min
  /** Debug mode: fast polling */
  DEBUG: 10 * 1000, // 10s
} as const;

/** CI Pending timeout: after 10min, fall back to idle */
const CI_PENDING_TIMEOUT = 10 * 60 * 1000;

/** Initial pause at 0% before countdown bar starts moving */
export const COUNTDOWN_INITIAL_PAUSE = 1000; // 1s

/** Delay at 100% before scan actually starts */
export const SCAN_START_DELAY = 1000; // 1s pause at 100%

/**
 * Smart polling hook that adjusts polling frequency based on:
 * - Window visibility (active vs hidden)
 * - Edit mode (pause during edge editing)
 * - Dirty worktree status (more frequent when changes detected)
 * - Burst mode (faster polling after PR updates)
 * - Idle time (slower polling when no changes detected)
 */
export function useSmartPolling({
  localPath,
  isEditingEdge,
  hasDirtyWorktree,
  hasPendingCI = false,
  onTriggerScan,
  enabled = true,
}: SmartPollingOptions): SmartPollingState & SmartPollingControls {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<SmartPollingState>({
    interval: INTERVALS.ACTIVE_CLEAN,
    mode: "active",
    lastScanTime: 0,
    nextScanTime: null,
    isScanning: false,
  });

  // Dynamic polling state
  const [burstCount, setBurstCount] = useState(0); // Remaining burst polls
  const [lastChangeTime, setLastChangeTime] = useState(Date.now());
  const [ciPendingStartTime, setCiPendingStartTime] = useState<number | null>(null);

  // Track CI Pending start time
  useEffect(() => {
    if (hasPendingCI && ciPendingStartTime === null) {
      setCiPendingStartTime(Date.now());
    } else if (!hasPendingCI && ciPendingStartTime !== null) {
      setCiPendingStartTime(null);
    }
  }, [hasPendingCI, ciPendingStartTime]);

  /**
   * Trigger burst mode (faster polling for next 3 scans)
   */
  const triggerBurst = useCallback(() => {
    setBurstCount(3);
  }, []);

  /**
   * Mark that a change was detected (reset idle timer)
   */
  const markChange = useCallback(() => {
    setLastChangeTime(Date.now());
  }, []);

  /**
   * Track if we're waiting for scan to complete
   */
  const waitingForScanRef = useRef(false);

  /**
   * Calculate the appropriate polling interval and mode based on current state
   */
  const getIntervalAndMode = useCallback((): { interval: number; mode: PollingMode } => {
    // Debug mode = always 10s
    if (isDebugMode()) {
      return { interval: INTERVALS.DEBUG, mode: "debug" };
    }

    // Document hidden = long interval
    if (document.visibilityState === "hidden") {
      return { interval: INTERVALS.HIDDEN, mode: "hidden" };
    }

    // Burst mode = fast polling
    if (burstCount > 0) {
      return { interval: INTERVALS.BURST, mode: "burst" };
    }

    // Active + dirty worktree = short interval
    if (hasDirtyWorktree) {
      return { interval: INTERVALS.ACTIVE_DIRTY, mode: "dirty" };
    }

    // Active + pending CI = 1min interval (but timeout after 10min)
    if (hasPendingCI) {
      const ciPendingDuration = ciPendingStartTime ? Date.now() - ciPendingStartTime : 0;
      if (ciPendingDuration < CI_PENDING_TIMEOUT) {
        return { interval: INTERVALS.CI_PENDING, mode: "ci_pending" };
      }
      // CI Pending for too long, fall through to idle check
    }

    // Check idle time
    const idleTime = Date.now() - lastChangeTime;
    if (idleTime > 10 * 60 * 1000) {
      // 10min without changes
      return { interval: INTERVALS.IDLE_2, mode: "super_idle" };
    }
    if (idleTime > 5 * 60 * 1000) {
      // 5min without changes
      return { interval: INTERVALS.IDLE_1, mode: "idle" };
    }

    // Active + clean = moderate interval
    return { interval: INTERVALS.ACTIVE_CLEAN, mode: "active" };
  }, [burstCount, hasDirtyWorktree, hasPendingCI, lastChangeTime, ciPendingStartTime]);

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

    const { interval, mode } = getIntervalAndMode();
    // Total time until scan = initial pause + countdown interval + delay at 100%
    const totalTime = COUNTDOWN_INITIAL_PAUSE + interval + SCAN_START_DELAY;
    const nextScanTime = Date.now() + totalTime;
    setState(prev => ({ ...prev, interval, mode, nextScanTime }));

    timerRef.current = setTimeout(() => {
      // Don't scan if we're editing
      if (isEditingEdge) {
        scheduleNextPoll();
        return;
      }

      // Trigger scan
      const now = Date.now();
      waitingForScanRef.current = true;
      setState(prev => ({ ...prev, lastScanTime: now, isScanning: true, nextScanTime: null }));
      onTriggerScan(localPath);

      // Decrement burst count if in burst mode
      if (burstCount > 0) {
        setBurstCount(prev => prev - 1);
      }

      // Note: next poll will be scheduled when notifyScanComplete is called
    }, totalTime);
  }, [enabled, localPath, isEditingEdge, getIntervalAndMode, onTriggerScan, burstCount]);

  /**
   * Notify that scan has completed - schedule next poll
   */
  const notifyScanComplete = useCallback(() => {
    if (!waitingForScanRef.current) return;
    waitingForScanRef.current = false;
    setState(prev => ({ ...prev, isScanning: false }));
    scheduleNextPoll();
  }, [scheduleNextPoll]);

  /**
   * Trigger an immediate scan (for initial load)
   * This properly sets up the polling state so notifyScanComplete works correctly
   */
  const triggerImmediateScan = useCallback(() => {
    if (!localPath || waitingForScanRef.current) return;

    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Set state to scanning
    const now = Date.now();
    waitingForScanRef.current = true;
    setState(prev => ({ ...prev, lastScanTime: now, isScanning: true, nextScanTime: null }));
    onTriggerScan(localPath);
  }, [localPath, onTriggerScan]);

  /**
   * Handle visibility change - reschedule with appropriate interval
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Window became visible - check if we should scan immediately
        const timeSinceLastScan = Date.now() - state.lastScanTime;
        const { interval } = getIntervalAndMode();

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
  }, [getIntervalAndMode, localPath, isEditingEdge, onTriggerScan, scheduleNextPoll, state.lastScanTime]);

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
   * Reschedule when dirty status or burst count changes
   */
  useEffect(() => {
    scheduleNextPoll();
  }, [hasDirtyWorktree, hasPendingCI, burstCount, scheduleNextPoll]);

  return { ...state, triggerBurst, markChange, notifyScanComplete, triggerImmediateScan };
}
