export interface WSClient {
  send(data: string): void;
  data?: { repoId?: string };
}

const clients: WSClient[] = [];

// Buffer recent command events per repoId for reconnecting clients
interface BufferedEvent {
  message: string;
  timestamp: number;
}
const recentEvents = new Map<string, BufferedEvent[]>();
const BUFFER_MAX_AGE_MS = 60_000; // Keep events for 60 seconds
const BUFFER_TYPES = new Set(["command.started", "command.completed"]);

function bufferEvent(repoId: string, json: string) {
  if (!recentEvents.has(repoId)) {
    recentEvents.set(repoId, []);
  }
  const buf = recentEvents.get(repoId)!;
  buf.push({ message: json, timestamp: Date.now() });
  // Prune old events
  const cutoff = Date.now() - BUFFER_MAX_AGE_MS;
  while (buf.length > 0 && buf[0]!.timestamp < cutoff) {
    buf.shift();
  }
}

export function getRecentEvents(repoId: string, sinceTimestamp?: number): string[] {
  const buf = recentEvents.get(repoId);
  if (!buf) return [];
  const since = sinceTimestamp ?? 0;
  return buf.filter((e) => e.timestamp > since).map((e) => e.message);
}

export function addClient(ws: WSClient) {
  clients.push(ws);
}

export function removeClient(ws: WSClient) {
  const index = clients.indexOf(ws);
  if (index !== -1) {
    clients.splice(index, 1);
  }
}

export function handleWsMessage(ws: WSClient, message: string | Buffer) {
  try {
    const data = JSON.parse(message.toString());
    if (data.type === "subscribe" && data.repoId) {
      if (ws.data) {
        ws.data.repoId = data.repoId;
      }
      console.log(`Client subscribed to repo ${data.repoId}`);

      // Send missed events since last seen timestamp
      const sinceTs = typeof data.since === "number" ? data.since : undefined;
      const missed = getRecentEvents(data.repoId, sinceTs);
      for (const msg of missed) {
        try {
          ws.send(msg);
        } catch {
          // Client may have disconnected
        }
      }
      if (missed.length > 0) {
        console.log(`[WS] Sent ${missed.length} missed events to reconnected client`);
      }
    }
  } catch (e) {
    console.error("Failed to parse WS message:", e);
  }
}

export function broadcast(message: { type: string; repoId?: string; planningSessionId?: string; branchName?: string; data?: unknown }) {
  const json = JSON.stringify(message);

  // Buffer command events for reconnecting clients
  if (BUFFER_TYPES.has(message.type) && message.repoId) {
    bufferEvent(message.repoId, json);
  }

  console.log(`[WS] Broadcast: type=${message.type}, repoId=${message.repoId}, clients=${clients.length}`);
  let sentCount = 0;
  for (const client of clients) {
    // Send to all clients or only to clients subscribed to this repo
    const shouldSend = !message.repoId || !client.data?.repoId || client.data.repoId === message.repoId;
    if (shouldSend) {
      try {
        client.send(json);
        sentCount++;
      } catch (e) {
        console.error("Failed to send WS message:", e);
      }
    }
  }
  console.log(`[WS] Broadcast: Sent to ${sentCount} clients`);
}
