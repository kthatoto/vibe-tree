/**
 * Single source of truth for streaming (thinking) state.
 * All components should use this hook instead of listening to WebSocket events directly.
 */
import { useState, useEffect, useCallback } from "react";
import { wsClient } from "./ws";

// Global state - single source of truth
const streamingState = new Map<string, boolean>();
const listeners = new Set<() => void>();
let initialized = false;

function initializeListeners() {
  if (initialized) return;
  initialized = true;

  wsClient.on("chat.streaming.start", (msg) => {
    const data = msg.data as { sessionId: string };
    if (data?.sessionId) {
      streamingState.set(data.sessionId, true);
      notifyListeners();
    }
  });

  wsClient.on("chat.streaming.end", (msg) => {
    const data = msg.data as { sessionId: string };
    if (data?.sessionId) {
      streamingState.set(data.sessionId, false);
      notifyListeners();
    }
  });
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
