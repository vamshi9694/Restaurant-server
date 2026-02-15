import "dotenv/config";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { CallHandler } from "./callHandler.js";

const PORT = Number(process.env.PORT) || 8080;

// Validate required env vars
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Create HTTP server (needed for health checks and WebSocket upgrade)
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", activeCalls: wss.clients.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Media Stream Server");
});

// WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

wss.on("connection", (twilioWs, req) => {
  console.log(`New WebSocket connection from ${req.socket.remoteAddress}, active calls: ${wss.clients.size}`);
  const handler = new CallHandler(twilioWs);
  handler.start();
});

server.listen(PORT, () => {
  console.log(`Media Stream Server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
