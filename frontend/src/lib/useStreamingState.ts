/**
 * Single source of truth for streaming (thinking) state.
 * All components should use this hook instead of listening to WebSocket events directly.
 */
import { useState, useEffect } from "react";
import { wsClient } from "./ws";
import { api } from "./api";

// Global state - single source of truth
const streamingState = new Map<string, boolean>();
const listeners = new Set<() => void>();
const fetchedSessions = new Set<string>(); // Track which sessions we've fetched initial state for
let initialized = false;

function initializeListeners() {
  if (initialized) return;
  initialized = true;

  console.log("[useStreamingState] Initializing global WebSocket listeners");

  wsClient.on("chat.streaming.start", (msg) => {
    const data = msg.data as { sessionId: string };
    console.log("[useStreamingState] streaming.start received:", data);
    if (data?.sessionId) {
      streamingState.set(data.sessionId, true);
      console.log("[useStreamingState] Set streaming=true for", data.sessionId, "listeners:", listeners.size);
      notifyListeners();
    }
  });

  wsClient.on("chat.streaming.end", (msg) => {
    const data = msg.data as { sessionId: string };
    console.log("[useStreamingState] streaming.end received:", data);
    if (data?.sessionId) {
      streamingState.set(data.sessionId, false);
      console.log("[useStreamingState] Set streaming=false for", data.sessionId);
      notifyListeners();
    }
  });
}

// Fetch initial state from API for a session
async function fetchInitialState(sessionId: string) {
  if (fetchedSessions.has(sessionId)) return;
  fetchedSessions.add(sessionId);

  try {
    const state = await api.getStreamingState(sessionId);
    console.log("[useStreamingState] Fetched initial state for", sessionId, ":", state.isStreaming);
    // Only update if we don't have a more recent WebSocket update
    if (!streamingState.has(sessionId)) {
      streamingState.set(sessionId, state.isStreaming);
      notifyListeners();
    }
  } catch (err) {
    console.error("[useStreamingState] Failed to fetch initial state:", err);
  }
}

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

/**
 * Hook to get streaming (thinking) state for a specific session.
 * This is the ONLY source of truth for whether Claude is thinking.
 */
export function useIsStreaming(sessionId: string | null | undefined): boolean {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    initializeListeners();

    const listener = () => forceUpdate({});
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Fetch initial state from API when sessionId changes
  useEffect(() => {
    if (sessionId) {
      fetchInitialState(sessionId);
    }
  }, [sessionId]);

  return sessionId ? (streamingState.get(sessionId) ?? false) : false;
}

/**
 * Hook to get streaming state for multiple sessions at once.
 * Useful for tab bars and session lists.
 */
export function useStreamingStates(sessionIds: (string | null | undefined)[]): Map<string, boolean> {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    initializeListeners();

    const listener = () => forceUpdate({});
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Fetch initial state for all sessions
  useEffect(() => {
    sessionIds.forEach((id) => {
      if (id) {
        fetchInitialState(id);
      }
    });
  }, [sessionIds.filter(Boolean).join(",")]);

  const result = new Map<string, boolean>();
  sessionIds.forEach((id) => {
    if (id) {
      result.set(id, streamingState.get(id) ?? false);
    }
  });
  return result;
}

/**
 * Get current streaming state without subscribing to updates.
 * Useful for one-time checks.
 */
export function getStreamingState(sessionId: string): boolean {
  return streamingState.get(sessionId) ?? false;
}

/**
 * Manually set streaming state (for initial state from API).
 */
export function setStreamingState(sessionId: string, isStreaming: boolean) {
  streamingState.set(sessionId, isStreaming);
  notifyListeners();
}

/**
 * Check if any of the given sessions is streaming.
 */
export function useAnyStreaming(sessionIds: (string | null | undefined)[]): boolean {
  const states = useStreamingStates(sessionIds);
  for (const isStreaming of states.values()) {
    if (isStreaming) return true;
  }
  return false;
}
