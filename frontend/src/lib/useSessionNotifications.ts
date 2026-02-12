import { useState, useEffect, useCallback, useRef } from "react";
import { wsClient } from "./ws";
import { api, type ChatMessage } from "./api";
import { useStreamingStates, setStreamingState } from "./useStreamingState";

interface SessionNotification {
  unreadCount: number;
  isThinking: boolean;
  lastMessageAt: string | null;
}

type NotificationsMap = Map<string, SessionNotification>;

const STORAGE_KEY = "vibe-tree-last-seen";

function getLastSeenMap(): Map<string, string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return new Map(Object.entries(JSON.parse(stored)));
    }
  } catch {
    // Ignore parse errors
  }
  return new Map();
}

function setLastSeen(sessionId: string, timestamp: string) {
  const map = getLastSeenMap();
  map.set(sessionId, timestamp);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
}

export function useSessionNotifications(sessionIds: string[], activeSessionId?: string | null) {
  const [notifications, setNotifications] = useState<NotificationsMap>(new Map());
  const [initialized, setInitialized] = useState(false);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Use global streaming state as single source of truth for isThinking
  const streamingStates = useStreamingStates(sessionIds);

  // Initialize notification state for each session
  useEffect(() => {
    if (sessionIds.length === 0) {
      setNotifications(new Map());
      setInitialized(true);
      return;
    }

    const lastSeenMap = getLastSeenMap();

    // Fetch messages for each session to determine unread count
    Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          const messages = await api.getChatMessages(sessionId);
          const lastSeen = lastSeenMap.get(sessionId);
          const lastMessage = messages[messages.length - 1];

          // Count unread messages (assistant messages after lastSeen)
          let unreadCount = 0;
          if (lastSeen) {
            unreadCount = messages.filter(
              (m) => m.role === "assistant" && new Date(m.createdAt) > new Date(lastSeen)
            ).length;
          } else if (messages.length > 1) {
            // If never seen, all assistant messages except first are unread
            unreadCount = messages.filter((m) => m.role === "assistant").length - 1;
          }

          // Check if thinking (last message is from user) and set global streaming state
          const isThinking = lastMessage?.role === "user";
          // Initialize global streaming state
          setStreamingState(sessionId, isThinking);

          return {
            sessionId,
            notification: {
              unreadCount: Math.max(0, unreadCount),
              isThinking, // Still stored but will be overridden by global state in getNotification
              lastMessageAt: lastMessage?.createdAt || null,
            },
          };
        } catch {
          return {
            sessionId,
            notification: {
              unreadCount: 0,
              isThinking: false,
              lastMessageAt: null,
            },
          };
        }
      })
    ).then((results) => {
      const newMap = new Map<string, SessionNotification>();
      results.forEach(({ sessionId, notification }) => {
        newMap.set(sessionId, notification);
      });
      setNotifications(newMap);
      setInitialized(true);
    });
  }, [sessionIds.join(",")]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (!initialized) return;

    const unsubMessage = wsClient.on("chat.message", (msg) => {
      const data = msg.data as ChatMessage | undefined;
      if (!data || !sessionIds.includes(data.sessionId)) return;

      setNotifications((prev) => {
        const current = prev.get(data.sessionId) || {
          unreadCount: 0,
          isThinking: false,
          lastMessageAt: null,
        };

        const newNotification = {
          ...current,
          lastMessageAt: data.createdAt,
        };

        // Note: isThinking is now handled by global streaming state
        // Only handle unread count here
        if (data.role === "assistant") {
          // Increment unread count only if not the active session
          if (data.sessionId !== activeSessionIdRef.current) {
            newNotification.unreadCount = current.unreadCount + 1;
          }
        }

        return new Map(prev).set(data.sessionId, newNotification);
      });
    });

    // Note: streaming start/end is now handled by useStreamingState (global state)
    // No need to listen to chat.streaming.start/end here

    return () => {
      unsubMessage();
    };
  }, [initialized, sessionIds.join(",")]);

  // Mark session as seen
  const markAsSeen = useCallback((sessionId: string) => {
    const now = new Date().toISOString();
    setLastSeen(sessionId, now);
    setNotifications((prev) => {
      const current = prev.get(sessionId);
      if (!current) return prev;
      return new Map(prev).set(sessionId, {
        ...current,
        unreadCount: 0,
      });
    });
  }, []);

  // Get notification for a specific session
  // Uses global streaming state for isThinking (single source of truth)
  const getNotification = useCallback(
    (sessionId: string): SessionNotification => {
      const notification = notifications.get(sessionId) || {
        unreadCount: 0,
        isThinking: false,
        lastMessageAt: null,
      };
      // Override isThinking with global streaming state
      return {
        ...notification,
        isThinking: streamingStates.get(sessionId) ?? false,
      };
    },
    [notifications, streamingStates]
  );

  // Get total unread count across all sessions (for tab badge)
  const getTotalUnread = useCallback(
    (filterSessionIds?: string[]): number => {
      let total = 0;
      notifications.forEach((notification, sessionId) => {
        if (!filterSessionIds || filterSessionIds.includes(sessionId)) {
          total += notification.unreadCount;
        }
      });
      return total;
    },
    [notifications]
  );

  // Check if any session is thinking (uses global streaming state)
  const hasThinking = useCallback(
    (filterSessionIds?: string[]): boolean => {
      for (const [sessionId, isStreaming] of streamingStates) {
        if (!filterSessionIds || filterSessionIds.includes(sessionId)) {
          if (isStreaming) return true;
        }
      }
      return false;
    },
    [streamingStates]
  );

  return {
    notifications,
    getNotification,
    getTotalUnread,
    hasThinking,
    markAsSeen,
    initialized,
  };
}
