import { WebSocket, WebSocketServer } from "ws";
import { Server } from "http";

export interface BroadcastMessage {
  type: string;
  [key: string]: unknown;
}

export class ConnectionManager {
  private activeConnections: Map<string, WebSocket> = new Map();
  private activeGenerations: Map<string, boolean> = new Map();

  setup(server: Server): WebSocketServer {
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const pathParts = url.pathname.split("/");
      const clientId = pathParts[pathParts.length - 1];

      this.connect(ws, clientId);

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "stop_generation") {
            this.setGenerating(clientId, false);
          }
        } catch {
          // ignore
        }
      });

      ws.on("close", () => {
        this.disconnect(clientId);
      });
    });

    return wss;
  }

  private connect(websocket: WebSocket, clientId: string): void {
    this.activeConnections.set(clientId, websocket);
    this.activeGenerations.set(clientId, false);
  }

  private disconnect(clientId: string): void {
    this.activeConnections.delete(clientId);
    this.activeGenerations.delete(clientId);
  }

  setGenerating(clientId: string, isGenerating: boolean): void {
    this.activeGenerations.set(clientId, isGenerating);
  }

  shouldStop(clientId: string): boolean {
    return !this.activeGenerations.get(clientId);
  }

  async broadcast(message: BroadcastMessage): Promise<void> {
    const data = JSON.stringify(message);
    for (const connection of this.activeConnections.values()) {
      try {
        if (connection.readyState === WebSocket.OPEN) {
          connection.send(data);
        }
      } catch {
        // ignore send failures
      }
    }
  }
}

export const manager = new ConnectionManager();
