export interface WSClient {
  send(data: string): void;
  data?: { repoId?: string };
}

const clients: WSClient[] = [];

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
    }
  } catch (e) {
    console.error("Failed to parse WS message:", e);
  }
}

export function broadcast(message: { type: string; repoId?: string; planningSessionId?: string; branchName?: string; data?: unknown }) {
  const json = JSON.stringify(message);
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
