import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFolder, faGear } from "@fortawesome/free-solid-svg-icons";
import {
  api,
  type Plan,
  type ScanSnapshot,
  type TreeNode,
  type RepoPin,
  type TreeSpecNode,
  type TreeSpecEdge,
  type TaskStatus,
  type TreeSpecStatus,
  type BranchNamingRule,
  type TaskInstruction,
  type BranchLink,
  type RepoCollaborator,
  type RepoTeam,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import { diff, formatDiffSummary } from "../lib/scanDiff";
import {
  mergeNodeAttributes,
  mergeNodeAttributesWithTimestamps,
  createInferredEdgesForNewBranches,
  analyzeChanges,
  formatPendingChangesSummary,
  type PendingChanges,
  type NodeFieldTimestamps,
} from "../lib/snapshotMerge";
import BranchGraph, { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "../components/BranchGraph";
import { ScanUpdateToast } from "../components/ScanUpdateToast";
import { TerminalPanel } from "../components/TerminalPanel";
import { TaskCard } from "../components/TaskCard";
import { DraggableTask, DroppableTreeNode } from "../components/DndComponents";
import { PlanningPanel } from "../components/PlanningPanel";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import MultiSelectPanel from "../components/MultiSelectPanel";
import { useSmartPolling, INTERVALS, COUNTDOWN_INITIAL_PAUSE } from "../hooks/useSmartPolling";
import { LabelChip, UserChip, TeamChip, ReviewBadge, CIBadge } from "../components/atoms/Chips";
import type { PlanningSession, TaskNode, TaskEdge } from "../lib/api";

// Scan progress bar component
type PollingMode = "burst" | "dirty" | "ci_pending" | "active" | "idle" | "super_idle" | "hidden" | "debug";

const MODE_LABELS: Record<PollingMode, { label: string; color: string }> = {
  burst: { label: "Burst", color: "#f59e0b" },
  dirty: { label: "Dirty", color: "#ef4444" },
  ci_pending: { label: "CI Pending", color: "#eab308" },
  active: { label: "Active", color: "#22c55e" },
  idle: { label: "Idle", color: "#6b7280" },
  super_idle: { label: "Super Idle", color: "#4b5563" },
  hidden: { label: "Hidden", color: "#374151" },
  debug: { label: "Debug", color: "#a855f7" },
};

interface ScanProgress {
  current: number;
  total: number;
  stage: string;
  prProgress?: { current: number; total: number };
}

// Stage display names
const STAGE_LABELS: Record<string, string> = {
  edges_cached: "Loading cache...",
  worktrees: "Checking worktrees...",
  tree: "Building tree...",
  aheadBehind: "Calculating commits...",
  remoteAheadBehind: "Checking remote...",
  final: "Finalizing...",
  pr_refreshing: "Refreshing PRs...",
  pr_refreshed: "Complete!",
  complete: "Complete!",
};

// Display state: "scanning" when we have progress, "countdown" when we have nextScanTime
type DisplayState = "scanning" | "countdown" | "idle";

function ScanProgressBar({ nextScanTime, interval, mode, scanProgress, isPollingScanning, isInitialLoad, onTriggerScan }: {
  nextScanTime: number;
  interval: number;
  mode: PollingMode;
  scanProgress: ScanProgress | null;
  isPollingScanning: boolean; // true when scan triggered but no progress yet
  isInitialLoad: boolean; // true until first scan completes
  onTriggerScan?: () => void;
}) {
  const modeInfo = MODE_LABELS[mode];

  // Single source of truth: calculate progress and time from current time
  const [now, setNow] = useState(Date.now());

  // Update time every 100ms for smooth progress bar
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  // Determine display state:
  // - "scanning" if we have progress data OR if scan is triggered (show 0%) OR on initial load
  // - "countdown" if we have nextScanTime and not scanning
  // - "idle" otherwise
  const isScanning = scanProgress !== null || isPollingScanning || isInitialLoad;
  const displayState: DisplayState = isScanning ? "scanning" : nextScanTime ? "countdown" : "idle";

  // Track visual countdown start time (when UI actually starts showing countdown)
  const [countdownVisualStartTime, setCountdownVisualStartTime] = useState<number | null>(null);

  useEffect(() => {
    if (displayState === "countdown") {
      // Record when we actually started showing the countdown
      setCountdownVisualStartTime(Date.now());
    } else {
      setCountdownVisualStartTime(null);
    }
  }, [displayState]);

  // Visual countdown with initial pause at 0%
  const timeSinceCountdownStart = countdownVisualStartTime ? Math.max(0, now - countdownVisualStartTime) : 0;
  const isInInitialPause = timeSinceCountdownStart < COUNTDOWN_INITIAL_PAUSE;

  let countdownPercent: number;
  let secondsLeft: number;

  if (isInInitialPause) {
    // During initial pause: stay at 0%
    countdownPercent = 0;
    secondsLeft = Math.ceil(interval / 1000);
  } else {
    // After pause: progress from 0% to 100%
    const timeSincePauseEnded = timeSinceCountdownStart - COUNTDOWN_INITIAL_PAUSE;
    countdownPercent = interval > 0 ? Math.min(100, (timeSincePauseEnded / interval) * 100) : 0;
    const visualTimeRemaining = Math.max(0, interval - timeSincePauseEnded);
    secondsLeft = Math.ceil(visualTimeRemaining / 1000);
  }

  // Calculate scan progress percentage (0% if no progress yet)
  // If we have prProgress, interpolate within the PR refresh step (7/8 to 8/8)
  const basePercent = scanProgress ? (scanProgress.current / scanProgress.total) * 100 : 0;
  const prProgress = scanProgress?.prProgress;
  const scanPercent = prProgress
    ? Math.round(basePercent + (prProgress.current / prProgress.total) * (100 / (scanProgress?.total ?? 8)))
    : Math.round(basePercent);
  const scanTotal = scanProgress?.total ?? 8; // Default to 8 steps
  const stageLabel = scanProgress?.stage ? (STAGE_LABELS[scanProgress.stage] ?? scanProgress.stage) : "Starting...";

  const formatInterval = (ms: number) => {
    if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 1000)}s`;
  };

  return (
    <div style={{ padding: "4px 8px", marginTop: 8 }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 10,
        color: "#6b7280",
        marginBottom: 2,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {onTriggerScan && displayState === "countdown" && (
            <button
              onClick={onTriggerScan}
              title="Scan now"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "#6b7280",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ↻
            </button>
          )}
          {displayState === "scanning" ? stageLabel : "Next scan"}
          {displayState === "countdown" && (
            <span style={{
              background: modeInfo.color,
              color: "#fff",
              padding: "1px 4px",
              borderRadius: 3,
              fontSize: 9,
            }}>
              {modeInfo.label}
            </span>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {displayState === "scanning" ? (
            <span>
              {scanPercent}% ({scanProgress?.current ?? 0}/{scanTotal})
              {prProgress && ` PR ${prProgress.current}/${prProgress.total}`}
            </span>
          ) : displayState === "countdown" ? (
            <span>{secondsLeft}s ({formatInterval(interval)})</span>
          ) : null}
        </span>
      </div>
      <div style={{
        height: 3,
        background: "#374151",
        borderRadius: 2,
        overflow: "hidden",
      }}>
        {displayState === "scanning" ? (
          <div style={{
            height: "100%",
            width: "100%",
            background: "#60a5fa",
            transform: `scaleX(${scanPercent / 100})`,
            transformOrigin: "left",
            transition: "transform 0.3s ease-out",
            willChange: "transform",
          }} />
        ) : displayState === "countdown" ? (
          <div style={{
            height: "100%",
            width: "100%",
            background: modeInfo.color,
            transform: `scaleX(${countdownPercent / 100})`,
            transformOrigin: "left",
            transition: "transform 0.1s linear",
            willChange: "transform",
          }} />
        ) : null}
      </div>
    </div>
  );
}

export default function TreeDashboard() {
  const { pinId: urlPinId, sessionId: urlSessionId } = useParams<{ pinId?: string; sessionId?: string }>();
  const navigate = useNavigate();

  // Repo pins state
  const [repoPins, setRepoPins] = useState<RepoPin[]>([]);
  const [newLocalPath, setNewLocalPath] = useState("");
  const [showAddNew, setShowAddNew] = useState(false);
  const [deletingPinId, setDeletingPinId] = useState<number | null>(null);

  // Pending worktree move (for confirmation modal)
  const [pendingWorktreeMove, setPendingWorktreeMove] = useState<{
    worktreePath: string;
    fromBranch: string;
    toBranch: string;
  } | null>(null);

  // Selected pin derived from URL
  const selectedPinId = urlPinId ? parseInt(urlPinId, 10) : null;

  // Main state
  const [plan, setPlan] = useState<Plan | null>(null);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  // Multi-select state: stores selected branch names
  const [selectedBranches, setSelectedBranches] = useState<Set<string>>(new Set());
  // Selection anchor for Shift+click range selection
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive selectedNode from selectedBranches (single selection only)
  const selectedNode = useMemo(() => {
    if (selectedBranches.size === 1) {
      const [branchName] = selectedBranches;
      return snapshot?.nodes.find((n) => n.branchName === branchName) ?? null;
    }
    return null;
  }, [selectedBranches, snapshot?.nodes]);

  // Keep snapshotRef in sync with snapshot state (for use in WebSocket callbacks)
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // Track if selected branch has been restored from localStorage
  const restoredSelectedBranch = useRef(false);

  // Restore selected branch from localStorage when snapshot loads
  useEffect(() => {
    if (!snapshot || !selectedPinId || restoredSelectedBranch.current) return;
    restoredSelectedBranch.current = true;
    const savedBranch = localStorage.getItem(`vibe-tree-selected-branch-${selectedPinId}`);
    if (savedBranch) {
      const node = snapshot.nodes.find(n => n.branchName === savedBranch);
      if (node) {
        setSelectedBranches(new Set([savedBranch]));
        setSelectionAnchor(savedBranch);
      }
    }
  }, [snapshot, selectedPinId]);

  // Reset restoration flag when pin changes
  useEffect(() => {
    restoredSelectedBranch.current = false;
  }, [selectedPinId]);

  // Save selected branch to localStorage when user selects (not on initial restore)
  useEffect(() => {
    if (!selectedPinId || !restoredSelectedBranch.current) return;
    if (selectedNode) {
      localStorage.setItem(`vibe-tree-selected-branch-${selectedPinId}`, selectedNode.branchName);
    } else {
      localStorage.removeItem(`vibe-tree-selected-branch-${selectedPinId}`);
    }
  }, [selectedPinId, selectedNode?.branchName]);

  // Instruction cache: branchName -> TaskInstruction
  const [instructionCache, setInstructionCache] = useState<Map<string, TaskInstruction>>(new Map());
  const [currentInstruction, setCurrentInstruction] = useState<TaskInstruction | null>(null);
  const [instructionLoading, setInstructionLoading] = useState(false);

  // Branch links (single source of truth for PR info)
  const [branchLinks, setBranchLinks] = useState<Map<string, BranchLink[]>>(new Map());
  // Branch descriptions (git branch descriptions for labels)
  const [branchDescriptions, setBranchDescriptions] = useState<Map<string, string>>(new Map());
  // Branches currently refreshing their status (for loading UI)
  const [refreshingBranches, setRefreshingBranches] = useState<Set<string>>(new Set());
  // Field-level timestamps for conflict resolution with scan results
  const [fieldTimestamps, setFieldTimestamps] = useState<Map<string, NodeFieldTimestamps>>(new Map());
  // Scan start time for timestamp-based merge protection
  const scanStartTimeRef = useRef<number | null>(null);

  // Multi-session planning state (only store what's needed, not full session copy)
  const [selectedSessionBaseBranch, setSelectedSessionBaseBranch] = useState<string | null>(null);
  const [selectedSessionType, setSelectedSessionType] = useState<string | null>(null);
  const [tentativeNodes, setTentativeNodes] = useState<TaskNode[]>([]);
  const [tentativeEdges, setTentativeEdges] = useState<TaskEdge[]>([]);
  const [pendingPlanning, setPendingPlanning] = useState<{ branchName: string; instruction: string | null } | null>(null);

  // Terminal state
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalWorktreePath, setTerminalWorktreePath] = useState<string | null>(null);
  const [terminalTaskContext, setTerminalTaskContext] = useState<{ title: string; description?: string } | undefined>(undefined);
  const [terminalAutoRunClaude, setTerminalAutoRunClaude] = useState(false);


  // Tree Spec state (Task-based)
  const [wizardBaseBranch, setWizardBaseBranch] = useState<string>("main");
  const [wizardNodes, setWizardNodes] = useState<TreeSpecNode[]>([]);
  const [wizardEdges, setWizardEdges] = useState<TreeSpecEdge[]>([]);
  const [wizardStatus, setWizardStatus] = useState<TreeSpecStatus>("draft");

  // Branch graph edit mode
  const [branchGraphEditMode, setBranchGraphEditMode] = useState(false);
  // Flag to preserve local edges after saving (prevents scan from overwriting user's edits)
  const preserveLocalEdgesUntilRef = useRef<number>(0);

  // Chat fullscreen mode (persisted in localStorage)
  const [chatFullscreen, setChatFullscreen] = useState(() => {
    return localStorage.getItem("treeView.chatFullscreen") === "true";
  });
  useEffect(() => {
    localStorage.setItem("treeView.chatFullscreen", String(chatFullscreen));
  }, [chatFullscreen]);

  // Branch graph fullscreen mode (persisted in localStorage)
  const [graphFullscreen, setGraphFullscreen] = useState(() => {
    return localStorage.getItem("treeView.graphFullscreen") === "true";
  });
  useEffect(() => {
    localStorage.setItem("treeView.graphFullscreen", String(graphFullscreen));
  }, [graphFullscreen]);

  // Branch graph zoom (persisted in localStorage)
  const [graphZoom, setGraphZoom] = useState(() => {
    const saved = localStorage.getItem("branchGraph.zoom");
    return saved ? parseFloat(saved) : 1;
  });
  useEffect(() => {
    localStorage.setItem("branchGraph.zoom", String(graphZoom));
  }, [graphZoom]);

  // Focus separator index (persisted in localStorage)
  const [focusSeparatorIndex, setFocusSeparatorIndex] = useState<number | null>(() => {
    const saved = localStorage.getItem("branchGraph.focusSeparatorIndex");
    return saved ? parseInt(saved, 10) : null;
  });
  useEffect(() => {
    if (focusSeparatorIndex !== null) {
      localStorage.setItem("branchGraph.focusSeparatorIndex", String(focusSeparatorIndex));
    } else {
      localStorage.removeItem("branchGraph.focusSeparatorIndex");
    }
  }, [focusSeparatorIndex]);

  // Branch graph filter (persisted in localStorage)
  const [checkedBranches, setCheckedBranches] = useState<Set<string>>(() => {
    const saved = localStorage.getItem("branchGraph.checkedBranches");
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const [filterEnabled, setFilterEnabled] = useState(() => {
    return localStorage.getItem("branchGraph.filterEnabled") === "true";
  });
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  useEffect(() => {
    localStorage.setItem("branchGraph.checkedBranches", JSON.stringify([...checkedBranches]));
  }, [checkedBranches]);
  useEffect(() => {
    localStorage.setItem("branchGraph.filterEnabled", String(filterEnabled));
  }, [filterEnabled]);
  useEffect(() => {
    if (!showMoreMenu) return;
    const handleClickOutside = () => setShowMoreMenu(false);
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [showMoreMenu]);

  // Create branch dialog
  const [createBranchBase, setCreateBranchBase] = useState<string | null>(null);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createBranchLoading, setCreateBranchLoading] = useState(false);

  // Fetch state
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<string | null>(null);
  const [originalTreeSpecState, setOriginalTreeSpecState] = useState<{
    edges: TreeSpecEdge[];
    siblingOrder?: Record<string, string[]>;
  } | null>(null);

  // Smart update: pending changes that require user confirmation (unsafe changes)
  const [pendingChanges, setPendingChanges] = useState<PendingChanges | null>(null);
  const currentSnapshotVersion = useRef<number>(0);
  const snapshotRef = useRef<ScanSnapshot | null>(null);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const isScanningRef = useRef<boolean>(false);
  const lastScanCompleteTimeRef = useRef<number>(0);

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsRule, setSettingsRule] = useState<BranchNamingRule | null>(null);
  const [settingsPatterns, setSettingsPatterns] = useState<string[]>([]);
  const [settingsDefaultBranch, setSettingsDefaultBranch] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  // Worktree settings
  const [worktreeCreateScript, setWorktreeCreateScript] = useState("");
  const [worktreePostCreateScript, setWorktreePostCreateScript] = useState("");
  const [worktreePostDeleteScript, setWorktreePostDeleteScript] = useState("");
  // Polling settings
  const [pollingPrFetchCount, setPollingPrFetchCount] = useState(5);
  // Polling intervals (in seconds)
  const [pollingIntervals, setPollingIntervals] = useState<{
    burst: number;
    dirty: number;
    ciPending: number;
    active: number;
    idle: number;
    superIdle: number;
  } | null>(null);
  // Polling thresholds (in seconds)
  const [pollingThresholds, setPollingThresholds] = useState<{
    idle: number;
    superIdle: number;
    ciPendingTimeout: number;
  } | null>(null);
  // PR settings
  const [prQuickLabels, setPrQuickLabels] = useState<string[]>([]);
  const [prQuickReviewers, setPrQuickReviewers] = useState<string[]>([]);
  const [repoLabels, setRepoLabels] = useState<Array<{ name: string; color: string; description: string }>>([]);
  const [repoCollaborators, setRepoCollaborators] = useState<RepoCollaborator[]>([]);
  const [repoTeams, setRepoTeams] = useState<RepoTeam[]>([]);
  // PR settings search filters
  const [labelSearch, setLabelSearch] = useState("");
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [isSyncingCache, setIsSyncingCache] = useState(false);

  // Load PR settings when project is loaded
  useEffect(() => {
    if (!snapshot?.repoId) return;
    const loadPrSettings = async () => {
      try {
        // Check if sync is needed
        const syncStatus = await api.getRepoCacheSyncStatus(snapshot.repoId).catch(() => null);
        if (syncStatus?.needsSync) {
          // Sync in background
          api.syncRepoCache(snapshot.repoId).catch(console.error);
        }

        const [prSettings, labels, collaborators, teams] = await Promise.all([
          api.getPrSettings(snapshot.repoId),
          api.getRepoLabels(snapshot.repoId).catch(() => []),
          api.getRepoCollaborators(snapshot.repoId).catch(() => []),
          api.searchRepoTeams(snapshot.repoId).catch(() => []),
        ]);
        setPrQuickLabels(prSettings.quickLabels || []);
        setPrQuickReviewers(prSettings.quickReviewers || []);
        setRepoLabels(labels);
        setRepoCollaborators(collaborators);
        setRepoTeams(teams);
      } catch {
        // No settings yet, use defaults
        setPrQuickLabels([]);
        setPrQuickReviewers([]);
      }
    };
    loadPrSettings();
  }, [snapshot?.repoId]);

  // Settings modal category
  const [settingsCategory, setSettingsCategory] = useState<"branch" | "worktree" | "polling" | "pr-labels" | "pr-reviewers" | "cleanup" | "debug">("branch");
  const [debugModeEnabled, setDebugModeEnabled] = useState(() => localStorage.getItem("vibe-tree-debug-mode") === "true");
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ chatSessions: number; taskInstructions: number; branchLinks: number } | null>(null);

  // Warnings modal state
  const [showWarnings, setShowWarnings] = useState(false);
  const [warningFilter, setWarningFilter] = useState<string | null>(null);

  // Logs state
  type LogEntry = { id: number; timestamp: Date; type: string; message: string; html?: string; branch?: string; scanSessionId?: string };
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const addLog = useCallback((type: string, message: string, html?: string, branch?: string, scanSessionId?: string) => {
    const id = ++logIdRef.current;
    setLogs((prev) => [...prev.slice(-99), { id, timestamp: new Date(), type, message, html, branch, scanSessionId }]);
  }, []);
  // Expanded scan session IDs for grouping
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  // Manually toggled sessions (dirty flag) - these won't be auto-opened/closed
  const [manuallyToggledSessions, setManuallyToggledSessions] = useState<Set<string>>(new Set());

  // Hovered log branch (for graph highlight) and hovered log id (for single log highlight)
  const [hoveredLogBranch, setHoveredLogBranch] = useState<string | null>(null);
  const [hoveredLogId, setHoveredLogId] = useState<number | null>(null);

  // LocalStorage key for log accordion state
  const getLogAccordionKey = (repoId: string) => `vibe-tree-log-accordion-${repoId}`;

  // Load/save accordion state from LocalStorage
  const loadAccordionState = (repoId: string): { expanded: Set<string>; manuallyToggled: Set<string> } => {
    try {
      const stored = localStorage.getItem(getLogAccordionKey(repoId));
      if (stored) {
        const data = JSON.parse(stored);
        return {
          expanded: new Set(data.expanded || []),
          manuallyToggled: new Set(data.manuallyToggled || []),
        };
      }
    } catch { /* ignore */ }
    return { expanded: new Set(), manuallyToggled: new Set() };
  };

  const saveAccordionState = (repoId: string, expanded: Set<string>, manuallyToggled: Set<string>, validSessionIds: Set<string>) => {
    try {
      // Only save sessions that still exist (cleanup old entries)
      const filteredExpanded = [...expanded].filter(id => validSessionIds.has(id));
      const filteredManuallyToggled = [...manuallyToggled].filter(id => validSessionIds.has(id));
      localStorage.setItem(getLogAccordionKey(repoId), JSON.stringify({
        expanded: filteredExpanded,
        manuallyToggled: filteredManuallyToggled,
      }));
    } catch { /* ignore */ }
  };

  // Load logs from DB when project changes, clear on project switch
  useEffect(() => {
    setLogs([]); // Clear logs when project changes
    setExpandedSessions(new Set()); // Clear expanded sessions
    setManuallyToggledSessions(new Set()); // Clear manually toggled
    logIdRef.current = 0;
    if (!snapshot?.repoId) return;

    api.getScanLogs(snapshot.repoId, 50).then((result) => {
      const dbLogs = result.logs.map((log) => ({
        id: log.id,
        timestamp: new Date(log.createdAt),
        type: log.logType,
        message: log.message,
        html: log.html || undefined,
        branch: log.branchName || undefined,
        scanSessionId: log.scanSessionId || undefined,
      }));
      setLogs(dbLogs.reverse()); // DB returns newest first, we want oldest first
      logIdRef.current = Math.max(0, ...dbLogs.map(l => l.id));

      // Get all scan session IDs (exclude manual logs which have no scanSessionId)
      const allScanSessionIds = [...new Set(result.logs.map(l => l.scanSessionId).filter(Boolean))] as string[];
      const validSessionIds = new Set(allScanSessionIds);

      // Load saved state from LocalStorage
      const savedState = loadAccordionState(snapshot.repoId);

      // Apply saved manuallyToggled state
      const restoredManuallyToggled = new Set([...savedState.manuallyToggled].filter(id => validSessionIds.has(id)));
      setManuallyToggledSessions(restoredManuallyToggled);

      // Calculate which sessions should be expanded:
      // - For manuallyToggled sessions: use saved expanded state
      // - For non-manuallyToggled sessions: auto-expand top 3 scan sessions
      const top3Sessions = new Set(allScanSessionIds.slice(0, 3));
      const newExpanded = new Set<string>();

      for (const sessionId of allScanSessionIds) {
        if (restoredManuallyToggled.has(sessionId)) {
          // Use saved state for manually toggled sessions
          if (savedState.expanded.has(sessionId)) {
            newExpanded.add(sessionId);
          }
        } else {
          // Auto-expand top 3 for non-manually-toggled sessions
          if (top3Sessions.has(sessionId)) {
            newExpanded.add(sessionId);
          }
        }
      }

      setExpandedSessions(newExpanded);
    }).catch(console.error);
  }, [snapshot?.repoId]);

  // Next scan countdown
  const [nextScanIn, setNextScanIn] = useState<number | null>(null);
  // Scan progress state (null when not scanning)
  // We use a queue to display progress with minimum delays between steps
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const progressQueueRef = useRef<ScanProgress[]>([]);
  const processingQueueRef = useRef(false);
  // Track if first scan has completed (for initial load state)
  const [hasCompletedFirstScan, setHasCompletedFirstScan] = useState(false);

  // Process progress queue with minimum delay between steps
  const processProgressQueue = useCallback(() => {
    if (processingQueueRef.current || progressQueueRef.current.length === 0) return;

    processingQueueRef.current = true;
    const next = progressQueueRef.current.shift()!;
    setScanProgress(next);

    // Determine delay: longer for 100%, moderate for others
    const isComplete = next.current === next.total;
    const delay = isComplete ? 1500 : 600; // 1.5s for 100%, 0.6s for others

    setTimeout(() => {
      processingQueueRef.current = false;
      processProgressQueue();
    }, delay);
  }, []);

  // Queue a progress update
  const queueProgressUpdate = useCallback((progress: ScanProgress | null) => {
    if (progress === null) {
      // Clear queue and progress
      progressQueueRef.current = [];
      processingQueueRef.current = false;
      setScanProgress(null);
    } else {
      progressQueueRef.current.push(progress);
      processProgressQueue();
    }
  }, [processProgressQueue]);

  // Bottom panel resize state (persisted in localStorage)
  const DEFAULT_BOTTOM_HEIGHT = 500;
  const MIN_BOTTOM_HEIGHT = 350;
  const MAX_BOTTOM_HEIGHT = 800;
  const [bottomHeight, setBottomHeight] = useState(() => {
    const saved = localStorage.getItem("treeView.bottomHeight");
    return saved ? parseInt(saved, 10) : DEFAULT_BOTTOM_HEIGHT;
  });
  useEffect(() => {
    localStorage.setItem("treeView.bottomHeight", String(bottomHeight));
  }, [bottomHeight]);
  const [isResizingBottom, setIsResizingBottom] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  // D&D sensors (reserved for future drag-and-drop)
  void useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Load repo pins on mount
  useEffect(() => {
    api.getRepoPins().then((pins) => {
      setRepoPins(pins);
      // Don't auto-select - show project list first
    }).catch(console.error);
  }, []);

  // Get selected pin
  const selectedPin = repoPins.find((p) => p.id === selectedPinId) ?? null;

  // Load cached snapshot immediately, then start background scan
  const loadSnapshot = useCallback(async (pinId: number, localPath: string) => {
    setError(null);
    setPendingChanges(null); // Clear any pending changes
    try {
      // Immediately load cached snapshot from DB (fast)
      const { snapshot: cachedSnapshot, version } = await api.getSnapshot(pinId);
      setSnapshot(cachedSnapshot);
      currentSnapshotVersion.current = version; // Set version from DB
      setLoading(false);

      // Note: Background scan is triggered by the caller after loadSnapshot completes
      // This ensures proper coordination with the polling hook
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }, []);

  // Apply pending changes (user explicitly clicks "Apply")
  // Fetches from DB (SSOT) instead of using cached payload
  const applyPendingChanges = useCallback(async () => {
    if (!pendingChanges || !selectedPinId) return;

    // If in edit mode, require confirmation
    if (branchGraphEditMode) {
      const confirmed = window.confirm(
        "You are in edit mode. Applying this update may change the graph layout. " +
        "Your edits are saved in the database and won't be lost. Apply update?"
      );
      if (!confirmed) return;
    }

    setIsApplyingUpdate(true);
    try {
      // Fetch from DB (SSOT) instead of using cached payload
      const { snapshot: freshSnapshot, version } = await api.getSnapshot(selectedPinId);
      setSnapshot(freshSnapshot);
      currentSnapshotVersion.current = version;
      setPendingChanges(null);
    } catch (err) {
      console.error("[TreeDashboard] Failed to apply update:", err);
    } finally {
      setIsApplyingUpdate(false);
    }
  }, [pendingChanges, selectedPinId, branchGraphEditMode]);

  // Dismiss pending changes notification
  const dismissPendingChanges = useCallback(() => {
    setPendingChanges(null);
  }, []);

  // Auto-apply pending changes when exiting edit mode
  const prevEditModeRef = useRef(branchGraphEditMode);
  useEffect(() => {
    const wasEditing = prevEditModeRef.current;
    prevEditModeRef.current = branchGraphEditMode;

    // If we just exited edit mode and have pending changes, auto-apply
    if (wasEditing && !branchGraphEditMode && pendingChanges && selectedPinId) {
      (async () => {
        try {
          const { snapshot: freshSnapshot, version } = await api.getSnapshot(selectedPinId);
          setSnapshot(freshSnapshot);
          currentSnapshotVersion.current = version;
          setPendingChanges(null);
        } catch (err) {
          console.error("[TreeDashboard] Failed to auto-apply pending changes:", err);
        }
      })();
    }
  }, [branchGraphEditMode, pendingChanges, selectedPinId]);

  // Trigger background scan without loading state (with debounce protection)
  // Note: isScanningRef is only cleared when WebSocket sends isComplete: true
  const triggerScan = useCallback((localPath: string) => {
    if (isScanningRef.current) return;
    isScanningRef.current = true;
    // Record scan start time for timestamp-based merge protection
    scanStartTimeRef.current = Date.now();
    api.startScan(localPath).catch((err) => {
      console.warn("[TreeDashboard] Background scan failed:", err);
      isScanningRef.current = false; // Only reset on error
      scanStartTimeRef.current = null;
    });
    // Note: isScanningRef is cleared in WebSocket handler when isComplete is received
  }, []);

  const handleFetch = useCallback(async (localPath: string) => {
    if (!localPath) return;
    // Still do the fetch even if scan is in progress, just skip the scan
    setFetching(true);
    setError(null);
    try {
      await api.fetch(localPath);
      // Trigger background scan after fetch (with guard)
      if (!isScanningRef.current) {
        isScanningRef.current = true;
        api.startScan(localPath).catch((err) => {
          console.warn("[Fetch] Scan failed:", err);
          isScanningRef.current = false;
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFetching(false);
    }
  }, []);

  // Smart polling: auto-refresh based on activity and visibility
  const hasDirtyWorktree = snapshot?.worktrees.some((w) => w.dirty) ?? false;
  const hasPendingCI = snapshot?.nodes.some((n) => n.pr?.checks === "PENDING") ?? false;
  const { triggerBurst, markChange, notifyScanComplete, triggerImmediateScan, ...pollingState } = useSmartPolling({
    localPath: selectedPin?.localPath ?? null,
    isEditingEdge: branchGraphEditMode,
    hasDirtyWorktree,
    hasPendingCI,
    onTriggerScan: triggerScan,
    enabled: !!snapshot, // Only poll when we have a snapshot
    customIntervals: pollingIntervals || undefined,
    customThresholds: pollingThresholds || undefined,
  });

  // Ref for notifyScanComplete to avoid dependency issues in useEffect
  const notifyScanCompleteRef = useRef(notifyScanComplete);
  useEffect(() => {
    notifyScanCompleteRef.current = notifyScanComplete;
  }, [notifyScanComplete]);

  // Auto-load when pin is selected
  useEffect(() => {
    if (selectedPin && !snapshot) {
      setLoading(true);
      setHasCompletedFirstScan(false); // Reset on project change
      loadSnapshot(selectedPin.id, selectedPin.localPath);
    }
  }, [selectedPin?.id, loadSnapshot]);

  // Trigger immediate scan when snapshot is first loaded (to refresh from cache)
  const hasTriggeredInitialScan = useRef(false);
  useEffect(() => {
    if (snapshot && !hasTriggeredInitialScan.current) {
      hasTriggeredInitialScan.current = true;
      // Small delay to ensure polling hook is ready
      setTimeout(() => {
        triggerImmediateScan();
      }, 100);
    }
  }, [snapshot, triggerImmediateScan]);

  // Reset initial scan flag when project changes
  useEffect(() => {
    hasTriggeredInitialScan.current = false;
  }, [selectedPin?.id]);

  // Sync selectedBranches with snapshot data (remove deleted branches)
  useEffect(() => {
    if (selectedBranches.size > 0 && snapshot) {
      const validBranches = new Set(snapshot.nodes.map(n => n.branchName));
      const filtered = new Set([...selectedBranches].filter(b => validBranches.has(b)));
      if (filtered.size !== selectedBranches.size) {
        setSelectedBranches(filtered);
        if (selectionAnchor && !filtered.has(selectionAnchor)) {
          setSelectionAnchor(null);
        }
      }
    }
  }, [snapshot, selectedBranches, selectionAnchor]);

  // Escape key to clear selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedBranches.size > 0) {
        // Don't deselect if user is typing in an input/textarea
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
          return;
        }
        setSelectedBranches(new Set());
        setSelectionAnchor(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedBranches.size]);

  // Load instruction when selectedNode changes (with caching)
  useEffect(() => {
    if (!snapshot?.repoId || !selectedNode) {
      setCurrentInstruction(null);
      return;
    }

    const branchName = selectedNode.branchName;

    // Check cache first
    const cached = instructionCache.get(branchName);
    if (cached) {
      setCurrentInstruction(cached);
      setInstructionLoading(false);
      return;
    }

    // Not in cache, fetch from API
    setInstructionLoading(true);
    api.getTaskInstruction(snapshot.repoId, branchName)
      .then((instr) => {
        setInstructionCache((prev) => new Map(prev).set(branchName, instr));
        setCurrentInstruction(instr);
      })
      .catch((err) => {
        console.error("Failed to load instruction:", err);
        // Set empty instruction on error
        const emptyInstr: TaskInstruction = {
          id: null,
          repoId: snapshot.repoId,
          taskId: null,
          branchName,
          instructionMd: "",
          confirmationStatus: "unconfirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setCurrentInstruction(emptyInstr);
      })
      .finally(() => {
        setInstructionLoading(false);
      });
  }, [snapshot?.repoId, selectedNode?.branchName, instructionCache]);

  // Load plan and connect WS when snapshot is available
  useEffect(() => {
    if (!snapshot?.repoId) return;

    api.getCurrentPlan(snapshot.repoId).then(setPlan).catch(console.error);
    wsClient.connect(snapshot.repoId);

    const unsubScan = wsClient.on("scan.updated", (msg) => {
      // Smart update: auto-merge safe changes, queue unsafe changes for user confirmation
      if (!msg.data || typeof msg.data !== "object") return;

      const data = msg.data as {
        version?: number;
        stage?: string;
        isFinal?: boolean;
        isComplete?: boolean;
        progress?: { current: number; total: number };
        snapshot?: ScanSnapshot;
        repoId?: string;
      };

      // Track scan progress with queuing for smooth display
      if (data.progress && data.stage) {
        // Queue progress update (will be displayed with minimum delays)
        queueProgressUpdate({ current: data.progress.current, total: data.progress.total, stage: data.stage });

        if (data.isComplete) {
          // Mark first scan as completed (for initial load state)
          setHasCompletedFirstScan(true);
          // Scan fully complete - clear after queue is processed (with extra delay for 100%)
          // The queue processing adds 1.5s delay for 100%, so we wait for that + buffer
          setTimeout(() => {
            queueProgressUpdate(null);
          }, 2000); // Wait for 100% display + buffer
        }
      }

      // Verify repoId matches to prevent cross-project updates
      const msgRepoId = data.snapshot?.repoId ?? data.repoId;
      if (msgRepoId && msgRepoId !== snapshotRef.current?.repoId) {
        return;
      }

      if (!data.snapshot) return;
      const newVersion = data.version ?? 0;

      // Skip if version is not newer (prevent out-of-order updates)
      if (newVersion < currentSnapshotVersion.current) {
        return;
      }

      // For intermediate updates (aheadBehind, remoteAheadBehind): auto-merge node attributes only
      if (!data.isFinal && (data.stage === "aheadBehind" || data.stage === "remoteAheadBehind")) {
        // Don't update during edit mode
        if (branchGraphEditMode) return;

        setSnapshot((prev) => {
          if (!prev) return prev;
          // Use timestamp-based merge to preserve newer local updates
          return mergeNodeAttributesWithTimestamps(
            prev,
            data.snapshot!,
            fieldTimestamps,
            scanStartTimeRef.current
          );
        });
        return;
      }

      // For final updates: analyze and handle safe vs unsafe changes
      if (data.isFinal) {
        const currentSnapshot = snapshotRef.current;
        if (!currentSnapshot) {
          setSnapshot(data.snapshot!);
          currentSnapshotVersion.current = newVersion;
          return;
        }
        const analysis = analyzeChanges(currentSnapshot, data.snapshot, newVersion);

        if (analysis.hasUnsafeChanges && analysis.pendingChanges) {
          if (branchGraphEditMode) {
            // Edit mode中は保留（終了時に自動適用される）
            // Safe fieldsはmergeしておく（タイムスタンプベースで保護）
            setSnapshot((prev) => {
              if (!prev) return prev;
              return mergeNodeAttributesWithTimestamps(
                prev,
                data.snapshot!,
                fieldTimestamps,
                scanStartTimeRef.current
              );
            });
            setPendingChanges(analysis.pendingChanges);
          } else if (Date.now() < preserveLocalEdgesUntilRef.current) {
            // 保存直後の期間: ローカルのedgeを保持しつつ、safe fieldsのみマージ
            // (保存した内容が上書きされるのを防ぐ)
            console.log("[TreeDashboard] Grace period active: preserving local edges");
            setSnapshot((prev) => {
              if (!prev) return prev;
              return mergeNodeAttributesWithTimestamps(
                prev,
                data.snapshot!,
                fieldTimestamps,
                scanStartTimeRef.current
              );
            });
            currentSnapshotVersion.current = newVersion;
            setPendingChanges(null);
          } else {
            console.log("[TreeDashboard] No grace period: full snapshot replacement (with timestamp protection)");
            // Edit mode中でなければ自動適用
            // Use timestamp-based merge to preserve newer local updates
            setSnapshot((prev) => {
              if (!prev) return data.snapshot!;
              return mergeNodeAttributesWithTimestamps(
                prev,
                data.snapshot!,
                fieldTimestamps,
                scanStartTimeRef.current
              );
            });
            currentSnapshotVersion.current = newVersion;
            setPendingChanges(null);
          }
        } else {
          // Only safe changes - merge them (with timestamp protection)
          if (!branchGraphEditMode) {
            setSnapshot((prev) => {
              if (!prev) return data.snapshot!;

              // Merge node attributes with timestamp-based protection
              let merged = mergeNodeAttributesWithTimestamps(
                prev,
                data.snapshot!,
                fieldTimestamps,
                scanStartTimeRef.current
              );

              // Add inferred edges for new branches
              if (analysis.pendingChanges?.newBranches.length) {
                const newEdges = createInferredEdgesForNewBranches(
                  merged.edges,
                  analysis.pendingChanges.newBranches,
                  data.snapshot!.edges,
                  merged.defaultBranch
                );
                merged = { ...merged, edges: newEdges };
              }

              return merged;
            });
          }
          // No unsafe changes, clear any pending and update version
          setPendingChanges(null);
          currentSnapshotVersion.current = newVersion;
        }

        // Only notify polling when scan is FULLY complete (isComplete flag)
        // When scan is fully complete, clear scanning state and start countdown
        if (data.isComplete) {
          // Clear the scanning lock immediately so new scans can be triggered
          isScanningRef.current = false;
          lastScanCompleteTimeRef.current = Date.now();
          // Clear scan start time and field timestamps (next scan starts fresh)
          scanStartTimeRef.current = null;
          setFieldTimestamps(new Map());
          // Delay countdown start until after 100% display finishes
          // Must match queueProgressUpdate(null) delay so countdown starts fresh
          setTimeout(() => {
            notifyScanCompleteRef.current();
          }, 2000); // Must match progress clear delay (2000ms)

          // Force reload branchLinks when scan completes (DB is single source of truth)
          // This ensures frontend has the latest PR data from the scan
          // Use data.snapshot directly instead of snapshotRef (which may be stale)
          const scanRepoId = data.snapshot?.repoId || snapshotRef.current?.repoId;
          const branchNames = data.snapshot?.nodes.map(n => n.branchName) || snapshotRef.current?.nodes.map(n => n.branchName) || [];
          if (scanRepoId && branchNames.length > 0) {
            api.getBranchLinksBatch(scanRepoId, branchNames)
              .then((result) => {
                const linksMap = new Map<string, BranchLink[]>();
                for (const branchName of branchNames) {
                  linksMap.set(branchName, result[branchName] || []);
                }
                setBranchLinks(linksMap);
              })
              .catch(console.error);
          }
        }
      }
    });

    // Refetch branches when planning is confirmed
    const unsubBranches = wsClient.on("branches.changed", () => {
      // Skip if scan just completed (within 3 seconds) to avoid duplicate scans
      const timeSinceLastScan = Date.now() - lastScanCompleteTimeRef.current;
      if (timeSinceLastScan < 3000) {
        addLog("branches", "Branches changed (skipped - scan just completed)");
        return;
      }
      addLog("branches", "Branches changed, rescanning...");
      if (selectedPin) {
        triggerScan(selectedPin.localPath);
      }
    });

    // Update branchLinks when PR info is refreshed (single source of truth)
    const unsubBranchLink = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as BranchLink;
      setBranchLinks((prev) => {
        const newMap = new Map(prev);
        const current = newMap.get(data.branchName) || [];
        const existingIndex = current.findIndex((l) => l.id === data.id);
        if (existingIndex >= 0) {
          current[existingIndex] = data;
        } else {
          current.unshift(data);
        }
        newMap.set(data.branchName, [...current]);
        return newMap;
      });
    });

    const unsubBranchLinkCreated = wsClient.on("branchLink.created", (msg) => {
      const data = msg.data as BranchLink;
      setBranchLinks((prev) => {
        const newMap = new Map(prev);
        const current = newMap.get(data.branchName) || [];
        if (!current.some((l) => l.id === data.id)) {
          newMap.set(data.branchName, [data, ...current]);
        }
        return newMap;
      });
    });

    // Fetch progress updates
    const unsubFetchProgress = wsClient.on("fetch.progress", (msg) => {
      const data = msg.data as { step: string; message: string };
      setFetchProgress(data.message);
      addLog("fetch", data.message);
    });

    const unsubFetchCompleted = wsClient.on("fetch.completed", () => {
      setFetchProgress(null);
      addLog("fetch", "Fetch completed");
    });

    const unsubFetchError = wsClient.on("fetch.error", (msg) => {
      setFetchProgress(null);
      addLog("error", `Fetch error: ${(msg.data as { message?: string })?.message || "Unknown"}`);
    });

    // PR/CI status updates
    const unsubPrUpdated = wsClient.on("pr.updated", (msg) => {
      type LabelInfo = { name: string; color: string };
      type Change = {
        type: string;
        old?: string | null;
        new?: string | null;
        added?: LabelInfo[];
        removed?: LabelInfo[];
      };
      const data = msg.data as {
        prs: {
          branch: string;
          checks: string | null;
          state: string;
          changes: Change[];
        }[];
        scanSessionId?: string;
      };
      if (!data.prs || data.prs.length === 0) return;

      const sessionId = data.scanSessionId;

      // Auto-expand new scan session (only if not manually toggled)
      // Also auto-close sessions beyond top 3 (only if not manually toggled)
      if (sessionId) {
        setExpandedSessions(prev => {
          // Get current scan session IDs from logs (newest first)
          const currentSessionIds = [...new Set(logs.map(l => l.scanSessionId).filter(Boolean))] as string[];
          // Add new session at the beginning
          const allSessionIds = [sessionId, ...currentSessionIds.filter(id => id !== sessionId)];
          const top3 = new Set(allSessionIds.slice(0, 3));

          const newExpanded = new Set(prev);
          // Add new session if not manually toggled
          if (!manuallyToggledSessions.has(sessionId)) {
            newExpanded.add(sessionId);
          }
          // Close sessions beyond top 3 that are not manually toggled
          for (const id of prev) {
            if (!top3.has(id) && !manuallyToggledSessions.has(id)) {
              newExpanded.delete(id);
            }
          }
          return newExpanded;
        });
      }

      // Log each change with structured data (rendered by React components)
      for (const pr of data.prs) {
        for (const change of pr.changes) {
          // Store structured data for rendering with React components
          const logData = {
            branch: pr.branch,
            changeType: change.type,
            data: change,
          };
          const html = JSON.stringify(logData);
          const plainText = `${pr.branch}: ${change.type}`;
          addLog("pr", plainText, html, pr.branch, sessionId);
        }
      }

      // Trigger burst mode and mark change for adaptive polling
      if (data.prs.length > 0) {
        triggerBurst();
        markChange();
      }

      // Update snapshot nodes with new CI status
      setSnapshot((prev) => {
        if (!prev) return prev;
        const updatedNodes = prev.nodes.map((node) => {
          const prUpdate = data.prs.find((p) => p.branch === node.branchName);
          if (prUpdate && node.pr) {
            return {
              ...node,
              pr: {
                ...node.pr,
                checks: prUpdate.checks?.toUpperCase() as "PENDING" | "SUCCESS" | "FAILURE" | undefined,
              },
            };
          }
          return node;
        });
        return { ...prev, nodes: updatedNodes };
      });
    });

    return () => {
      unsubScan();
      unsubBranches();
      unsubBranchLink();
      unsubBranchLinkCreated();
      unsubFetchProgress();
      unsubFetchCompleted();
      unsubFetchError();
      unsubPrUpdated();
    };
  }, [snapshot?.repoId, selectedPin, triggerScan, addLog]);

  // No need to update checkedBranches when nodes change - start with all unchecked

  // Load branchLinks when snapshot is available
  // DB is the single source of truth for PR info
  useEffect(() => {
    if (!snapshot?.repoId || snapshot.nodes.length === 0) return;
    const branchNames = snapshot.nodes.map((n) => n.branchName);
    api.getBranchLinksBatch(snapshot.repoId, branchNames)
      .then((result) => {
        const linksMap = new Map<string, BranchLink[]>();
        for (const branchName of branchNames) {
          linksMap.set(branchName, result[branchName] || []);
        }
        setBranchLinks(linksMap);
      })
      .catch(console.error);
  }, [snapshot?.repoId, snapshot?.nodes.length]);

  // Extract branchDescriptions from snapshot nodes (no separate API call needed)
  useEffect(() => {
    if (!snapshot?.nodes) {
      setBranchDescriptions(new Map());
      return;
    }
    const descriptions = new Map<string, string>();
    for (const node of snapshot.nodes) {
      if (node.description) {
        descriptions.set(node.branchName, node.description);
      }
    }
    setBranchDescriptions(descriptions);
  }, [snapshot?.nodes]);

  // Bottom panel resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingBottom(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = bottomHeight;
  }, [bottomHeight]);

  useEffect(() => {
    if (!isResizingBottom) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Moving up increases height (subtract delta)
      const delta = resizeStartY.current - e.clientY;
      const newHeight = Math.min(
        MAX_BOTTOM_HEIGHT,
        Math.max(MIN_BOTTOM_HEIGHT, resizeStartHeight.current + delta)
      );
      setBottomHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizingBottom(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingBottom]);

  // Planning session handlers
  const handlePlanningSessionSelect = useCallback((session: PlanningSession | null) => {
    // Only store the fields we need, not a full session copy
    // This prevents data duplication and potential sync issues
    setSelectedSessionBaseBranch(session?.baseBranch ?? null);
    setSelectedSessionType(session?.type ?? null);
    // Show tentative nodes for the session (BranchGraph will skip nodes that already exist as real branches)
    if (session) {
      setTentativeNodes(session.nodes);
      setTentativeEdges(session.edges);
    } else {
      setTentativeNodes([]);
      setTentativeEdges([]);
    }
  }, []);

  const handlePlanningTasksChange = useCallback((nodes: TaskNode[], edges: TaskEdge[]) => {
    setTentativeNodes(nodes);
    setTentativeEdges(edges);
  }, []);

  const handleActiveSessionChange = useCallback((sessionId: string | null) => {
    if (sessionId) {
      navigate(`/projects/${urlPinId}/sessions/${sessionId}`, { replace: true });
    } else if (urlSessionId) {
      // Session was deselected, go back to project URL
      navigate(`/projects/${urlPinId}`, { replace: true });
    }
  }, [navigate, urlPinId, urlSessionId]);

  const handleAddRepoPin = async () => {
    if (!newLocalPath.trim()) return;
    try {
      const pin = await api.createRepoPin(newLocalPath.trim());
      setRepoPins((prev) => [pin, ...prev]);
      navigate(`/projects/${pin.id}`);
      setNewLocalPath("");
      setShowAddNew(false);
      setSnapshot(null); // Will trigger auto-scan via useEffect
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSelectPin = async (id: number) => {
    navigate(`/projects/${id}`);
    setSnapshot(null); // Reset to trigger new scan
    try {
      await api.useRepoPin(id);
    } catch (err) {
      console.error("Failed to mark pin as used:", err);
    }
  };

  const handleConfirmDeletePin = async () => {
    if (!deletingPinId) return;
    const id = deletingPinId;
    try {
      await api.deleteRepoPin(id);
      setRepoPins((prev) => prev.filter((p) => p.id !== id));
      if (selectedPinId === id) {
        const remaining = repoPins.filter((p) => p.id !== id);
        navigate(remaining.length > 0 ? `/projects/${remaining[0].id}` : "/");
        setSnapshot(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingPinId(null);
    }
  };

  // Create branch handler
  const handleCreateBranch = async () => {
    if (!createBranchBase || !createBranchName.trim() || !selectedPin || !snapshot) return;

    setCreateBranchLoading(true);
    try {
      const newBranchName = createBranchName.trim();

      // Create the git branch
      await api.createBranch(selectedPin.localPath, newBranchName, createBranchBase);

      // Add edge to tree spec (parent -> child relationship)
      const currentEdges = snapshot.treeSpec?.specJson.edges ?? [];
      const currentNodes = snapshot.treeSpec?.specJson.nodes ?? [];

      // Add edge from base branch to new branch
      const newEdges = [
        ...currentEdges,
        { parent: createBranchBase, child: newBranchName },
      ];

      // Optimistic update: Add new branch node and edge immediately
      const newNode: import("../lib/api").TreeNode = {
        branchName: newBranchName,
        badges: [],
        lastCommitAt: new Date().toISOString(),
        aheadBehind: { ahead: 0, behind: 0 },
      };
      const newDisplayEdge = {
        parent: createBranchBase,
        child: newBranchName,
        confidence: "high" as const,
        isDesigned: true,
      };

      setSnapshot((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          nodes: [...prev.nodes, newNode],
          edges: [...prev.edges, newDisplayEdge],
          treeSpec: prev.treeSpec ? {
            ...prev.treeSpec,
            specJson: {
              nodes: currentNodes,
              edges: newEdges,
              siblingOrder: prev.treeSpec.specJson.siblingOrder,
            },
            updatedAt: new Date().toISOString(),
          } : prev.treeSpec,
        };
      });

      // Update tree spec in background
      api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: snapshot.treeSpec?.baseBranch ?? snapshot.defaultBranch,
        nodes: currentNodes,
        edges: newEdges,
        siblingOrder: snapshot.treeSpec?.specJson.siblingOrder,
      }).catch((err) => {
        console.error("Failed to update tree spec:", err);
      });

      // Background rescan to get full node info (worktree, PR, etc.)
      triggerScan(selectedPin.localPath);

      // Close dialog
      setCreateBranchBase(null);
      setCreateBranchName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreateBranchLoading(false);
    }
  };

  // Terminal handlers
  const handleOpenTerminal = (worktreePath: string, taskContext?: { title: string; description?: string }, autoRunClaude = false) => {
    setTerminalWorktreePath(worktreePath);
    setTerminalTaskContext(taskContext);
    setTerminalAutoRunClaude(autoRunClaude);
    setShowTerminal(true);
  };

  const handleCloseTerminal = () => {
    setShowTerminal(false);
    setTerminalWorktreePath(null);
    setTerminalTaskContext(undefined);
    setTerminalAutoRunClaude(false);
  };


  // Initialize tree spec state when snapshot changes
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.treeSpec) {
      setWizardBaseBranch(snapshot.treeSpec.baseBranch);
      setWizardNodes(snapshot.treeSpec.specJson.nodes);
      setWizardEdges(snapshot.treeSpec.specJson.edges);
      setWizardStatus(snapshot.treeSpec.status);
    } else {
      const baseBranch = snapshot.defaultBranch ?? "main";
      setWizardBaseBranch(baseBranch);
      setWizardNodes([]);
      setWizardEdges([]);
      setWizardStatus("draft");
    }
  }, [snapshot?.repoId]);

  const handleRemoveWizardTask = async (taskId: string) => {
    const newNodes = wizardNodes.filter((n) => n.id !== taskId);
    const newEdges = wizardEdges.filter((e) => e.parent !== taskId && e.child !== taskId);
    setWizardNodes(newNodes);
    setWizardEdges(newEdges);

    // Auto-save after deletion
    if (snapshot?.repoId) {
      try {
        await api.updateTreeSpec({
          repoId: snapshot.repoId,
          baseBranch: wizardBaseBranch,
          nodes: newNodes,
          edges: newEdges,
        });
      } catch (err) {
        console.error("Failed to save after deletion:", err);
      }
    }
  };

  // Helper to get children of a parent (null = root tasks)
  const getChildren = (parentId: string | null): TreeSpecNode[] => {
    if (parentId === null) {
      // Root tasks: have no parent edge
      return wizardNodes.filter(
        (n) => !wizardEdges.some((e) => e.child === n.id)
      );
    }
    const childEdges = wizardEdges.filter((e) => e.parent === parentId);
    return childEdges.map((e) => wizardNodes.find((n) => n.id === e.child)!).filter(Boolean);
  };

  // Render a tree node with its children
  const renderTreeNode = (task: TreeSpecNode, depth: number): React.ReactNode => {
    const children = getChildren(task.id);
    return (
      <div key={task.id} className="tree-builder__node" style={{ marginLeft: depth * 20 }}>
        <DroppableTreeNode id={task.id}>
          <DraggableTask task={task}>
            <TaskCard
              task={task}
              onStatusChange={handleUpdateTaskStatus}
              onRemove={handleRemoveWizardTask}
              onStart={handleStartTask}
              onClick={handleTaskNodeClick}
              onConsult={handleConsultTask}
              loading={loading}
              compact
              isLocked={isLocked}
              showClaudeButton={true}
            />
          </DraggableTask>
        </DroppableTreeNode>
        {children.length > 0 && (
          <div className="tree-builder__children">
            {children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const handleUpdateTaskStatus = (taskId: string, status: TaskStatus) => {
    setWizardNodes((prev) =>
      prev.map((n) => (n.id === taskId ? { ...n, status } : n))
    );
  };

  // Generate branch name from task title
  const generateBranchName = (title: string, taskId?: string): string => {
    let slug = title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")  // collapse multiple dashes
      .replace(/^-|-$/g, "") // trim leading/trailing dashes
      .substring(0, 50);

    // Fallback if slug is empty (e.g., Japanese-only title)
    if (!slug) {
      slug = taskId ? taskId.substring(0, 8) : `task-${Date.now()}`;
    }

    // Use branch naming rule if available (use first pattern with {taskSlug})
    const patterns = snapshot?.rules?.branchNaming?.patterns || [];
    const pattern = patterns.find((p) => p.includes("{taskSlug}"));
    if (pattern) {
      return pattern.replace("{taskSlug}", slug);
    }
    return `task/${slug}`;
  };

  // Start task: create branch and update status
  const handleStartTask = async (taskId: string) => {
    if (!selectedPin || !snapshot) return;

    const task = wizardNodes.find((n) => n.id === taskId);
    if (!task) return;

    // Don't start if already has a branch
    if (task.branchName) {
      setError("Task already has a branch");
      return;
    }

    const branchName = generateBranchName(task.title, task.id);
    setLoading(true);
    setError(null);

    try {
      // Create the git branch
      await api.createBranch(selectedPin.localPath, branchName, wizardBaseBranch);

      // Update task with branch name and status
      const updatedNodes = wizardNodes.map((n) =>
        n.id === taskId ? { ...n, branchName, status: "doing" as TaskStatus } : n
      );
      setWizardNodes(updatedNodes);

      // Save tree spec and update local snapshot
      const updatedSpec = await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: wizardBaseBranch,
        nodes: updatedNodes,
        edges: wizardEdges,
      });
      setSnapshot((prev) =>
        prev ? { ...prev, treeSpec: updatedSpec } : prev
      );

      // Rescan in background to update branch graph (don't await)
      triggerScan(selectedPin.localPath);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Handle clicking a task node to open its terminal
  const handleTaskNodeClick = (task: TreeSpecNode) => {
    if (!task.worktreePath) return;
    handleOpenTerminal(task.worktreePath, {
      title: task.title,
      description: task.description,
    });
  };

  // Handle consulting about a task - open terminal with Claude (auto-run)
  const handleConsultTask = (task: TreeSpecNode) => {
    if (!selectedPin) return;
    // Use worktree path if available, otherwise use main repo path
    const terminalPath = task.worktreePath || selectedPin.localPath;
    handleOpenTerminal(terminalPath, {
      title: task.title,
      description: task.description,
    }, true); // Auto-run Claude
  };

  // Check if can confirm: has base branch, has nodes, has at least one root
  const childIds = new Set(wizardEdges.map((e) => e.child));
  const rootNodes = wizardNodes.filter((n) => !childIds.has(n.id));
  void (wizardBaseBranch && wizardNodes.length > 0 && rootNodes.length > 0); // canConfirm reserved for future use
  const isLocked = wizardStatus === "confirmed" || wizardStatus === "generated";

  // Settings functions
  const handleOpenSettings = async () => {
    if (!snapshot?.repoId || !selectedPin) return;
    setShowSettings(true);
    setSettingsLoading(true);
    setSettingsDefaultBranch(selectedPin.baseBranch || "");
    setSettingsCategory("branch");
    try {
      const [rule, wtSettings, pollSettings, prSettings, labels, collaborators, teams] = await Promise.all([
        api.getBranchNaming(snapshot.repoId),
        api.getWorktreeSettings(snapshot.repoId),
        api.getPollingSettings(snapshot.repoId),
        api.getPrSettings(snapshot.repoId),
        api.getRepoLabels(snapshot.repoId).catch(() => []),
        api.getRepoCollaborators(snapshot.repoId).catch(() => []),
        api.searchRepoTeams(snapshot.repoId).catch(() => []),
      ]);
      setSettingsRule(rule);
      setSettingsPatterns(rule.patterns || []);
      setWorktreeCreateScript(wtSettings.createScript || "");
      setWorktreePostCreateScript(wtSettings.postCreateScript || "");
      setWorktreePostDeleteScript(wtSettings.postDeleteScript || "");
      setPollingPrFetchCount(pollSettings.prFetchCount ?? 5);
      setPollingIntervals(pollSettings.intervals || null);
      setPollingThresholds(pollSettings.thresholds || null);
      setPrQuickLabels(prSettings.quickLabels || []);
      setPrQuickReviewers(prSettings.quickReviewers || []);
      setRepoLabels(labels);
      setRepoTeams(teams);
      setRepoCollaborators(collaborators);
    } catch {
      // No rule exists yet
      setSettingsRule({ patterns: [] });
      setSettingsPatterns([]);
      setWorktreeCreateScript("");
      setWorktreePostCreateScript("");
      setWorktreePostDeleteScript("");
      setPollingPrFetchCount(5);
      setPollingIntervals(null);
      setPollingThresholds(null);
      setPrQuickLabels([]);
      setPrQuickReviewers([]);
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!snapshot?.repoId || !selectedPin) return;
    setSettingsLoading(true);
    setSettingsSaved(false);
    try {
      // Save branch naming rule with multiple patterns
      const validPatterns = settingsPatterns.filter(p => p.trim());
      const updated = await api.updateBranchNaming({
        repoId: snapshot.repoId,
        patterns: validPatterns,
      });
      setSettingsRule(updated);
      setSettingsPatterns(updated.patterns || validPatterns);

      // Save worktree settings
      await api.updateWorktreeSettings({
        repoId: snapshot.repoId,
        createScript: worktreeCreateScript,
        postCreateScript: worktreePostCreateScript,
        postDeleteScript: worktreePostDeleteScript,
      });

      // Save polling settings
      await api.updatePollingSettings({
        repoId: snapshot.repoId,
        prFetchCount: pollingPrFetchCount,
        intervals: pollingIntervals || undefined,
        thresholds: pollingThresholds || undefined,
      });

      // Save PR settings
      await api.updatePrSettings({
        repoId: snapshot.repoId,
        quickLabels: prQuickLabels,
        quickReviewers: prQuickReviewers,
      });

      // Save default branch (empty string clears it)
      await api.updateRepoPin(selectedPin.id, { baseBranch: settingsDefaultBranch || null });
      // Refresh pins to update baseBranch
      const pins = await api.getRepoPins();
      setRepoPins(pins);

      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSettingsLoading(false);
    }
  };

  // If no project selected, show project list
  if (!selectedPinId) {
    return (
      <div className="project-list-page">
        <div className="project-list-header">
          <h1>Vibe Tree</h1>
          <p>Select a project</p>
        </div>
        <div className="project-list">
          {repoPins.map((pin) => (
            <div
              key={pin.id}
              className="project-card"
              onClick={() => handleSelectPin(pin.id)}
            >
              <div className="project-card__name">{pin.label || pin.repoId}</div>
              <div className="project-card__path">{pin.localPath}</div>
              <button
                className="project-card__delete"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingPinId(pin.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {repoPins.length === 0 && !showAddNew && (
            <div className="project-list__empty">
              No projects yet
            </div>
          )}
        </div>
        {showAddNew ? (
          <div className="add-project-form">
            <input
              type="text"
              placeholder="Local path (e.g. ~/projects/my-app)"
              value={newLocalPath}
              onChange={(e) => setNewLocalPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddRepoPin()}
              autoFocus
            />
            <div className="add-project-form__buttons">
              <button className="btn-primary" onClick={handleAddRepoPin}>Add</button>
              <button className="btn-secondary" onClick={() => setShowAddNew(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="add-project-btn" onClick={() => setShowAddNew(true)}>
            + Add New Project
          </button>
        )}
        {error && <div className="project-list__error">{error}</div>}

        <style>{`
          .project-list-page {
            min-height: 100vh;
            background: #0f172a;
            padding: 60px 20px;
            max-width: 600px;
            margin: 0 auto;
          }
          .project-list-header {
            text-align: center;
            margin-bottom: 40px;
          }
          .project-list-header h1 {
            margin: 0 0 8px;
            font-size: 32px;
            color: #e5e7eb;
          }
          .project-list-header p {
            margin: 0;
            color: #9ca3af;
          }
          .project-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 24px;
          }
          .project-card {
            background: #1f2937;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            border: 1px solid #374151;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            position: relative;
            transition: all 0.2s;
          }
          .project-card:hover {
            border-color: #3b82f6;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
          }
          .project-card__name {
            font-weight: 600;
            font-size: 18px;
            margin-bottom: 4px;
          }
          .project-card__path {
            font-size: 13px;
            color: #6b7280;
            font-family: monospace;
          }
          .project-card__delete {
            position: absolute;
            top: 12px;
            right: 12px;
            background: #7f1d1d;
            color: #f87171;
            border: none;
            border-radius: 6px;
            padding: 4px 10px;
            cursor: pointer;
            font-size: 16px;
            opacity: 0;
            transition: opacity 0.2s;
          }
          .project-card:hover .project-card__delete {
            opacity: 1;
          }
          .project-list__empty {
            text-align: center;
            padding: 40px;
            color: #6b7280;
          }
          .add-project-btn {
            width: 100%;
            padding: 16px;
            background: #2196f3;
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
          }
          .add-project-btn:hover {
            background: #1976d2;
          }
          .add-project-form {
            background: #111827;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          }
          .add-project-form input {
            width: 100%;
            padding: 14px;
            border: 2px solid #374151;
            border-radius: 8px;
            font-size: 16px;
            margin-bottom: 12px;
            background: #111827;
            color: #e5e7eb;
          }
          .add-project-form input:focus {
            outline: none;
            border-color: #3b82f6;
          }
          .add-project-form__buttons {
            display: flex;
            gap: 12px;
          }
          .add-project-form__buttons button {
            flex: 1;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
          }
          .project-list__error {
            margin-top: 16px;
            padding: 12px;
            background: #7f1d1d;
            color: #f87171;
            border-radius: 8px;
            text-align: center;
          }
          .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2000;
          }
          .modal {
            background: #111827;
            border-radius: 12px;
            width: 360px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          }
          .modal__header {
            padding: 16px 20px;
            border-bottom: 1px solid #374151;
          }
          .modal__header h2 {
            margin: 0;
            font-size: 18px;
          }
          .modal__body {
            padding: 20px;
          }
          .modal__footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding: 16px 20px;
            border-top: 1px solid #374151;
          }
          .btn-secondary {
            background: #374151;
            color: #e5e7eb;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
          }
          .btn-danger {
            background: #dc2626;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
          }
          .btn-danger:hover {
            background: #b91c1c;
          }
        `}</style>

        {/* Delete Confirmation Modal */}
        {deletingPinId && (
          <div className="modal-overlay" onClick={() => setDeletingPinId(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal__header">
                <h2>Delete Project</h2>
              </div>
              <div className="modal__body">
                <p style={{ margin: 0, color: "#9ca3af" }}>
                  Delete "{repoPins.find(p => p.id === deletingPinId)?.label || repoPins.find(p => p.id === deletingPinId)?.repoId}"?
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280" }}>
                  Local files will not be deleted
                </p>
              </div>
              <div className="modal__footer">
                <button className="btn-secondary" onClick={() => setDeletingPinId(null)}>
                  Cancel
                </button>
                <button className="btn-danger" onClick={handleConfirmDeletePin}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dashboard dashboard--with-sidebar">
      {/* Pending unsafe changes notification (only shown during edit mode) */}
      {pendingChanges && branchGraphEditMode && (
        <ScanUpdateToast
          message="Changes pending (will apply after edit)"
          diffSummary={formatPendingChangesSummary(pendingChanges)}
          onApply={applyPendingChanges}
          onDismiss={dismissPendingChanges}
          isEditing={branchGraphEditMode}
          isApplying={isApplyingUpdate}
        />
      )}

      {/* Left Sidebar */}
      <aside className="sidebar">
        <div className="sidebar__header">
          <button className="sidebar__back" onClick={() => {
            navigate("/");
            setSnapshot(null);
          }}>
            ← Projects
          </button>
        </div>

        {/* Current Project */}
        <div className="sidebar__section">
          <h3>Project</h3>
          <div className="sidebar__project-name">{selectedPin?.label || selectedPin?.repoId}</div>
          <div className="sidebar__path">{selectedPin?.localPath}</div>
        </div>

        {/* Worktrees */}
        {snapshot && snapshot.worktrees.length > 0 && (
          <div className="sidebar__section">
            <h3>Worktrees</h3>
            <div className="sidebar__worktrees">
              {snapshot.worktrees.map((wt) => (
                <div
                  key={wt.path}
                  className={`sidebar__worktree ${selectedBranches.has(wt.branch) ? "sidebar__worktree--selected" : ""}`}
                  onClick={() => {
                    const node = snapshot.nodes.find((n) => n.branchName === wt.branch);
                    if (node) {
                      setSelectedBranches(new Set([wt.branch]));
                      setSelectionAnchor(wt.branch);
                    }
                  }}
                >
                  <div className="sidebar__worktree-header">
                    <div className="sidebar__worktree-name">
                      {wt.path.split("/").pop()}
                      {wt.dirty && <span className="sidebar__worktree-dirty">●</span>}
                    </div>
                    {wt.path !== selectedPin?.localPath && (
                      <button
                        className="sidebar__worktree-delete"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!selectedPin) return;
                          if (wt.dirty) {
                            alert("Worktree has uncommitted changes. Please commit or stash first.");
                            return;
                          }
                          if (!confirm(`Delete worktree "${wt.path.split("/").pop()}"?`)) return;
                          try {
                            await api.deleteWorktree(selectedPin.localPath, wt.path);
                            triggerScan(selectedPin.localPath);
                          } catch (err) {
                            alert("Failed to delete worktree: " + (err as Error).message);
                          }
                        }}
                        title="Delete worktree"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="sidebar__worktree-branch">{wt.branch || "(detached)"}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Menu */}
        <div className="sidebar__menu">
          <button className="sidebar__menu-item sidebar__menu-item--active">
            <FontAwesomeIcon icon={faFolder} className="sidebar__menu-icon" />
            <span>Workspace</span>
          </button>
          <button
            className="sidebar__menu-item"
            onClick={handleOpenSettings}
          >
            <FontAwesomeIcon icon={faGear} className="sidebar__menu-icon" />
            <span>Settings</span>
          </button>
        </div>

        {/* Plan Info */}
        {plan && (
          <div className="sidebar__section">
            <h3>Plan</h3>
            <div className="sidebar__plan">
              <strong>{plan.title}</strong>
              {plan.githubIssueUrl && (
                <a href={plan.githubIssueUrl} target="_blank" rel="noopener noreferrer">
                  View Issue
                </a>
              )}
            </div>
          </div>
        )}

        {/* Next scan progress bar */}
        {(pollingState.nextScanTime || pollingState.isScanning || scanProgress !== null || !hasCompletedFirstScan) && (
          <ScanProgressBar
            nextScanTime={pollingState.nextScanTime ?? Date.now()}
            interval={pollingState.interval}
            mode={pollingState.mode}
            scanProgress={scanProgress}
            isPollingScanning={pollingState.isScanning}
            isInitialLoad={!hasCompletedFirstScan}
            onTriggerScan={triggerImmediateScan}
          />
        )}

        {/* Logs section - fills all remaining space */}
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          padding: "0 8px",
          marginTop: 8,
        }}>
          <div style={{
            fontSize: 11,
            color: "#6b7280",
            marginBottom: 4,
            fontWeight: 500,
          }}>
            Logs
          </div>
          <div style={{
            flex: 1,
            fontSize: 10,
            color: "#9ca3af",
            fontFamily: "monospace",
            overflow: "auto",
          }}>
            {(() => {
              // Group logs by scanSessionId
              const reversedLogs = [...logs].reverse();
              type LogGroup = { sessionId: string; logs: LogEntry[]; timestamp: Date };
              const groups: (LogEntry | LogGroup)[] = [];
              let currentGroup: LogGroup | null = null;

              for (const log of reversedLogs) {
                if (log.scanSessionId) {
                  if (currentGroup && currentGroup.sessionId === log.scanSessionId) {
                    currentGroup.logs.push(log);
                  } else {
                    if (currentGroup) groups.push(currentGroup);
                    currentGroup = { sessionId: log.scanSessionId, logs: [log], timestamp: log.timestamp };
                  }
                } else {
                  if (currentGroup) {
                    groups.push(currentGroup);
                    currentGroup = null;
                  }
                  groups.push(log);
                }
              }
              if (currentGroup) groups.push(currentGroup);

              const pad = (n: number) => n.toString().padStart(2, "0");
              const formatTime = (t: Date) => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;

              const renderSingleLog = (log: LogEntry, isGrouped = false) => {
                const timeStr = formatTime(log.timestamp);
                const color = log.type === "error" ? "#f87171"
                  : log.type === "scan" ? "#60a5fa"
                  : log.type === "branch" ? "#a78bfa"
                  : log.type === "fetch" ? "#34d399"
                  : log.type === "pr" ? "#d1d5db"
                  : log.type === "manual" ? "#fbbf24"
                  : "#9ca3af";
                const hasBranch = !!log.branch;

                const baseStyle = {
                  cursor: hasBranch ? "pointer" : "default",
                  padding: "2px 4px",
                  margin: "-2px -4px",
                  borderRadius: 4,
                  background: hoveredLogId === log.id ? "rgba(59, 130, 246, 0.1)" : "transparent",
                  marginLeft: isGrouped ? 12 : 0,
                };

                // PR/Manual logs: 2-column grid (Time/Label | Branch/Content)
                if ((log.type === "pr" || log.type === "manual") && log.html) {
                  let logData: { branch: string; changeType: string; data: Record<string, unknown> } | null = null;
                  try {
                    logData = JSON.parse(log.html);
                  } catch {
                    // Not JSON, skip
                  }
                  if (logData && logData.changeType) {
                    const { changeType, data } = logData;
                    const labelMap: Record<string, string> = {
                      new: "",
                      checks: "CI",
                      labels: "Labels",
                      review: "Review",
                      reviewers: "Reviewers",
                    };
                    const label = labelMap[changeType] || changeType;

                    // Render content based on change type
                    const renderContent = () => {
                      switch (changeType) {
                        case "new":
                          return <span style={{ color: "#22c55e", fontWeight: 600 }}>NEW PR</span>;
                        case "checks": {
                          const oldStatus = (data.old as string)?.toLowerCase() || "unknown";
                          const newStatus = (data.new as string)?.toLowerCase() || "unknown";
                          const oldPassed = data.oldPassed as number | undefined;
                          const oldTotal = data.oldTotal as number | undefined;
                          const newPassed = data.newPassed as number | undefined;
                          const newTotal = data.newTotal as number | undefined;
                          const failedChecks = (data.failedChecks as { name: string; url: string | null }[]) || [];
                          return (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <CIBadge status={oldStatus as "success" | "failure" | "pending" | "unknown"} passed={oldPassed} total={oldTotal} />
                                <span style={{ color: "#6b7280" }}>→</span>
                                <CIBadge status={newStatus as "success" | "failure" | "pending" | "unknown"} passed={newPassed} total={newTotal} />
                              </div>
                              {newStatus === "failure" && failedChecks.length > 0 && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 4 }}>
                                  {failedChecks.map((check, i) => (
                                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                                      <span style={{ color: "#f87171" }}>✗</span>
                                      {check.url ? (
                                        <a
                                          href={check.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          style={{ color: "#f87171", textDecoration: "none" }}
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {check.name}
                                        </a>
                                      ) : (
                                        <span style={{ color: "#f87171" }}>{check.name}</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        }
                        case "labels": {
                          const added = (data.added as { name: string; color: string }[]) || [];
                          const removed = (data.removed as { name: string; color: string }[]) || [];
                          return (
                            <>
                              {added.map((l, i) => <LabelChip key={`a-${i}`} name={l.name} color={l.color} />)}
                              {removed.map((l, i) => <LabelChip key={`r-${i}`} name={l.name} color={l.color} removed />)}
                            </>
                          );
                        }
                        case "review": {
                          const status = (data.new as string)?.toLowerCase();
                          if (status === "approved") return <ReviewBadge status="approved" />;
                          if (status === "changes_requested") return <ReviewBadge status="changes_requested" />;
                          return <ReviewBadge status="pending" />;
                        }
                        case "reviewers": {
                          const newReviewers = (data.new as string)?.split(",").filter(r => r.trim()) || [];
                          const oldReviewers = (data.old as string)?.split(",").filter(r => r.trim()) || [];
                          return (
                            <>
                              {newReviewers.map((r, i) => <UserChip key={`a-${i}`} login={r.trim()} />)}
                              {oldReviewers.map((r, i) => <UserChip key={`r-${i}`} login={r.trim()} removed />)}
                            </>
                          );
                        }
                        default:
                          return <span>{changeType}</span>;
                      }
                    };

                    return (
                      <div
                        key={log.id}
                        style={{
                          ...baseStyle,
                          display: "grid",
                          gridTemplateColumns: isGrouped ? "1fr" : "52px 1fr",
                          gap: "2px 6px",
                          marginBottom: 4,
                        }}
                        onMouseEnter={() => { setHoveredLogId(log.id); if (hasBranch) setHoveredLogBranch(log.branch!); }}
                        onMouseLeave={() => { setHoveredLogId(null); if (hasBranch) setHoveredLogBranch(null); }}
                        onClick={() => {
                          if (hasBranch && snapshot && log.branch) {
                            const node = snapshot.nodes.find(n => n.branchName === log.branch);
                            if (node) {
                              setSelectedBranches(new Set([log.branch]));
                              setSelectionAnchor(log.branch);
                            }
                          }
                        }}
                      >
                        {!isGrouped && <span style={{ color: "#6b7280", fontSize: 12, textAlign: "right" }}>{timeStr}</span>}
                        <span style={{ color: "#e5e7eb", fontWeight: 500 }}>{logData.branch}</span>
                        {!isGrouped && <span style={{ color: "#6b7280", fontSize: 11, textAlign: "right" }}>{label}</span>}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                          {isGrouped && <span style={{ color: "#6b7280", fontSize: 11, marginRight: 4 }}>{label}</span>}
                          {renderContent()}
                        </div>
                      </div>
                    );
                  }
                }

                // Other logs: simple flex layout
                return (
                  <div
                    key={log.id}
                    style={{
                      ...baseStyle,
                      display: "flex",
                      gap: 8,
                      marginBottom: 4,
                      alignItems: "flex-start",
                    }}
                    onMouseEnter={() => { setHoveredLogId(log.id); if (hasBranch) setHoveredLogBranch(log.branch!); }}
                    onMouseLeave={() => { setHoveredLogId(null); if (hasBranch) setHoveredLogBranch(null); }}
                    onClick={() => {
                      if (hasBranch && snapshot && log.branch) {
                        const node = snapshot.nodes.find(n => n.branchName === log.branch);
                        if (node) {
                          setSelectedBranches(new Set([log.branch]));
                          setSelectionAnchor(log.branch);
                        }
                      }
                    }}
                  >
                    {!isGrouped && <span style={{ color: "#6b7280", flexShrink: 0, fontSize: 12, minWidth: 52 }}>{timeStr}</span>}
                    {log.html ? (
                      <div
                        style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", color }}
                        dangerouslySetInnerHTML={{ __html: log.html }}
                      />
                    ) : (
                      <span style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        wordBreak: "break-all",
                        color,
                      }}>
                        {log.message}
                      </span>
                    )}
                  </div>
                );
              };

              // Render change content (used in grouped view)
              const renderChangeContent = (log: LogEntry) => {
                if ((log.type !== "pr" && log.type !== "manual") || !log.html) return null;
                let logData: { branch: string; changeType: string; data: Record<string, unknown> } | null = null;
                try {
                  logData = JSON.parse(log.html);
                } catch {
                  return null;
                }
                if (!logData || !logData.changeType) return null;

                const { changeType, data } = logData;
                const labelMap: Record<string, string> = {
                  new: "NEW",
                  checks: "CI",
                  labels: "Labels",
                  review: "Review",
                  reviewers: "Reviewers",
                };
                const label = labelMap[changeType] || changeType;

                const content = (() => {
                  switch (changeType) {
                    case "new":
                      return <span style={{ color: "#22c55e", fontWeight: 600 }}>NEW PR</span>;
                    case "checks": {
                      const oldStatus = (data.old as string)?.toLowerCase() || "unknown";
                      const newStatus = (data.new as string)?.toLowerCase() || "unknown";
                      const oldPassed = data.oldPassed as number | undefined;
                      const oldTotal = data.oldTotal as number | undefined;
                      const newPassed = data.newPassed as number | undefined;
                      const newTotal = data.newTotal as number | undefined;
                      const failedChecks = (data.failedChecks as { name: string; url: string | null }[]) || [];
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <CIBadge status={oldStatus as "success" | "failure" | "pending" | "unknown"} passed={oldPassed} total={oldTotal} />
                            <span style={{ color: "#6b7280" }}>→</span>
                            <CIBadge status={newStatus as "success" | "failure" | "pending" | "unknown"} passed={newPassed} total={newTotal} />
                          </div>
                          {newStatus === "failure" && failedChecks.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingLeft: 4 }}>
                              {failedChecks.map((check, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                                  <span style={{ color: "#f87171" }}>✗</span>
                                  {check.url ? (
                                    <a href={check.url} target="_blank" rel="noopener noreferrer" style={{ color: "#f87171", textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>
                                      {check.name}
                                    </a>
                                  ) : (
                                    <span style={{ color: "#f87171" }}>{check.name}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                    case "labels": {
                      const added = (data.added as { name: string; color: string }[]) || [];
                      const removed = (data.removed as { name: string; color: string }[]) || [];
                      return (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {added.map((l, i) => <LabelChip key={`a-${i}`} name={l.name} color={l.color} />)}
                          {removed.map((l, i) => <LabelChip key={`r-${i}`} name={l.name} color={l.color} removed />)}
                        </div>
                      );
                    }
                    case "review": {
                      const status = (data.new as string)?.toLowerCase();
                      if (status === "approved") return <ReviewBadge status="approved" />;
                      if (status === "changes_requested") return <ReviewBadge status="changes_requested" />;
                      return <ReviewBadge status="pending" />;
                    }
                    case "reviewers": {
                      const newReviewers = (data.new as string)?.split(",").filter(r => r.trim()) || [];
                      const oldReviewers = (data.old as string)?.split(",").filter(r => r.trim()) || [];
                      return (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {newReviewers.map((r, i) => <UserChip key={`a-${i}`} login={r.trim()} />)}
                          {oldReviewers.map((r, i) => <UserChip key={`r-${i}`} login={r.trim()} removed />)}
                        </div>
                      );
                    }
                    default:
                      return <span>{changeType}</span>;
                  }
                })();

                return { label, content, logId: log.id, branch: log.branch };
              };

              return groups.map((item, idx) => {
                // Single log (no session)
                if ("id" in item) {
                  return renderSingleLog(item);
                }

                // Grouped logs by scan session
                const group = item;
                const isExpanded = expandedSessions.has(group.sessionId);
                const timeStr = formatTime(group.timestamp);

                // Group logs by branch within this scan session
                const logsByBranch = new Map<string, LogEntry[]>();
                for (const log of group.logs) {
                  const branch = log.branch || "unknown";
                  if (!logsByBranch.has(branch)) logsByBranch.set(branch, []);
                  logsByBranch.get(branch)!.push(log);
                }
                const branches = [...logsByBranch.keys()];

                return (
                  <div key={group.sessionId} style={{ marginBottom: 4 }}>
                    {/* Scan session header */}
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        cursor: "pointer",
                        padding: "2px 0",
                        borderRadius: 4,
                        background: isExpanded ? "rgba(59, 130, 246, 0.05)" : "transparent",
                      }}
                      onClick={() => {
                        const sessionId = group.sessionId;
                        // Mark as manually toggled (dirty)
                        setManuallyToggledSessions(prev => new Set([...prev, sessionId]));
                        // Toggle expanded state
                        setExpandedSessions(prev => {
                          const next = new Set(prev);
                          if (next.has(sessionId)) next.delete(sessionId);
                          else next.add(sessionId);
                          // Save to LocalStorage
                          if (snapshot?.repoId) {
                            const allSessionIds = new Set(logs.map(l => l.scanSessionId).filter(Boolean) as string[]);
                            saveAccordionState(snapshot.repoId, next, new Set([...manuallyToggledSessions, sessionId]), allSessionIds);
                          }
                          return next;
                        });
                      }}
                    >
                      <span style={{ color: "#6b7280", fontSize: 12 }}>{timeStr}</span>
                      <span style={{ color: "#60a5fa", fontSize: 11 }}>
                        {isExpanded ? "▼" : "▶"} {group.logs.length} changes
                      </span>
                    </div>
                    {/* Expanded: branch groups */}
                    {isExpanded && (
                      <div style={{ marginTop: 2, borderLeft: "2px solid #374151", marginLeft: 4, paddingLeft: 8 }}>
                        {branches.map(branch => {
                          const branchLogs = logsByBranch.get(branch) || [];
                          const isBranchHovered = hoveredLogBranch === branch;
                          return (
                            <div
                              key={branch}
                              style={{
                                marginBottom: 4,
                                background: isBranchHovered ? "rgba(59, 130, 246, 0.08)" : "transparent",
                                borderRadius: 4,
                                padding: "2px 4px",
                                margin: "-2px -4px",
                                cursor: "pointer",
                              }}
                              onMouseEnter={() => setHoveredLogBranch(branch)}
                              onMouseLeave={() => setHoveredLogBranch(null)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (snapshot) {
                                  const node = snapshot.nodes.find(n => n.branchName === branch);
                                  if (node) {
                                    setSelectedBranches(new Set([branch]));
                                    setSelectionAnchor(branch);
                                  }
                                }
                              }}
                            >
                              {/* Branch name */}
                              <div style={{ color: "#e5e7eb", fontWeight: 500, fontSize: 11 }}>
                                {branch}
                              </div>
                              {/* Changes for this branch */}
                              <div style={{ paddingLeft: 8, borderLeft: "1px solid #4b5563", marginLeft: 2 }}>
                                {branchLogs.map(log => {
                                  const change = renderChangeContent(log);
                                  if (!change) return null;
                                  return (
                                    <div
                                      key={log.id}
                                      style={{
                                        display: "flex",
                                        gap: 4,
                                        alignItems: "flex-start",
                                        padding: "1px 0",
                                      }}
                                    >
                                      <span style={{ color: "#6b7280", fontSize: 10, minWidth: 52, textAlign: "right", display: "inline-block" }}>{change.label}:</span>
                                      {change.content}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {/* Separator line */}
        <div style={{ borderTop: "1px solid #374151", margin: "8px 0" }} />

        {/* Warnings - always at bottom */}
        {snapshot && (
          <div className="sidebar__section sidebar__section--bottom" style={{ paddingTop: 0 }}>
            <button
              className="sidebar__warnings-btn"
              onClick={() => setShowWarnings(true)}
              style={{ justifyContent: "flex-start" }}
            >
              <span className="sidebar__warnings-icon">⚠</span>
              <span style={{ flex: 1, textAlign: "left" }}>Warnings</span>
              {snapshot.warnings.length > 0 && (
                <span className="sidebar__warnings-count">{snapshot.warnings.length}</span>
              )}
            </button>
          </div>
        )}

      </aside>

      {/* Main Content */}
      <main className="main-content">
        {error && <div className="dashboard__error">{error}</div>}

        {/* Tree View */}
        {snapshot && (
          <div className="tree-view">
            {/* Top: Graph + Details */}
            {!chatFullscreen && (
            <div className="tree-view__top">
              {/* Left: Graph */}
              <div className="tree-view__graph">
                <div className="panel panel--graph">
                  <div className="panel__header">
                    <h3>Branch Graph</h3>
                    <span className="panel__count" style={{ marginLeft: 12, marginRight: "auto" }}>{snapshot.nodes.length} branches</span>
                    <div className="panel__header-actions">
                      {branchGraphEditMode ? (
                        <>
                          <button
                            className="btn-icon btn-icon--danger"
                            onClick={() => {
                              // Discard: restore original state (frontend only, no DB call)
                              if (originalTreeSpecState !== null) {
                                setSnapshot((prev) => {
                                  if (!prev) return prev;
                                  // Rebuild edges: remove designed edges, add back original designed edges
                                  const nonDesignedEdges = prev.edges.filter((e) => !e.isDesigned);
                                  const originalDesignedEdges = originalTreeSpecState.edges.map((e) => ({
                                    parent: e.parent,
                                    child: e.child,
                                    confidence: "high" as const,
                                    isDesigned: true,
                                  }));
                                  return {
                                    ...prev,
                                    edges: [...nonDesignedEdges, ...originalDesignedEdges],
                                    treeSpec: prev.treeSpec ? {
                                      ...prev.treeSpec,
                                      specJson: {
                                        nodes: prev.treeSpec.specJson.nodes,
                                        edges: originalTreeSpecState.edges,
                                        siblingOrder: originalTreeSpecState.siblingOrder,
                                      },
                                    } : prev.treeSpec,
                                  };
                                });
                              }
                              setOriginalTreeSpecState(null);
                              setBranchGraphEditMode(false);
                            }}
                            title="Discard changes"
                          >
                            Discard
                          </button>
                          <button
                            className="btn-icon btn-icon--active"
                            onClick={async () => {
                              // Done: save current state to DB, then exit edit mode
                              if (selectedPin && snapshot?.repoId) {
                                try {
                                  await api.updateTreeSpec({
                                    repoId: snapshot.repoId,
                                    baseBranch: snapshot.treeSpec?.baseBranch ?? snapshot.defaultBranch,
                                    nodes: snapshot.treeSpec?.specJson.nodes ?? [],
                                    edges: snapshot.treeSpec?.specJson.edges ?? [],
                                    siblingOrder: snapshot.treeSpec?.specJson.siblingOrder,
                                  });
                                  // Mark that we just saved - preserve local edges for 10 seconds
                                  // This prevents incoming scans from overwriting our saved structure
                                  preserveLocalEdgesUntilRef.current = Date.now() + 10000;
                                  console.log("[TreeDashboard] Done: saved to DB, grace period set for 10s");
                                  // Clear pending changes BEFORE exiting edit mode
                                  // to prevent useEffect from overwriting our saved state
                                  setPendingChanges(null);
                                  setOriginalTreeSpecState(null);
                                  setBranchGraphEditMode(false);
                                  // Trigger scan after edit mode is closed
                                  triggerScan(selectedPin.localPath);
                                } catch (err) {
                                  console.error("Failed to save:", err);
                                  setError((err as Error).message);
                                }
                              } else {
                                setOriginalTreeSpecState(null);
                                setBranchGraphEditMode(false);
                              }
                            }}
                            title="Save and exit edit mode"
                          >
                            Done
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn-icon"
                          onClick={() => {
                            // Save current state before entering edit mode
                            setOriginalTreeSpecState({
                              edges: snapshot.treeSpec?.specJson.edges ?? [],
                              siblingOrder: snapshot.treeSpec?.specJson.siblingOrder,
                            });
                            setBranchGraphEditMode(true);
                          }}
                          title="Edit branch structure"
                        >
                          Edit
                        </button>
                      )}
                      <button
                        className="btn-icon"
                        onClick={() => setFilterEnabled(!filterEnabled)}
                        title={filterEnabled ? "Disable filter" : "Enable filter"}
                      >
                        {filterEnabled ? "Filter ON" : "Filter"}
                      </button>
                      <div style={{ position: "relative" }}>
                        <button
                          className="btn-icon"
                          onClick={(e) => { e.stopPropagation(); setShowMoreMenu(!showMoreMenu); }}
                          title="More options"
                        >
                          ⋮
                        </button>
                        {showMoreMenu && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              position: "absolute",
                              top: "100%",
                              right: 0,
                              background: "#1f2937",
                              border: "1px solid #374151",
                              borderRadius: 6,
                              padding: 4,
                              zIndex: 100,
                              minWidth: 150,
                            }}
                          >
                            <button
                              style={{
                                display: "block",
                                width: "100%",
                                padding: "8px 12px",
                                background: "transparent",
                                border: "none",
                                color: "#e5e7eb",
                                textAlign: "left",
                                cursor: "pointer",
                                borderRadius: 4,
                                whiteSpace: "nowrap",
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "#374151")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                              onClick={() => {
                                if (!snapshot) return;
                                const nonDefaultBranches = snapshot.nodes
                                  .filter((n) => n.branchName !== snapshot.defaultBranch)
                                  .map((n) => n.branchName);
                                const allChecked = nonDefaultBranches.every((b) => checkedBranches.has(b));
                                if (allChecked) {
                                  setCheckedBranches(new Set());
                                } else {
                                  setCheckedBranches(new Set(nonDefaultBranches));
                                }
                                setShowMoreMenu(false);
                              }}
                            >
                              Toggle All Checkboxes
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Zoom controls */}
                      <span className="zoom-controls">
                        <button
                          className="btn-icon btn-icon--small"
                          onClick={() => setGraphZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
                          disabled={graphZoom <= MIN_ZOOM}
                          title="Zoom out"
                        >
                          −
                        </button>
                        <button
                          className="btn-icon btn-icon--small zoom-controls__value"
                          onClick={() => setGraphZoom(1)}
                          title="Reset zoom"
                        >
                          {Math.round(graphZoom * 100)}%
                        </button>
                        <button
                          className="btn-icon btn-icon--small"
                          onClick={() => setGraphZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
                          disabled={graphZoom >= MAX_ZOOM}
                          title="Zoom in"
                        >
                          +
                        </button>
                      </span>
                      <button
                        className="btn-icon"
                        onClick={() => setGraphFullscreen(!graphFullscreen)}
                        title={graphFullscreen ? "Exit fullscreen" : "Fullscreen"}
                      >
                        {graphFullscreen ? "↑" : "↓"}
                      </button>
                    </div>
                  </div>
                  <div className="graph-container">
                    <BranchGraph
                      nodes={snapshot.nodes}
                      edges={snapshot.edges}
                      defaultBranch={snapshot.defaultBranch}
                      selectedBranches={selectedBranches}
                      onSelectionChange={(branches, anchor) => {
                        setSelectedBranches(branches);
                        if (anchor !== undefined) {
                          setSelectionAnchor(anchor);
                        }
                      }}
                      selectionAnchor={selectionAnchor}
                      tentativeNodes={tentativeNodes}
                      tentativeEdges={tentativeEdges}
                      editMode={branchGraphEditMode}
                      branchLinks={branchLinks}
                      branchDescriptions={branchDescriptions}
                      checkedBranches={checkedBranches}
                      onCheckedChange={(branchName, checked) => {
                        setCheckedBranches((prev) => {
                          const newSet = new Set(prev);
                          if (checked) {
                            newSet.add(branchName);
                          } else {
                            newSet.delete(branchName);
                          }
                          return newSet;
                        });
                      }}
                      filterEnabled={filterEnabled}
                      onEdgeCreate={(parentBranch, childBranch) => {
                        // Create a new edge from parent to child (reparent operation)
                        // Frontend-only update during edit mode - DB save happens on Done
                        setSnapshot((prev) => {
                          if (!prev) return prev;

                          // Check if this exact edge already exists
                          const edgeExists = prev.edges.some(
                            (e) => e.parent === parentBranch && e.child === childBranch
                          );
                          if (edgeExists) return prev;

                          // Prepare new edges
                          const currentEdges = prev.treeSpec?.specJson.edges ?? [];
                          const filteredTreeSpecEdges = currentEdges.filter((e) => e.child !== childBranch);
                          const newTreeSpecEdges = [...filteredTreeSpecEdges, { parent: parentBranch, child: childBranch }];
                          const latestNodes = prev.treeSpec?.specJson.nodes ?? [];
                          const currentSiblingOrder = prev.treeSpec?.specJson.siblingOrder;

                          return {
                            ...prev,
                            edges: prev.edges
                              .filter((e) => e.child !== childBranch)
                              .concat({
                                parent: parentBranch,
                                child: childBranch,
                                confidence: "high" as const,
                                isDesigned: true,
                              }),
                            treeSpec: prev.treeSpec ? {
                              ...prev.treeSpec,
                              specJson: {
                                nodes: latestNodes,
                                edges: newTreeSpecEdges,
                                siblingOrder: currentSiblingOrder,
                              },
                            } : prev.treeSpec,
                          };
                        });
                      }}
                      tentativeBaseBranch={selectedSessionBaseBranch ?? undefined}
                      onBranchCreate={(baseBranch) => {
                        setCreateBranchBase(baseBranch);
                        setCreateBranchName("");
                      }}
                      zoom={graphZoom}
                      onZoomChange={setGraphZoom}
                      siblingOrder={snapshot.treeSpec?.specJson.siblingOrder ?? {}}
                      onSiblingOrderChange={(newSiblingOrder) => {
                        // Frontend-only update during edit mode - DB save happens on Done
                        setSnapshot((prev) => {
                          if (!prev) return prev;

                          return {
                            ...prev,
                            treeSpec: prev.treeSpec ? {
                              ...prev.treeSpec,
                              specJson: {
                                ...prev.treeSpec.specJson,
                                siblingOrder: newSiblingOrder,
                              },
                            } : prev.treeSpec,
                          };
                        });
                      }}
                      focusSeparatorIndex={focusSeparatorIndex}
                      onFocusSeparatorIndexChange={setFocusSeparatorIndex}
                      highlightedBranch={hoveredLogBranch}
                      onWorktreeMove={(worktreePath, fromBranch, toBranch) => {
                        // Show confirmation modal instead of immediate execution
                        setPendingWorktreeMove({ worktreePath, fromBranch, toBranch });
                      }}
                      refreshingBranches={refreshingBranches}
                      repoLabels={repoLabels}
                    />
                  </div>
                </div>
              </div>

              {/* Right: Details */}
              <div className="tree-view__details">
                {selectedBranches.size > 1 ? (
                  <MultiSelectPanel
                    selectedBranches={selectedBranches}
                    checkedBranches={checkedBranches}
                    onCheckAll={() => {
                      setCheckedBranches((prev) => new Set([...prev, ...selectedBranches]));
                    }}
                    onUncheckAll={() => {
                      setCheckedBranches((prev) => {
                        const next = new Set(prev);
                        selectedBranches.forEach((b) => next.delete(b));
                        return next;
                      });
                    }}
                    onClearSelection={() => {
                      setSelectedBranches(new Set());
                      setSelectionAnchor(null);
                    }}
                    localPath={selectedPin.localPath}
                    branchLinks={branchLinks}
                    edges={snapshot.edges}
                    nodes={snapshot.nodes}
                    defaultBranch={snapshot.defaultBranch}
                    quickLabels={prQuickLabels}
                    quickReviewers={prQuickReviewers}
                    repoLabels={repoLabels}
                    repoCollaborators={repoCollaborators}
                    onRefreshBranches={() => triggerScan(selectedPin.localPath)}
                    onBranchesDeleted={(deletedBranches) => {
                      // Remove deleted branches from snapshot
                      setSnapshot((prev) => ({
                        ...prev,
                        nodes: prev.nodes.filter((n) => !deletedBranches.includes(n.branchName)),
                        edges: prev.edges.filter(
                          (e) => !deletedBranches.includes(e.child) && !deletedBranches.includes(e.parent)
                        ),
                      }));
                      // Clear selection
                      setSelectedBranches(new Set());
                      setSelectionAnchor(null);
                    }}
                  />
                ) : selectedNode && selectedPin ? (
                  <TaskDetailPanel
                    key={selectedNode.branchName}
                    repoId={snapshot.repoId}
                    localPath={selectedPin.localPath}
                    branchName={selectedNode.branchName}
                    node={selectedNode}
                    defaultBranch={snapshot.defaultBranch}
                    parentBranch={snapshot.edges.find((e) => e.child === selectedNode.branchName)?.parent}
                    onClose={() => {
                      setSelectedBranches(new Set());
                      setSelectionAnchor(null);
                    }}
                    onWorktreeCreated={() => triggerScan(selectedPin.localPath)}
                    onStartPlanning={(branchName, instruction) => {
                      setPendingPlanning({ branchName, instruction });
                    }}
                    activePlanningBranch={
                      selectedSessionType === "planning"
                        ? selectedSessionBaseBranch
                        : null
                    }
                    instruction={currentInstruction}
                    instructionLoading={instructionLoading}
                    onInstructionUpdate={(updated) => {
                      const key = updated.branchName;
                      if (key) {
                        setInstructionCache((prev) => new Map(prev).set(key, updated));
                      }
                      setCurrentInstruction(updated);
                    }}
                    description={branchDescriptions.get(selectedNode.branchName) || ""}
                    onDescriptionChange={(branch, desc) => {
                      // Update branchDescriptions (derived state)
                      setBranchDescriptions((prev) => new Map(prev).set(branch, desc));
                      // Also update snapshot.nodes to keep single source of truth
                      setSnapshot((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          nodes: prev.nodes.map((n) =>
                            n.branchName === branch ? { ...n, description: desc } : n
                          ),
                        };
                      });
                    }}
                    branchLinksFromParent={branchLinks.get(selectedNode.branchName) || []}
                    onBranchLinksChange={(branch, links) => {
                      setBranchLinks((prev) => new Map(prev).set(branch, links));
                    }}
                    onBranchDeleted={(deletedBranch) => {
                      // Immediately remove branch from graph
                      setSnapshot((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          nodes: prev.nodes.filter((n) => n.branchName !== deletedBranch),
                          edges: prev.edges.filter(
                            (e) => e.child !== deletedBranch && e.parent !== deletedBranch
                          ),
                        };
                      });
                      // Also update snapshotRef
                      if (snapshotRef.current) {
                        snapshotRef.current = {
                          ...snapshotRef.current,
                          nodes: snapshotRef.current.nodes.filter((n) => n.branchName !== deletedBranch),
                          edges: snapshotRef.current.edges.filter(
                            (e) => e.child !== deletedBranch && e.parent !== deletedBranch
                          ),
                        };
                      }
                    }}
                    edges={snapshot.edges}
                    onBranchStatusRefresh={(updates) => {
                      const now = Date.now();

                      // Record timestamps for updated fields (for scan merge protection)
                      setFieldTimestamps((prev) => {
                        const next = new Map(prev);
                        Object.keys(updates).forEach((branchName) => {
                          const update = updates[branchName];
                          const existing = next.get(branchName) || {};
                          next.set(branchName, {
                            ...existing,
                            aheadBehind: update.aheadBehind ? now : existing.aheadBehind,
                            remoteAheadBehind: update.remoteAheadBehind ? now : existing.remoteAheadBehind,
                          });
                        });
                        return next;
                      });

                      // Partial update: only update ahead/behind for specified branches
                      setSnapshot((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          nodes: prev.nodes.map((node) => {
                            const update = updates[node.branchName];
                            if (!update) return node;
                            return {
                              ...node,
                              aheadBehind: update.aheadBehind ?? node.aheadBehind,
                              remoteAheadBehind: update.remoteAheadBehind,
                            };
                          }),
                        };
                      });
                    }}
                    onBranchStatusRefreshStart={(branches) => {
                      setRefreshingBranches((prev) => new Set([...prev, ...branches]));
                    }}
                    onBranchStatusRefreshEnd={(branches) => {
                      setRefreshingBranches((prev) => {
                        const next = new Set(prev);
                        branches.forEach((b) => next.delete(b));
                        return next;
                      });
                    }}
                    prQuickLabels={prQuickLabels}
                    prQuickReviewers={prQuickReviewers}
                    allRepoLabels={repoLabels}
                    repoCollaborators={repoCollaborators}
                  />
                ) : (
                  <div className="panel">
                    <div className="panel__header">
                      <h3>Branch</h3>
                    </div>
                    <p style={{ padding: "16px", color: "#666" }}>
                      Click on a branch to see details.
                    </p>
                  </div>
                )}
              </div>
            </div>
            )}

            {/* Resize Handle between top and bottom */}
            {!chatFullscreen && !graphFullscreen && (
            <div
              className={`tree-view__resize-handle ${isResizingBottom ? "tree-view__resize-handle--active" : ""}`}
              onMouseDown={handleResizeStart}
              onDoubleClick={() => setBottomHeight(DEFAULT_BOTTOM_HEIGHT)}
            >
              <div className="tree-view__resize-bar" />
            </div>
            )}

            {/* Bottom: Claude Code Sessions */}
            {!graphFullscreen && (
            <div
              className="tree-view__bottom"
              style={{ flex: chatFullscreen ? 1 : `0 0 ${bottomHeight}px` }}
            >
              <div className="sessions-container">
                <PlanningPanel
                  repoId={snapshot.repoId}
                  defaultBranch={snapshot.defaultBranch}
                  onTasksChange={handlePlanningTasksChange}
                  onSessionSelect={handlePlanningSessionSelect}
                  pendingPlanning={pendingPlanning}
                  onPlanningStarted={() => setPendingPlanning(null)}
                  graphNodes={snapshot.nodes}
                  graphEdges={snapshot.edges}
                  chatFullscreen={chatFullscreen}
                  onToggleFullscreen={() => setChatFullscreen(!chatFullscreen)}
                  initialSessionId={urlSessionId}
                  onActiveSessionChange={handleActiveSessionChange}
                  branchLinks={branchLinks}
                />
              </div>
            </div>
            )}
          </div>
        )}

        {!snapshot && loading && (
          <div className="loading-state">
            <div className="loading-state__spinner">
              <div className="spinner spinner--large" />
            </div>
            <p>Loading repository...</p>
          </div>
        )}

        {!snapshot && !loading && (
          <div className="empty-state">
            <h2>No repository selected</h2>
            <p>Select a repository from the sidebar and click Scan to get started.</p>
          </div>
        )}
      </main>

      {/* Terminal Panel (floating) */}
      {showTerminal && terminalWorktreePath && snapshot && (
        <div className="terminal-panel">
          <TerminalPanel
            repoId={snapshot.repoId}
            worktreePath={terminalWorktreePath}
            onClose={handleCloseTerminal}
            taskContext={terminalTaskContext}
            autoRunClaude={terminalAutoRunClaude}
          />
        </div>
      )}

      {/* Settings Modal - Sidebar Layout */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="settings-modal">
            <div className="settings-modal__header">
              <h2>Settings</h2>
              <button onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="settings-modal__body">
              <div className="settings-modal__sidebar">
                <button
                  className={`settings-modal__nav-item ${settingsCategory === "branch" ? "settings-modal__nav-item--active" : ""}`}
                  onClick={() => setSettingsCategory("branch")}
                >
                  Branch
                </button>
                <button
                  className={`settings-modal__nav-item ${settingsCategory === "worktree" ? "settings-modal__nav-item--active" : ""}`}
                  onClick={() => setSettingsCategory("worktree")}
                >
                  Worktree
                </button>
                <button
                  className={`settings-modal__nav-item ${settingsCategory === "polling" ? "settings-modal__nav-item--active" : ""}`}
                  onClick={() => setSettingsCategory("polling")}
                >
                  Polling
                </button>
                <div className="settings-modal__nav-group">
                  <span className="settings-modal__nav-parent">PR</span>
                  <button
                    className={`settings-modal__nav-item settings-modal__nav-item--child ${settingsCategory === "pr-labels" ? "settings-modal__nav-item--active" : ""}`}
                    onClick={() => setSettingsCategory("pr-labels")}
                  >
                    Labels
                  </button>
                  <button
                    className={`settings-modal__nav-item settings-modal__nav-item--child ${settingsCategory === "pr-reviewers" ? "settings-modal__nav-item--active" : ""}`}
                    onClick={() => setSettingsCategory("pr-reviewers")}
                  >
                    Reviewers
                  </button>
                </div>
                <button
                  className={`settings-modal__nav-item ${settingsCategory === "cleanup" ? "settings-modal__nav-item--active" : ""}`}
                  onClick={() => setSettingsCategory("cleanup")}
                >
                  Cleanup
                </button>
                <button
                  className={`settings-modal__nav-item ${settingsCategory === "debug" ? "settings-modal__nav-item--active" : ""}`}
                  onClick={() => setSettingsCategory("debug")}
                >
                  Debug
                </button>
              </div>
              <div className="settings-modal__content">
                {settingsLoading && !settingsRule ? (
                  <div className="modal__loading">Loading...</div>
                ) : settingsRule ? (
                  <>
                    {settingsSaved && (
                      <div className="modal__success">Settings saved!</div>
                    )}

                    {/* Branch Settings */}
                    {settingsCategory === "branch" && (
                      <>
                        <h3>Branch</h3>
                        <div className="settings-section">
                          <label>Default Branch</label>
                          <input
                            type="text"
                            value={settingsDefaultBranch}
                            onChange={(e) => setSettingsDefaultBranch(e.target.value)}
                            placeholder="develop"
                          />
                          <p style={{ marginTop: 4, color: "#9ca3af" }}>Task instructions and chat history will not be shown for this branch</p>
                        </div>
                        <div className="settings-section">
                          <label>Branch Naming Patterns</label>
                          <p style={{ marginBottom: 8, color: "#9ca3af" }}>Regular expressions are supported</p>
                          {settingsPatterns.map((pattern, index) => (
                            <div key={index} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                              <input
                                type="text"
                                value={pattern}
                                onChange={(e) => {
                                  const newPatterns = [...settingsPatterns];
                                  newPatterns[index] = e.target.value;
                                  setSettingsPatterns(newPatterns);
                                }}
                                placeholder="^feat/.*"
                                style={{ flex: 1 }}
                              />
                              <button
                                type="button"
                                className="btn-icon"
                                onClick={() => {
                                  setSettingsPatterns(settingsPatterns.filter((_, i) => i !== index));
                                }}
                                style={{ padding: "4px 8px", color: "#ef4444" }}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setSettingsPatterns([...settingsPatterns, ""])}
                            style={{ marginTop: 4 }}
                          >
                            + Add Pattern
                          </button>
                        </div>
                      </>
                    )}

                    {/* Worktree Settings */}
                    {settingsCategory === "worktree" && (
                      <>
                        <h3>Worktree</h3>
                        <div className="settings-section">
                          <label>Worktree Creation Command</label>
                          <p style={{ marginBottom: 8, color: "#9ca3af" }}>
                            Custom command to create worktree. Leave empty for default.
                            <br />Placeholders: <code style={{ background: "#374151", padding: "2px 6px", borderRadius: 3, color: "#60a5fa" }}>{"{worktreePath}"}</code> <code style={{ background: "#374151", padding: "2px 6px", borderRadius: 3, color: "#60a5fa" }}>{"{branchName}"}</code> <code style={{ background: "#374151", padding: "2px 6px", borderRadius: 3, color: "#60a5fa" }}>{"{localPath}"}</code>
                          </p>
                          <input
                            type="text"
                            value={worktreeCreateScript}
                            onChange={(e) => setWorktreeCreateScript(e.target.value)}
                            placeholder="git worktree add {worktreePath} {branchName}"
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
                          />
                        </div>
                        <div className="settings-section">
                          <label>Post-Create Script</label>
                          <p style={{ marginBottom: 8, color: "#9ca3af" }}>
                            Script to run after creating a worktree (runs in worktree directory)
                          </p>
                          <textarea
                            value={worktreePostCreateScript}
                            onChange={(e) => setWorktreePostCreateScript(e.target.value)}
                            placeholder="bun install"
                            rows={4}
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 12, background: "#1f2937", border: "1px solid #374151", borderRadius: 4, padding: 8, color: "white", resize: "vertical" }}
                          />
                        </div>
                        <div className="settings-section">
                          <label>Post-Delete Script</label>
                          <p style={{ marginBottom: 8, color: "#9ca3af" }}>
                            Script to run after deleting a worktree (runs in main repository directory)
                          </p>
                          <textarea
                            value={worktreePostDeleteScript}
                            onChange={(e) => setWorktreePostDeleteScript(e.target.value)}
                            placeholder="echo 'Worktree deleted'"
                            rows={4}
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 12, background: "#1f2937", border: "1px solid #374151", borderRadius: 4, padding: 8, color: "white", resize: "vertical" }}
                          />
                        </div>
                      </>
                    )}

                    {/* Polling Settings */}
                    {settingsCategory === "polling" && (
                      <>
                        <h3>Polling</h3>
                        <div className="settings-section">
                          <label>PR Fetch Count</label>
                          <p style={{ marginTop: 4, color: "#9ca3af" }}>
                            Number of PRs to refresh per scan (1-20). Higher values = more API calls.
                          </p>
                          <input
                            type="number"
                            value={pollingPrFetchCount}
                            onChange={(e) => setPollingPrFetchCount(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
                            min={1}
                            max={20}
                            style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                          />
                        </div>

                        <h4 style={{ marginTop: 24, marginBottom: 8, color: "#e5e7eb" }}>Polling Intervals (seconds)</h4>
                        <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>
                          How often to scan based on current state. Leave empty to use defaults.
                        </p>

                        <div className="settings-section" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                          <div>
                            <label style={{ fontSize: 13, color: "#f59e0b" }}>Burst</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>After PR update detected</p>
                            <input
                              type="number"
                              value={pollingIntervals?.burst ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingIntervals(prev => prev ? { ...prev, burst: val || 15 } : { burst: val || 15, dirty: 30, ciPending: 60, active: 60, idle: 180, superIdle: 300 });
                              }}
                              placeholder="15"
                              min={5}
                              max={300}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#ef4444" }}>Dirty</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>Worktree has uncommitted changes</p>
                            <input
                              type="number"
                              value={pollingIntervals?.dirty ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingIntervals(prev => prev ? { ...prev, dirty: val || 30 } : { burst: 15, dirty: val || 30, ciPending: 60, active: 60, idle: 180, superIdle: 300 });
                              }}
                              placeholder="30"
                              min={5}
                              max={600}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#eab308" }}>CI Pending</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>PR has pending CI checks</p>
                            <input
                              type="number"
                              value={pollingIntervals?.ciPending ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingIntervals(prev => prev ? { ...prev, ciPending: val || 60 } : { burst: 15, dirty: 30, ciPending: val || 60, active: 60, idle: 180, superIdle: 300 });
                              }}
                              placeholder="60"
                              min={10}
                              max={600}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#22c55e" }}>Active</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>Normal active window</p>
                            <input
                              type="number"
                              value={pollingIntervals?.active ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingIntervals(prev => prev ? { ...prev, active: val || 60 } : { burst: 15, dirty: 30, ciPending: 60, active: val || 60, idle: 180, superIdle: 300 });
                              }}
                              placeholder="60"
                              min={10}
                              max={600}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#6b7280" }}>Idle</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>No changes for a while</p>
                            <input
                              type="number"
                              value={pollingIntervals?.idle ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingIntervals(prev => prev ? { ...prev, idle: val || 180 } : { burst: 15, dirty: 30, ciPending: 60, active: 60, idle: val || 180, superIdle: 300 });
                              }}
                              placeholder="180"
                              min={30}
                              max={1800}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#4b5563" }}>Super Idle</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>Long time without changes</p>
                            <input
                              type="number"
                              value={pollingIntervals?.superIdle ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingIntervals(prev => prev ? { ...prev, superIdle: val || 300 } : { burst: 15, dirty: 30, ciPending: 60, active: 60, idle: 180, superIdle: val || 300 });
                              }}
                              placeholder="300"
                              min={60}
                              max={3600}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                        </div>

                        <h4 style={{ marginTop: 24, marginBottom: 8, color: "#e5e7eb" }}>Phase Transition Thresholds (seconds)</h4>
                        <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>
                          How long without activity before transitioning to slower polling. Leave empty to use defaults.
                        </p>

                        <div className="settings-section" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                          <div>
                            <label style={{ fontSize: 13, color: "#6b7280" }}>Idle Threshold</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>Time before entering idle mode</p>
                            <input
                              type="number"
                              value={pollingThresholds?.idle ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingThresholds(prev => prev ? { ...prev, idle: val || 300 } : { idle: val || 300, superIdle: 600, ciPendingTimeout: 600 });
                              }}
                              placeholder="300"
                              min={60}
                              max={1800}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#4b5563" }}>Super Idle Threshold</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>Time before entering super idle</p>
                            <input
                              type="number"
                              value={pollingThresholds?.superIdle ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingThresholds(prev => prev ? { ...prev, superIdle: val || 600 } : { idle: 300, superIdle: val || 600, ciPendingTimeout: 600 });
                              }}
                              placeholder="600"
                              min={120}
                              max={3600}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 13, color: "#eab308" }}>CI Pending Timeout</label>
                            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 4px" }}>Max time in CI pending mode</p>
                            <input
                              type="number"
                              value={pollingThresholds?.ciPendingTimeout ?? ""}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setPollingThresholds(prev => prev ? { ...prev, ciPendingTimeout: val || 600 } : { idle: 300, superIdle: 600, ciPendingTimeout: val || 600 });
                              }}
                              placeholder="600"
                              min={60}
                              max={3600}
                              style={{ width: 80, padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "white" }}
                            />
                          </div>
                        </div>

                        <div style={{ marginTop: 24, padding: 12, background: "#1f2937", borderRadius: 6, fontSize: 13 }}>
                          <p style={{ color: "#9ca3af", margin: 0 }}>
                            <strong style={{ color: "#e5e7eb" }}>Current mode:</strong>{" "}
                            <span style={{ color: MODE_LABELS[pollingState.mode]?.color || "#e5e7eb" }}>
                              {MODE_LABELS[pollingState.mode]?.label || pollingState.mode}
                            </span>
                            {" • "}
                            <strong style={{ color: "#e5e7eb" }}>Interval:</strong> {pollingState.interval / 1000}s
                          </p>
                        </div>
                      </>
                    )}

                    {/* PR Labels Settings */}
                    {settingsCategory === "pr-labels" && (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <h3 style={{ margin: 0 }}>Labels</h3>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={isSyncingCache}
                            onClick={async () => {
                              if (!snapshot?.repoId) return;
                              setIsSyncingCache(true);
                              try {
                                await api.syncRepoCache(snapshot.repoId);
                                const [labels, collaborators, teams] = await Promise.all([
                                  api.getRepoLabels(snapshot.repoId).catch(() => []),
                                  api.getRepoCollaborators(snapshot.repoId).catch(() => []),
                                  api.searchRepoTeams(snapshot.repoId).catch(() => []),
                                ]);
                                setRepoLabels(labels);
                                setRepoCollaborators(collaborators);
                                setRepoTeams(teams);
                              } finally {
                                setIsSyncingCache(false);
                              }
                            }}
                            style={{ padding: "4px 12px", fontSize: 12 }}
                          >
                            {isSyncingCache ? "Syncing..." : "Sync from GitHub"}
                          </button>
                        </div>
                        <p style={{ color: "#9ca3af", margin: "0 0 16px" }}>
                          Quick toggle labels in the PR section of branch details.
                        </p>

                        {/* Selected labels at the top */}
                        {prQuickLabels.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <label style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8, display: "block" }}>Selected ({prQuickLabels.length})</label>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {prQuickLabels.map((labelName) => {
                                const label = repoLabels.find((l) => l.name === labelName);
                                const color = label?.color || "6b7280";
                                return (
                                  <LabelChip
                                    key={labelName}
                                    name={labelName}
                                    color={color}
                                    onRemove={() => setPrQuickLabels(prQuickLabels.filter((l) => l !== labelName))}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Search and available labels */}
                        <label style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8, display: "block" }}>Available Labels</label>
                        <input
                          type="text"
                          placeholder="Search labels..."
                          value={labelSearch}
                          onChange={(e) => setLabelSearch(e.target.value)}
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            background: "#1f2937",
                            border: "1px solid #374151",
                            borderRadius: 6,
                            color: "white",
                            fontSize: 13,
                            marginBottom: 12,
                          }}
                        />
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, maxHeight: 250, overflowY: "auto" }}>
                          {repoLabels
                            .filter((label) => !prQuickLabels.includes(label.name) && label.name.toLowerCase().includes(labelSearch.toLowerCase()))
                            .map((label) => (
                              <LabelChip
                                key={label.name}
                                name={label.name}
                                color={label.color}
                                onClick={() => setPrQuickLabels([...prQuickLabels, label.name])}
                              />
                            ))}
                          {repoLabels.length === 0 && (
                            <span style={{ color: "#6b7280", fontStyle: "italic" }}>No labels found in repository</span>
                          )}
                          {repoLabels.length > 0 && repoLabels.filter((l) => !prQuickLabels.includes(l.name) && l.name.toLowerCase().includes(labelSearch.toLowerCase())).length === 0 && (
                            <span style={{ color: "#6b7280", fontStyle: "italic" }}>
                              {prQuickLabels.length === repoLabels.length ? "All labels selected" : "No matching labels"}
                            </span>
                          )}
                        </div>
                      </>
                    )}

                    {/* PR Reviewers Settings */}
                    {settingsCategory === "pr-reviewers" && (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <h3 style={{ margin: 0 }}>Reviewers</h3>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={isSyncingCache}
                            onClick={async () => {
                              if (!snapshot?.repoId) return;
                              setIsSyncingCache(true);
                              try {
                                await api.syncRepoCache(snapshot.repoId);
                                const [labels, collaborators, teams] = await Promise.all([
                                  api.getRepoLabels(snapshot.repoId).catch(() => []),
                                  api.getRepoCollaborators(snapshot.repoId).catch(() => []),
                                  api.searchRepoTeams(snapshot.repoId).catch(() => []),
                                ]);
                                setRepoLabels(labels);
                                setRepoCollaborators(collaborators);
                                setRepoTeams(teams);
                              } finally {
                                setIsSyncingCache(false);
                              }
                            }}
                            style={{ padding: "4px 12px", fontSize: 12 }}
                          >
                            {isSyncingCache ? "Syncing..." : "Sync from GitHub"}
                          </button>
                        </div>
                        <p style={{ color: "#9ca3af", margin: "0 0 16px" }}>
                          Quick toggle reviewers in the PR section of branch details.
                        </p>

                        {/* Selected reviewers at the top */}
                        {prQuickReviewers.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <label style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8, display: "block" }}>Selected ({prQuickReviewers.length})</label>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {prQuickReviewers.map((reviewerName) => {
                                const isTeam = reviewerName.startsWith("team/");
                                if (isTeam) {
                                  const team = repoTeams.find((t) => `team/${t.slug}` === reviewerName);
                                  return (
                                    <TeamChip
                                      key={reviewerName}
                                      slug={team?.name || reviewerName.replace("team/", "")}
                                      onRemove={() => setPrQuickReviewers(prQuickReviewers.filter((r) => r !== reviewerName))}
                                    />
                                  );
                                }
                                const collaborator = repoCollaborators.find((c) => c.login === reviewerName);
                                return (
                                  <UserChip
                                    key={reviewerName}
                                    login={reviewerName}
                                    name={collaborator?.name}
                                    avatarUrl={collaborator?.avatarUrl}
                                    onRemove={() => setPrQuickReviewers(prQuickReviewers.filter((r) => r !== reviewerName))}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Search */}
                        <input
                          type="text"
                          placeholder="Search reviewers..."
                          value={reviewerSearch}
                          onChange={(e) => setReviewerSearch(e.target.value)}
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            background: "#1f2937",
                            border: "1px solid #374151",
                            borderRadius: 6,
                            color: "white",
                            fontSize: 13,
                            marginBottom: 12,
                          }}
                        />

                        {/* Teams section */}
                        {repoTeams.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <label style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8, display: "block" }}>Teams</label>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {repoTeams
                                .filter((team) => {
                                  const teamKey = `team/${team.slug}`;
                                  if (prQuickReviewers.includes(teamKey)) return false;
                                  const search = reviewerSearch.toLowerCase();
                                  return team.name.toLowerCase().includes(search) || team.slug.toLowerCase().includes(search);
                                })
                                .map((team) => (
                                  <TeamChip
                                    key={team.slug}
                                    slug={team.name}
                                    onClick={() => setPrQuickReviewers([...prQuickReviewers, `team/${team.slug}`])}
                                  />
                                ))}
                            </div>
                          </div>
                        )}

                        {/* Users section */}
                        <label style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8, display: "block" }}>Users</label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, maxHeight: 200, overflowY: "auto" }}>
                          {repoCollaborators
                            .filter((c) => {
                              if (prQuickReviewers.includes(c.login)) return false;
                              const search = reviewerSearch.toLowerCase();
                              return c.login.toLowerCase().includes(search) || (c.name && c.name.toLowerCase().includes(search));
                            })
                            .map((collaborator) => (
                              <UserChip
                                key={collaborator.login}
                                login={collaborator.login}
                                name={collaborator.name}
                                avatarUrl={collaborator.avatarUrl}
                                onClick={() => setPrQuickReviewers([...prQuickReviewers, collaborator.login])}
                              />
                            ))}
                          {repoCollaborators.length === 0 && (
                            <span style={{ color: "#6b7280", fontStyle: "italic" }}>No collaborators found</span>
                          )}
                          {repoCollaborators.length > 0 && repoCollaborators.filter((c) => {
                            if (prQuickReviewers.includes(c.login)) return false;
                            const search = reviewerSearch.toLowerCase();
                            return c.login.toLowerCase().includes(search) || (c.name && c.name.toLowerCase().includes(search));
                          }).length === 0 && (
                            <span style={{ color: "#6b7280", fontStyle: "italic" }}>
                              {prQuickReviewers.filter(r => !r.startsWith("team/")).length === repoCollaborators.length ? "All users selected" : "No matching users"}
                            </span>
                          )}
                        </div>
                      </>
                    )}

                    {/* Cleanup Settings */}
                    {settingsCategory === "cleanup" && (
                      <>
                        <h3>Cleanup</h3>
                        <div className="settings-section">
                          <label>Stale Data Cleanup</label>
                          <p style={{ color: "#9ca3af", margin: "4px 0 12px" }}>
                            Remove chat history and settings for branches that no longer exist in the repository.
                          </p>
                          <button
                            type="button"
                            className="btn-secondary"
                            style={{ background: "#7f1d1d", color: "#fca5a5" }}
                            onClick={() => setShowCleanupConfirm(true)}
                          >
                            Clean Up Stale Data
                          </button>
                        </div>
                      </>
                    )}

                    {settingsCategory === "debug" && (
                      <>
                        <h3>Debug</h3>
                        <div className="settings-section">
                          <label style={{ display: "flex", alignItems: "center", gap: "12px", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={debugModeEnabled}
                              onChange={(e) => {
                                localStorage.setItem("vibe-tree-debug-mode", e.target.checked ? "true" : "false");
                                setDebugModeEnabled(e.target.checked);
                              }}
                              style={{ width: "18px", height: "18px", cursor: "pointer" }}
                            />
                            <span>Fast Polling (10s)</span>
                          </label>
                          <p style={{ color: "#9ca3af", margin: "8px 0 0" }}>
                            Enable 10-second polling interval for debugging. Page refresh required.
                          </p>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div className="modal__error">Failed to load settings</div>
                )}
              </div>
            </div>
            <div className="settings-modal__footer">
              <button className="btn-secondary" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleSaveSettings}
                disabled={settingsLoading}
              >
                {settingsLoading ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cleanup Confirm Modal */}
      {showCleanupConfirm && (
        <div className="modal-overlay" onClick={() => { setShowCleanupConfirm(false); setCleanupResult(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>{cleanupResult ? "Cleanup Complete" : "Clean Up Stale Data"}</h2>
            </div>
            <div className="modal__body">
              {cleanupResult ? (
                <>
                  <p style={{ margin: 0, color: "#9ca3af" }}>
                    {cleanupResult.chatSessions + cleanupResult.taskInstructions + cleanupResult.branchLinks > 0 ? (
                      <>
                        Cleaned up:<br />
                        - Chat sessions: {cleanupResult.chatSessions}<br />
                        - Task settings: {cleanupResult.taskInstructions}<br />
                        - Branch links: {cleanupResult.branchLinks}
                      </>
                    ) : (
                      "No stale data found."
                    )}
                  </p>
                </>
              ) : (
                <p style={{ margin: 0, color: "#9ca3af" }}>
                  Remove chat history and settings for branches that no longer exist?
                </p>
              )}
            </div>
            <div className="modal__footer">
              {cleanupResult ? (
                <button className="btn-primary" onClick={() => { setShowCleanupConfirm(false); setCleanupResult(null); }}>
                  OK
                </button>
              ) : (
                <>
                  <button className="btn-secondary" onClick={() => setShowCleanupConfirm(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      if (!selectedPin) return;
                      try {
                        const result = await api.cleanupOrphanedBranchData(selectedPin.localPath);
                        setCleanupResult(result.cleaned);
                      } catch (err) {
                        setCleanupResult({ chatSessions: 0, taskInstructions: 0, branchLinks: 0 });
                      }
                    }}
                  >
                    Clean Up
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Worktree Move Confirmation Modal */}
      {pendingWorktreeMove && (
        <div className="modal-overlay" onClick={() => setPendingWorktreeMove(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Move Worktree</h2>
            </div>
            <div className="modal__body">
              {/* Worktree name */}
              <div style={{ marginBottom: 16, padding: "10px 14px", background: "#1e3a5f", borderRadius: 6, border: "1px solid #3b82f6" }}>
                <div style={{ fontSize: "0.7em", color: "#9ca3af", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>Worktree</div>
                <div style={{ fontSize: "1em", fontWeight: 600, color: "#60a5fa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pendingWorktreeMove.worktreePath.split("/").pop()}
                </div>
              </div>

              {/* From → To (vertical layout) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* From */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 50, fontSize: "0.8em", color: "#9ca3af", textAlign: "right" }}>From</div>
                  <div style={{ flex: 1, padding: "8px 12px", background: "#422006", borderRadius: 6, border: "1px solid #f59e0b", overflow: "hidden" }}>
                    <div style={{ fontSize: "0.9em", fontWeight: 600, color: "#fbbf24", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {pendingWorktreeMove.fromBranch}
                    </div>
                  </div>
                </div>

                {/* Arrow */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 50 }} />
                  <div style={{ color: "#6b7280", fontSize: "1.2em" }}>↓</div>
                </div>

                {/* To */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 50, fontSize: "0.8em", color: "#9ca3af", textAlign: "right" }}>To</div>
                  <div style={{ flex: 1, padding: "8px 12px", background: "#14532d", borderRadius: 6, border: "1px solid #22c55e", overflow: "hidden" }}>
                    <div style={{ fontSize: "0.9em", fontWeight: 600, color: "#4ade80", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {pendingWorktreeMove.toBranch}
                    </div>
                  </div>
                </div>
              </div>

              <p style={{ margin: "16px 0 0", fontSize: "0.8em", color: "#6b7280" }}>
                This will checkout the target branch in the worktree directory.
              </p>
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setPendingWorktreeMove(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={async () => {
                  const { worktreePath, fromBranch, toBranch } = pendingWorktreeMove;
                  setPendingWorktreeMove(null);

                  // Save previous snapshot for rollback
                  const previousSnapshot = snapshot;

                  // Optimistic update: immediately update UI
                  setSnapshot((prev) => {
                    if (!prev) return prev;
                    // Find the worktree being moved
                    const worktree = prev.worktrees.find((w) => w.path === worktreePath);
                    if (!worktree) return prev;

                    return {
                      ...prev,
                      // Update worktrees array
                      worktrees: prev.worktrees.map((w) =>
                        w.path === worktreePath ? { ...w, branch: toBranch } : w
                      ),
                      // Update nodes: remove worktree from fromBranch, add to toBranch
                      nodes: prev.nodes.map((node) => {
                        if (node.branchName === fromBranch) {
                          return { ...node, worktree: undefined };
                        }
                        if (node.branchName === toBranch) {
                          return { ...node, worktree: { ...worktree, branch: toBranch } };
                        }
                        return node;
                      }),
                    };
                  });

                  // API request in background
                  try {
                    await api.checkout(worktreePath, toBranch);
                    // Success: trigger scan to get accurate state
                    if (selectedPin) {
                      triggerScan(selectedPin.localPath);
                    }
                  } catch (err) {
                    // Rollback on failure
                    console.error("Failed to move worktree:", err);
                    setSnapshot(previousSnapshot);
                    setError((err as Error).message);
                  }
                }}
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Warnings Modal */}
      {showWarnings && snapshot && (() => {
        const WARNING_CONFIG: Record<string, { label: string; color: string }> = {
          BEHIND_PARENT: { label: "Behind Parent", color: "#f59e0b" },
          BRANCH_NAMING_VIOLATION: { label: "Branch Naming", color: "#8b5cf6" },
          DIRTY: { label: "Uncommitted Changes", color: "#ef4444" },
          CI_FAIL: { label: "CI Failed", color: "#dc2626" },
          TREE_DIVERGENCE: { label: "Tree Divergence", color: "#06b6d4" },
          ORDER_BROKEN: { label: "Order Broken", color: "#ec4899" },
        };
        const getWarningConfig = (code: string) => WARNING_CONFIG[code] || { label: code, color: "#6b7280" };

        // Get unique warning codes that exist in current warnings
        const existingCodes = [...new Set(snapshot.warnings.map((w) => w.code))];

        return (
        <div className="modal-overlay" onClick={() => setShowWarnings(false)}>
          <div className="modal modal--warnings" onClick={(e) => e.stopPropagation()} style={{ height: 500 }}>
            <div className="modal__header">
              <h2>Warnings ({snapshot.warnings.length})</h2>
              <button onClick={() => setShowWarnings(false)}>×</button>
            </div>
            <div className="modal__filters">
              <button
                className={`filter-btn ${warningFilter === null ? "filter-btn--active" : ""}`}
                onClick={() => setWarningFilter(null)}
              >
                All
              </button>
              {existingCodes.map((code) => (
                <button
                  key={code}
                  className={`filter-btn ${warningFilter === code ? "filter-btn--active" : ""}`}
                  onClick={() => setWarningFilter(code)}
                >
                  {getWarningConfig(code).label}
                </button>
              ))}
            </div>
            <div className="modal__content modal__content--scrollable">
              {snapshot.warnings
                .filter((w) => warningFilter === null || w.code === warningFilter)
                .map((w, i) => {
                  const config = getWarningConfig(w.code);
                  return (
                  <div key={i} className={`warning-item warning-item--${w.severity}`}>
                    <div className="warning-item__header">
                      <span
                        className="warning-item__code"
                        style={{ background: config.color }}
                      >
                        {config.label}
                      </span>
                      <span className={`warning-item__severity warning-item__severity--${w.severity}`}>
                        {w.severity}
                      </span>
                    </div>
                    <div className="warning-item__message">{w.message}</div>
                  </div>
                  );
                })}
              {snapshot.warnings.filter((w) => warningFilter === null || w.code === warningFilter).length === 0 && (
                <div className="modal__empty">No warnings match the filter</div>
              )}
            </div>
            <div className="modal__footer" style={{ display: "flex", justifyContent: "space-between" }}>
              <button className="btn-secondary" onClick={() => setShowWarnings(false)}>
                Close
              </button>
              <button
                className="btn-secondary"
                onClick={() => selectedPin && handleFetch(selectedPin.localPath)}
                disabled={fetching || !selectedPin}
              >
                {fetching ? "Fetching..." : "↻ Fetch"}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Delete Confirmation Modal */}
      {deletingPinId && (
        <div className="modal-overlay" onClick={() => setDeletingPinId(null)}>
          <div className="modal modal--small" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>プロジェクトを削除</h2>
            </div>
            <div className="modal__body">
              <p style={{ margin: 0, color: "#9ca3af" }}>
                「{repoPins.find(p => p.id === deletingPinId)?.label || repoPins.find(p => p.id === deletingPinId)?.repoId}」を削除しますか？
              </p>
              <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280" }}>
                ※ローカルのファイルは削除されません
              </p>
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setDeletingPinId(null)}>
                キャンセル
              </button>
              <button className="btn-danger" onClick={handleConfirmDeletePin}>
                削除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Branch Modal */}
      {createBranchBase && (
        <div className="modal-overlay" onClick={() => setCreateBranchBase(null)}>
          <div className="modal modal--small" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>ブランチ作成</h2>
            </div>
            <div className="modal__body">
              <p style={{ margin: "0 0 12px", color: "#9ca3af", fontSize: 13 }}>
                ベース: <code style={{ background: "#1f2937", padding: "2px 6px", borderRadius: 4 }}>{createBranchBase}</code>
              </p>
              <input
                type="text"
                value={createBranchName}
                onChange={(e) => setCreateBranchName(e.target.value)}
                placeholder="新しいブランチ名"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  background: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: 6,
                  color: "#e5e7eb",
                  fontSize: 14,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && createBranchName.trim() && !createBranchLoading) {
                    handleCreateBranch();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setCreateBranchBase(null)}>
                キャンセル
              </button>
              <button
                className="btn-primary"
                disabled={!createBranchName.trim() || createBranchLoading}
                onClick={handleCreateBranch}
              >
                {createBranchLoading ? "作成中..." : "作成"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .dashboard {
          min-height: 100vh;
          background: #0f172a;
        }
        .dashboard--with-sidebar {
          display: flex;
        }

        /* Sidebar styles */
        .sidebar {
          width: 280px;
          min-width: 280px;
          background: #111827;
          border-right: 1px solid #374151;
          display: flex;
          flex-direction: column;
          height: 100vh;
          position: sticky;
          top: 0;
          overflow-y: auto;
        }
        .sidebar__header {
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .sidebar__header h1 {
          margin: 0;
          font-size: 18px;
          color: #e5e7eb;
        }
        .sidebar__back {
          background: none;
          border: none;
          color: #9ca3af;
          font-size: 13px;
          cursor: pointer;
          padding: 0;
        }
        .sidebar__back:hover {
          color: #e5e7eb;
        }
        .sidebar__project-name {
          font-weight: 600;
          font-size: 16px;
          margin-bottom: 4px;
        }
        .sidebar__section {
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .sidebar__section h3 {
          margin: 0 0 10px;
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
        }
        .sidebar__section--bottom {
          border-bottom: none;
        }
        .sidebar__spacer {
          flex: 1;
        }
        .sidebar__path {
          font-size: 11px;
          color: #6b7280;
          margin-top: 8px;
          word-break: break-all;
          font-family: monospace;
        }
        .sidebar__btn {
          width: 100%;
          padding: 10px 16px;
          border: 1px solid #374151;
          border-radius: 6px;
          background: #111827;
          color: #e5e7eb;
          cursor: pointer;
          font-size: 14px;
          margin-bottom: 8px;
        }
        .sidebar__btn:hover {
          background: #0f172a;
        }
        .sidebar__btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .sidebar__btn--primary {
          background: #0066cc;
          color: white;
          border-color: #0066cc;
        }
        .sidebar__btn--primary:hover {
          background: #0052a3;
        }
        .sidebar__btn--primary:disabled {
          background: #4b5563;
          border-color: #4b5563;
        }
        .sidebar__menu {
          padding: 8px 12px;
          border-bottom: 1px solid #374151;
        }
        .sidebar__menu-item {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: #9ca3af;
          cursor: pointer;
          font-size: 14px;
          text-align: left;
          transition: all 0.15s;
        }
        .sidebar__menu-item:hover {
          background: #1f2937;
          color: #e5e7eb;
        }
        .sidebar__menu-item--active {
          background: #1f2937;
          color: #60a5fa;
        }
        .sidebar__menu-icon {
          font-size: 16px;
        }
        .sidebar__plan {
          font-size: 13px;
        }
        .sidebar__plan strong {
          display: block;
          margin-bottom: 4px;
        }
        .sidebar__plan a {
          color: #0066cc;
          font-size: 12px;
        }
        .sidebar__warnings-btn {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 12px;
          background: #422006;
          border: 1px solid #f59e0b;
          border-radius: 6px;
          color: #fbbf24;
          cursor: pointer;
          font-size: 13px;
          transition: all 0.2s;
        }
        .sidebar__warnings-btn:hover {
          background: #713f12;
        }
        .sidebar__warnings-icon {
          font-size: 14px;
        }
        .sidebar__warnings-count {
          background: #f59e0b;
          color: #422006;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 600;
        }
        .sidebar__worktrees {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 200px;
          overflow-y: auto;
        }
        .sidebar__worktree {
          display: flex;
          flex-direction: column;
          padding: 8px 10px;
          background: #1e293b;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s;
        }
        .sidebar__worktree:hover {
          background: #334155;
        }
        .sidebar__worktree--selected {
          background: #1e3a5f;
          border-color: #3b82f6;
        }
        .sidebar__worktree--active {
          background: #14532d;
          border-left: 3px solid #22c55e;
        }
        .sidebar__worktree-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
        }
        .sidebar__worktree-name {
          font-family: monospace;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          display: flex;
          align-items: center;
          gap: 6px;
          flex: 1;
        }
        .sidebar__worktree-delete {
          padding: 2px 6px;
          background: transparent;
          border: none;
          color: #6b7280;
          font-size: 14px;
          cursor: pointer;
          border-radius: 3px;
          opacity: 0;
          transition: all 0.15s;
        }
        .sidebar__worktree:hover .sidebar__worktree-delete {
          opacity: 1;
        }
        .sidebar__worktree-delete:hover {
          background: #7f1d1d;
          color: #fca5a5;
        }
        .sidebar__worktree-dirty {
          color: #f59e0b;
          font-size: 8px;
        }
        .sidebar__worktree-branch {
          font-family: monospace;
          font-size: 10px;
          color: #9ca3af;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sidebar__worktree-terminal {
          padding: 2px 8px;
          background: #1a1b26;
          color: white;
          border: none;
          border-radius: 3px;
          font-size: 12px;
          cursor: pointer;
        }
        .sidebar__worktree-terminal:hover {
          background: #24283b;
        }

        /* Repo selector in sidebar */
        .repo-selector {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        .repo-selector select {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
        }
        .add-repo-form {
          margin-top: 10px;
        }
        .add-repo-form input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
          margin-bottom: 8px;
        }
        .add-repo-form__buttons {
          display: flex;
          gap: 8px;
        }
        .add-repo-form__buttons button {
          flex: 1;
          padding: 6px 12px;
          border: 1px solid #374151;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          background: #111827;
        }
        .add-repo-form__buttons button:first-child {
          background: #0066cc;
          color: white;
          border-color: #0066cc;
        }
        .btn-delete {
          padding: 4px 8px;
          background: #7f1d1d;
          color: #f87171;
          border: 1px solid #991b1b;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
        }

        /* Main content area */
        .main-content {
          flex: 1;
          padding: 20px;
          overflow-y: auto;
        }
        .dashboard__error {
          background: #7f1d1d;
          color: #f87171;
          padding: 12px 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #9ca3af;
        }
        .empty-state h2 {
          margin: 0 0 8px;
          font-size: 18px;
          color: #e5e7eb;
        }
        .empty-state p {
          margin: 0;
          font-size: 14px;
        }
        .loading-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 80px 20px;
          color: #9ca3af;
        }
        .loading-state__spinner {
          margin-bottom: 16px;
        }
        .loading-state p {
          font-size: 14px;
          margin: 0;
        }
        .spinner--large {
          width: 48px;
          height: 48px;
          border-width: 4px;
        }

        /* Tree view layout - top/bottom split */
        .tree-view {
          display: flex;
          flex-direction: column;
          gap: 8px;
          height: calc(100vh - 40px);
        }
        .tree-view__top {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 360px;
          gap: 16px;
          min-height: 0;
          overflow: hidden;
        }
        .tree-view__graph {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .tree-view__details {
          display: flex;
          flex-direction: column;
          gap: 16px;
          overflow-y: auto;
        }
        .tree-view__bottom {
          min-height: 350px;
          overflow: hidden;
        }
        .tree-view__resize-handle {
          flex: 0 0 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: ns-resize;
          margin: -8px 0;
          z-index: 10;
        }
        .tree-view__resize-bar {
          width: 60px;
          height: 4px;
          background: #4b5563;
          border-radius: 2px;
          transition: background 0.15s;
        }
        .tree-view__resize-handle:hover .tree-view__resize-bar,
        .tree-view__resize-handle--active .tree-view__resize-bar {
          background: #3b82f6;
        }
        .sessions-container {
          height: 100%;
          overflow: hidden;
        }

        /* Graph container */
        .panel--graph {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: flex 0.2s ease;
        }
        .graph-container {
          flex: 1;
          overflow: auto;
          overscroll-behavior: contain;
          background: #1f2937;
          border-radius: 4px;
          min-height: 150px;
        }
        .branch-graph {
          min-width: fit-content;
        }
        .branch-graph--empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 200px;
          color: #6b7280;
        }
        .branch-graph__svg {
          display: block;
        }
        .panel {
          background: #111827;
          border: 1px solid #374151;
          border-radius: 8px;
          padding: 16px;
        }
        .panel--warnings {
          border-color: #f59e0b;
        }
        .panel--planning {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: transparent;
          border: none;
          padding: 0;
          transition: flex 0.2s ease;
        }
        .panel--planning-collapsed {
          flex: 0 0 auto;
        }
        .planning-panel__layout {
          flex: 1;
          display: flex;
          gap: 16px;
          min-height: 0;
          overflow: hidden;
        }
        .planning-panel__chat {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .planning-panel__tree {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        /* External Links */
        .external-links {
          flex-shrink: 0;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid #374151;
        }
        .external-links__header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .external-links__title {
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
        }
        .external-links__count {
          font-size: 11px;
          background: #374151;
          padding: 1px 6px;
          border-radius: 10px;
          color: #9ca3af;
        }
        .external-links__add {
          display: flex;
          gap: 6px;
          margin-bottom: 8px;
        }
        .external-links__add input {
          flex: 1;
          padding: 6px 10px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 12px;
        }
        .external-links__add button {
          padding: 6px 12px;
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          cursor: pointer;
        }
        .external-links__add button:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .external-links__list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .external-link-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 8px;
          background: #0f172a;
          border-radius: 4px;
          font-size: 12px;
        }
        .external-link-item__type {
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          color: white;
          flex-shrink: 0;
        }
        .external-link-item__type--notion { background: #000; }
        .external-link-item__type--figma { background: #f24e1e; }
        .external-link-item__type--github_issue { background: #238636; }
        .external-link-item__type--github_pr { background: #8957e5; }
        .external-link-item__type--url { background: #666; }
        .external-link-item__title {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #e5e7eb;
          text-decoration: none;
        }
        .external-link-item__title:hover {
          text-decoration: underline;
        }
        .external-link-item__refresh,
        .external-link-item__remove {
          width: 20px;
          height: 20px;
          border: none;
          background: transparent;
          cursor: pointer;
          font-size: 12px;
          color: #6b7280;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 3px;
        }
        .external-link-item__refresh:hover {
          background: #374151;
          color: #2196f3;
        }
        .external-link-item__remove:hover {
          background: #ffebee;
          color: #f44336;
        }
        .task-tree-panel__settings {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid #374151;
        }
        .task-tree-panel__settings label {
          font-size: 13px;
          color: #9ca3af;
        }
        .task-tree-panel__settings select {
          flex: 1;
          padding: 6px 8px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
        }
        .task-tree-panel__add {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        .task-tree-panel__add input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
        }
        .task-tree-panel__add button {
          padding: 8px 16px;
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .task-tree-panel__add button:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .task-tree-panel__settings,
        .task-tree-panel__add {
          flex-shrink: 0;
        }
        .task-tree-panel__content {
          flex: 1;
          display: flex;
          gap: 16px;
          min-height: 0;
          overflow: hidden;
        }
        .task-tree-panel__tree {
          flex: 2;
          padding: 12px;
          background: #1f2937;
          border: 2px dashed #374151;
          border-radius: 8px;
          overflow-y: auto;
        }
        .task-tree-panel__backlog {
          flex: 1;
          padding: 12px;
          background: #422006;
          border: 2px dashed #a16207;
          border-radius: 8px;
          overflow-y: auto;
        }
        .tree-label, .backlog-label {
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
          margin-bottom: 8px;
          padding-bottom: 6px;
          border-bottom: 1px solid #374151;
        }
        .tree-empty {
          font-size: 12px;
          color: #6b7280;
          text-align: center;
          padding: 20px;
        }
        .task-tree-panel__actions {
          flex-shrink: 0;
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #374151;
          align-items: center;
        }
        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          cursor: pointer;
          padding: 4px 8px;
          background: #0f172a;
          border-radius: 4px;
        }
        .checkbox-label:hover {
          background: #4b5563;
        }
        .checkbox-label input {
          cursor: pointer;
        }
        .btn-primary {
          padding: 8px 16px;
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-primary:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .btn-secondary {
          padding: 8px 16px;
          background: #111827;
          color: #e5e7eb;
          border: 1px solid #374151;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-secondary:hover {
          background: #0f172a;
        }
        .status-badge {
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
        }
        .status-badge--draft {
          background: #374151;
          color: #9ca3af;
        }
        .status-badge--confirmed {
          background: #422006;
          color: #fb923c;
        }
        .status-badge--generated {
          background: #14532d;
          color: #4ade80;
        }
        .panel--restart {
          background: #1e3a5f;
          border-color: #1e40af;
        }
        .panel--placeholder {
          color: #6b7280;
          text-align: center;
          padding: 40px;
        }
        .panel__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        .panel__header h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
        }
        .panel__count {
          font-size: 12px;
          color: #9ca3af;
        }
        .tree-list {
          font-family: monospace;
          font-size: 13px;
        }
        .tree-node {
          padding: 8px 12px;
          margin-bottom: 4px;
          background: #1f2937;
          border-radius: 4px;
          cursor: pointer;
          border-left: 3px solid transparent;
        }
        .tree-node:hover {
          background: #374151;
        }
        .tree-node--selected {
          background: #1e3a5f;
          border-left-color: #0066cc;
        }
        .tree-node--active {
          border-left-color: #28a745;
        }
        .tree-node__header {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .tree-node__name {
          font-weight: 600;
        }
        .tree-node__badge {
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 10px;
          font-weight: 500;
        }
        .tree-node__badge--designed {
          background: #9c27b0;
          color: white;
        }
        .tree-node__badge--agent {
          background: #28a745;
          color: white;
        }
        .tree-node__badge--dirty {
          background: #ff9800;
          color: white;
        }
        .tree-node__badge--pr {
          background: #2196F3;
          color: white;
        }
        .tree-node__badge--open {
          background: #28a745;
        }
        .tree-node__badge--closed {
          background: #6c757d;
        }
        .tree-node__badge--merged {
          background: #9c27b0;
        }
        .tree-node__badge--draft {
          background: #6c757d;
          color: white;
        }
        .tree-node__badge--review {
          font-weight: bold;
        }
        .tree-node__badge--approved {
          background: #28a745;
          color: white;
        }
        .tree-node__badge--changes_requested {
          background: #dc3545;
          color: white;
        }
        .tree-node__badge--ci {
          font-weight: bold;
        }
        .tree-node__badge--success {
          background: #28a745;
          color: white;
        }
        .tree-node__badge--failure {
          background: #dc3545;
          color: white;
        }
        .tree-node__badge--pending {
          background: #ffc107;
          color: black;
        }
        .tree-node__meta {
          display: flex;
          gap: 8px;
          margin-top: 4px;
          font-size: 11px;
          color: #9ca3af;
        }
        .tree-node__stat {
          font-family: monospace;
        }
        .tree-node__changes {
          color: #28a745;
        }
        .tree-node__label {
          background: #374151;
          padding: 1px 4px;
          border-radius: 2px;
        }
        .warning {
          padding: 8px;
          margin-bottom: 8px;
          border-radius: 4px;
          font-size: 13px;
        }
        .warning--warn {
          background: #422006;
        }
        .warning--error {
          background: #7f1d1d;
        }
        .detail-section {
          margin-bottom: 16px;
        }
        .detail-section h4 {
          margin: 0 0 8px;
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
        }
        .detail-section a {
          color: #0066cc;
          text-decoration: none;
        }
        .detail-section a:hover {
          text-decoration: underline;
        }
        .detail-section code {
          display: block;
          background: #0f172a;
          padding: 8px;
          border-radius: 4px;
          font-size: 12px;
          word-break: break-all;
        }
        .detail-section label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .detail-row {
          font-size: 13px;
          margin-top: 4px;
        }
        .copy-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .copy-row code {
          flex: 1;
        }
        .copy-row button {
          padding: 4px 12px;
          background: #374151;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .restart-prompt {
          background: #111827;
          padding: 12px;
          border-radius: 4px;
          font-size: 11px;
          max-height: 200px;
          overflow: auto;
          white-space: pre-wrap;
          margin: 8px 0;
        }
        .panel textarea {
          width: 100%;
          min-height: 80px;
          padding: 8px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-family: inherit;
          font-size: 13px;
          resize: vertical;
          margin-bottom: 8px;
        }
        .btn-primary {
          padding: 8px 16px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn-primary:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .btn-chat-small {
          padding: 2px 8px;
          background: #6c5ce7;
          color: white;
          border: none;
          border-radius: 3px;
          font-size: 10px;
          cursor: pointer;
          margin-left: auto;
        }
        .btn-chat-small:hover {
          background: #5b4cdb;
        }
        .chat-panel {
          position: fixed;
          right: 20px;
          bottom: 20px;
          width: 450px;
          max-height: 600px;
          background: #111827;
          border: 1px solid #374151;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          display: flex;
          flex-direction: column;
          z-index: 1000;
        }
        .chat-panel__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 12px 16px;
          background: #6c5ce7;
          color: white;
          border-radius: 12px 12px 0 0;
        }
        .chat-panel__title h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
        }
        .chat-panel__path {
          font-size: 11px;
          opacity: 0.8;
          display: block;
          margin-top: 2px;
        }
        .chat-panel__actions button {
          background: rgba(255,255,255,0.2);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .chat-panel__actions button:hover {
          background: rgba(255,255,255,0.3);
        }
        .chat-panel__messages {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
          max-height: 400px;
          background: #1f2937;
        }
        .chat-panel__empty {
          color: #6b7280;
          text-align: center;
          padding: 40px 20px;
          font-size: 13px;
        }
        .chat-message {
          margin-bottom: 12px;
          padding: 10px 12px;
          border-radius: 8px;
          max-width: 90%;
        }
        .chat-message--user {
          background: #6c5ce7;
          color: white;
          margin-left: auto;
        }
        .chat-message--assistant {
          background: #111827;
          border: 1px solid #374151;
        }
        .chat-message--system {
          background: #fff3cd;
          border: 1px solid #ffc107;
          font-size: 12px;
        }
        .chat-message--loading {
          background: #4b5563;
          color: #9ca3af;
        }
        .chat-message__role {
          font-size: 10px;
          font-weight: 600;
          margin-bottom: 4px;
          opacity: 0.7;
        }
        .chat-message--user .chat-message__role {
          color: rgba(255,255,255,0.8);
        }
        .chat-message__content {
          font-size: 13px;
          line-height: 1.5;
        }
        .chat-message__content pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: inherit;
        }
        .chat-message__time {
          font-size: 10px;
          margin-top: 4px;
          opacity: 0.6;
          text-align: right;
        }
        .chat-panel__input {
          display: flex;
          gap: 8px;
          padding: 12px;
          border-top: 1px solid #374151;
          background: #111827;
          border-radius: 0 0 12px 12px;
        }
        .chat-panel__input textarea {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 8px;
          font-size: 13px;
          font-family: inherit;
          resize: none;
          min-height: 40px;
          max-height: 100px;
        }
        .chat-panel__input textarea:focus {
          outline: none;
          border-color: #6c5ce7;
        }
        .chat-panel__input button {
          padding: 10px 20px;
          background: #6c5ce7;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 500;
        }
        .chat-panel__input button:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .chat-panel__input button:hover:not(:disabled) {
          background: #5b4cdb;
        }
        .chat-panel__terminal-btn {
          font-size: 16px;
          margin-right: 4px;
        }
        .chat-panel__actions {
          display: flex;
          gap: 4px;
        }
        /* Planning Chat Loading */
        .planning-chat-loading,
        .planning-chat-placeholder {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: #9ca3af;
          font-size: 14px;
        }
        /* Terminal Panel */
        .terminal-panel {
          position: fixed;
          left: 20px;
          bottom: 20px;
          width: 700px;
          height: 450px;
          z-index: 1000;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          border-radius: 8px;
          overflow: hidden;
        }
        .panel__header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .btn-wizard {
          padding: 4px 10px;
          background: #9c27b0;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
        }
        .btn-wizard:hover {
          background: #7b1fa2;
        }
        .wizard-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2000;
        }
        .wizard-modal {
          background: #111827;
          border-radius: 12px;
          width: 500px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
        .wizard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .wizard-header h2 {
          margin: 0;
          font-size: 18px;
        }
        .wizard-header button {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #9ca3af;
        }
        .wizard-content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        .wizard-section {
          margin-bottom: 20px;
        }
        .wizard-section h3 {
          margin: 0 0 12px;
          font-size: 14px;
          font-weight: 600;
          color: #e5e7eb;
        }
        .wizard-nodes {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .wizard-node {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: #0f172a;
          border-radius: 6px;
        }
        .wizard-node__name {
          font-family: monospace;
          font-weight: 600;
        }
        .wizard-node__parent {
          font-size: 12px;
          color: #9ca3af;
        }
        .wizard-node__remove {
          margin-left: auto;
          background: #7f1d1d;
          color: #f87171;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .wizard-add-form {
          display: flex;
          gap: 8px;
        }
        .wizard-add-form input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-add-form select {
          padding: 8px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-add-form button {
          padding: 8px 16px;
          background: #9c27b0;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }
        .wizard-add-form button:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .wizard-base-select {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-tasks {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-height: 300px;
          overflow-y: auto;
        }
        .wizard-task {
          padding: 12px;
          background: #0f172a;
          border-radius: 8px;
          border-left: 4px solid #9e9e9e;
        }
        .wizard-task--todo {
          border-left-color: #9e9e9e;
        }
        .wizard-task--doing {
          border-left-color: #2196f3;
          background: #1e3a5f;
        }
        .wizard-task--done {
          border-left-color: #4caf50;
          background: #14532d;
        }
        .wizard-task__header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .wizard-task__status {
          padding: 4px 8px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 12px;
          background: #111827;
        }
        .wizard-task__title {
          flex: 1;
          font-weight: 600;
          font-size: 14px;
        }
        .wizard-task__start {
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 12px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        .wizard-task__start:hover {
          background: #45a049;
        }
        .wizard-task__start:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .wizard-task__remove {
          background: #7f1d1d;
          color: #f87171;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .wizard-task__description {
          margin-top: 6px;
          font-size: 12px;
          color: #9ca3af;
          padding-left: 8px;
        }
        .wizard-task__meta {
          display: flex;
          gap: 12px;
          margin-top: 8px;
          font-size: 11px;
          color: #6b7280;
        }
        .wizard-task__parent {
          font-style: italic;
        }
        .wizard-task__branch {
          font-family: monospace;
          background: #374151;
          padding: 1px 4px;
          border-radius: 3px;
        }
        .wizard-task__worktree {
          background: #4caf50;
          color: white;
          padding: 1px 6px;
          border-radius: 3px;
          font-weight: 500;
        }

        /* Tree Builder styles */
        .wizard-modal--wide {
          width: 900px;
          max-width: 95vw;
        }
        .wizard-header__controls {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .wizard-base-select-inline {
          padding: 6px 10px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
        }
        .tree-builder {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          min-height: 400px;
        }
        .tree-builder--locked {
          opacity: 0.8;
          pointer-events: none;
        }
        .tree-builder--locked .task-card {
          cursor: default;
        }
        .tree-builder__backlog,
        .tree-builder__tree {
          display: flex;
          flex-direction: column;
          background: #1f2937;
          border-radius: 8px;
          padding: 12px;
        }
        .tree-builder__backlog h3,
        .tree-builder__tree h3 {
          margin: 0 0 12px;
          font-size: 14px;
          color: #9ca3af;
        }
        .tree-builder__backlog-list,
        .tree-builder__tree-content {
          flex: 1;
          min-height: 200px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .tree-builder__tree-root {
          flex: 1;
          display: flex;
          flex-direction: column;
        }
        .tree-builder__base-branch {
          padding: 8px 12px;
          background: #2196f3;
          color: white;
          border-radius: 6px;
          font-family: monospace;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .tree-builder__empty {
          padding: 40px 20px;
          text-align: center;
          color: #6b7280;
          border: 2px dashed #374151;
          border-radius: 8px;
          font-size: 13px;
        }
        .tree-builder__add-form {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #374151;
        }
        .tree-builder__add-form input {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 13px;
        }
        .tree-builder__add-form button {
          padding: 8px 16px;
          background: #4caf50;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        .tree-builder__add-form button:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .tree-builder__node {
          margin-bottom: 4px;
        }
        .tree-builder__children {
          border-left: 2px solid #374151;
          margin-left: 12px;
          padding-left: 8px;
        }

        /* Task Card styles */
        .task-card {
          background: #111827;
          border-radius: 8px;
          padding: 10px 12px;
          border-left: 4px solid #9e9e9e;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .task-card--todo {
          border-left-color: #9e9e9e;
        }
        .task-card--doing {
          border-left-color: #2196f3;
          background: #1e3a5f;
        }
        .task-card--done {
          border-left-color: #4caf50;
          background: #14532d;
        }
        .task-card--compact {
          padding: 6px 10px;
        }
        .task-card--dragging {
          background: #111827;
          padding: 10px 12px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          font-weight: 600;
        }
        .task-card__header {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .task-card__status {
          padding: 2px 6px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 11px;
          background: #111827;
        }
        .task-card__title {
          flex: 1;
          font-weight: 600;
          font-size: 13px;
        }
        .task-card__actions {
          display: flex;
          gap: 4px;
        }
        .task-card__start {
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .task-card__start:disabled {
          background: #4b5563;
        }
        .task-card__remove {
          background: #7f1d1d;
          color: #f87171;
          border: none;
          border-radius: 4px;
          padding: 2px 6px;
          cursor: pointer;
          font-size: 14px;
        }
        .task-card__description {
          margin-top: 6px;
          font-size: 12px;
          color: #9ca3af;
        }
        .task-card__meta {
          display: flex;
          gap: 8px;
          margin-top: 6px;
          font-size: 10px;
        }
        .task-card__branch {
          font-family: monospace;
          background: #374151;
          padding: 1px 4px;
          border-radius: 3px;
        }
        .task-card__worktree {
          background: #4caf50;
          color: white;
          padding: 1px 4px;
          border-radius: 3px;
          font-weight: 600;
        }
        .task-card--clickable {
          cursor: pointer;
          border: 2px solid transparent;
        }
        .task-card--clickable:hover {
          border-color: #2196f3;
        }
        .task-card__open {
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .task-card__open:hover {
          background: #1976d2;
        }
        .task-card__claude {
          background: linear-gradient(135deg, #d97706 0%, #ea580c 100%);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 3px 10px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 4px;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }
        .task-card__claude:hover {
          background: linear-gradient(135deg, #b45309 0%, #c2410c 100%);
          transform: translateY(-1px);
          box-shadow: 0 2px 4px rgba(0,0,0,0.15);
        }
        .task-card__claude svg {
          flex-shrink: 0;
        }

        /* Generation logs */
        .generate-logs {
          margin: 12px 0;
          border: 1px solid #374151;
          border-radius: 8px;
          background: #1e1e1e;
          color: #d4d4d4;
          font-family: monospace;
          font-size: 12px;
        }
        .generate-logs__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: #2d2d2d;
          border-radius: 8px 8px 0 0;
        }
        .generate-logs__header h4 {
          margin: 0;
          font-size: 12px;
          color: #fff;
        }
        .generate-logs__header button {
          background: none;
          border: none;
          color: #6b7280;
          cursor: pointer;
          font-size: 16px;
        }
        .generate-logs__content {
          padding: 12px;
          max-height: 200px;
          overflow-y: auto;
        }
        .generate-logs__line {
          padding: 2px 0;
        }
        .generate-logs__line--success {
          color: #4caf50;
        }
        .generate-logs__line--error {
          color: #f44336;
        }

        /* Droppable zone styles */
        .droppable-zone {
          transition: background 0.2s;
          border-radius: 6px;
        }
        .droppable-zone--over {
          background: rgba(33, 150, 243, 0.1);
          outline: 2px dashed #2196f3;
        }

        .wizard-empty {
          text-align: center;
          color: #6b7280;
          padding: 20px;
          font-size: 13px;
        }
        .wizard-add-form--vertical {
          flex-direction: column;
        }
        .wizard-add-form--vertical input {
          flex: none;
          width: 100%;
        }
        .wizard-add-row {
          display: flex;
          gap: 8px;
        }
        .wizard-add-row select {
          flex: 1;
        }
        .wizard-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid #374151;
        }
        .wizard-footer__left {
          display: flex;
          align-items: center;
        }
        .wizard-footer__right {
          display: flex;
          gap: 12px;
        }
        .wizard-status {
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
        }
        .wizard-status--draft {
          background: #422006;
          color: #fb923c;
        }
        .wizard-status--confirmed {
          background: #1e3a5f;
          color: #1565c0;
        }
        .wizard-status--generated {
          background: #14532d;
          color: #4ade80;
        }
        .wizard-locked-notice {
          background: #422006;
          color: #fb923c;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 12px;
          text-align: center;
          margin-bottom: 12px;
        }
        .btn-secondary {
          padding: 10px 20px;
          background: #0f172a;
          color: #e5e7eb;
          border: 1px solid #374151;
          border-radius: 6px;
          cursor: pointer;
        }
        .btn-secondary:hover {
          background: #4b5563;
        }
        .btn-create-all {
          padding: 10px 20px;
          background: #ff9800;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }
        .btn-create-all:hover {
          background: #f57c00;
        }
        .btn-create-all:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }

        /* Modal styles */
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2000;
        }
        .modal {
          background: #111827;
          border-radius: 12px;
          width: 500px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
        .modal__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .modal__header h2 {
          margin: 0;
          font-size: 18px;
        }
        .modal__header button {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #9ca3af;
        }
        .modal__content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        .modal__loading {
          text-align: center;
          padding: 40px;
          color: #9ca3af;
        }
        .modal__error {
          color: #f87171;
          text-align: center;
          padding: 20px;
        }
        .modal__success {
          background: #14532d;
          color: #4ade80;
          padding: 12px 16px;
          border-radius: 6px;
          margin-bottom: 16px;
          text-align: center;
        }
        .modal__footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid #374151;
        }
        .modal--small {
          width: 360px;
        }
        .modal--warnings {
          width: 600px;
          max-height: 80vh;
        }
        .modal__filters {
          display: flex;
          gap: 8px;
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .filter-btn {
          padding: 6px 12px;
          background: #1f2937;
          border: 1px solid #374151;
          border-radius: 4px;
          color: #9ca3af;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .filter-btn:hover {
          background: #374151;
          color: #e5e7eb;
        }
        .filter-btn--active {
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
        }
        .modal__content--scrollable {
          max-height: 400px;
          overflow-y: auto;
        }
        .modal__empty {
          padding: 40px 20px;
          text-align: center;
          color: #6b7280;
        }
        .warning-item {
          padding: 14px 20px;
          border-bottom: 1px solid #374151;
        }
        .warning-item:last-child {
          border-bottom: none;
        }
        .warning-item__header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .warning-item__code {
          font-size: 13px;
          font-weight: 600;
          color: white;
          padding: 4px 12px;
          border-radius: 12px;
        }
        .warning-item__severity {
          font-size: 11px;
          font-weight: 600;
          padding: 3px 8px;
          border-radius: 4px;
        }
        .warning-item__severity--warn {
          background: #422006;
          color: #fbbf24;
        }
        .warning-item__severity--error {
          background: #450a0a;
          color: #f87171;
        }
        .warning-item__message {
          font-size: 14px;
          color: #e5e7eb;
          line-height: 1.5;
        }
        .modal__body {
          padding: 20px;
        }
        .btn-danger {
          background: #dc2626;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }
        .btn-danger:hover {
          background: #b91c1c;
        }

        /* Settings styles */
        .settings-section {
          margin-bottom: 20px;
        }
        .settings-section label {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: #9ca3af;
          margin-bottom: 8px;
        }
        .settings-section p {
          font-size: 12px;
          margin: 0;
          color: #6b7280;
        }
        .settings-section input[type="text"] {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
        }
        .settings-section textarea {
          width: 100%;
          min-height: 80px;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
          font-family: inherit;
          resize: vertical;
        }
        .settings-section small {
          display: block;
          margin-top: 4px;
          font-size: 11px;
          color: #6b7280;
        }
        .settings-examples {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 10px;
        }
        .settings-example {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          background: #374151;
          border-radius: 4px;
          font-size: 12px;
        }
        .settings-example code {
          font-family: monospace;
        }
        .settings-example button {
          background: none;
          border: none;
          color: #f87171;
          cursor: pointer;
          padding: 0 4px;
          font-size: 14px;
        }
        .settings-add-example {
          display: flex;
          gap: 8px;
        }
        .settings-add-example input {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
        }
        .settings-add-example button {
          padding: 8px 16px;
          background: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }

        /* Terminal button in details panel */
        .btn-terminal {
          margin-top: 8px;
          padding: 8px 16px;
          background: #1a1b26;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-terminal:hover {
          background: #24283b;
        }

        .spinner {
          width: 24px;
          height: 24px;
          border: 3px solid #374151;
          border-top-color: #2196f3;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
