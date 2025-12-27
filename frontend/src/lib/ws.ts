type WSMessage = {
  type: string;
  repoId?: number;
  data?: unknown;
};

type MessageHandler = (message: WSMessage) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private repoId: number | null = null;
  private reconnectTimeout: number | null = null;

  connect(repoId?: number) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (repoId && repoId !== this.repoId) {
        this.subscribe(repoId);
      }
      return;
    }

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      if (repoId) {
        this.subscribe(repoId);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        this.emit(message.type, message);
      } catch (e) {
        console.error("Failed to parse WS message:", e);
      }
    };

    this.ws.onclose = () => {
      console.log("WebSocket disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect(this.repoId || undefined);
    }, 3000);
  }

  subscribe(repoId: number) {
    this.repoId = repoId;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "subscribe", repoId }));
    }
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.off(type, handler);
  }

  off(type: string, handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, message: WSMessage) {
    this.handlers.get(type)?.forEach((handler) => handler(message));
    // Also emit to wildcard handlers
    this.handlers.get("*")?.forEach((handler) => handler(message));
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const wsClient = new WebSocketClient();
