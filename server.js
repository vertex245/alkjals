/**
 * WebSocket Render Server with Traffic Monitor
 * 
 * Usage:
 *   npm install ws
 *   node server.js
 * 
 * Optional env vars:
 *   PORT=8080          WebSocket port (default: 8080)
 *   HTTP_PORT=3000     HTTP dashboard port (default: 3000)
 *   MAX_LOG=200        Max traffic log entries kept in memory (default: 200)
 */

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────
const WS_PORT   = parseInt(process.env.PORT      ?? "8080", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "3000", 10);
const MAX_LOG   = parseInt(process.env.MAX_LOG   ?? "200",  10);

// ─── State ───────────────────────────────────────────────────────────────────
const clients   = new Map();   // id → { ws, ip, connectedAt, msgCount, bytesSent, bytesRecv }
let   nextId    = 1;
const trafficLog = [];         // circular ring, newest last
const stats = {
  totalConnections : 0,
  totalMessages    : 0,
  totalBytesSent   : 0,
  totalBytesRecv   : 0,
  startedAt        : new Date().toISOString(),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function addLog(entry) {
  trafficLog.push({ ts: new Date().toISOString(), ...entry });
  if (trafficLog.length > MAX_LOG) trafficLog.shift();
}

function broadcastMonitor(event) {
  const payload = JSON.stringify(event);
  for (const [, c] of clients) {
    if (c.isMonitor && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}

function snapshot() {
  return {
    type: "snapshot",
    stats,
    clients: [...clients.values()].map(c => ({
      id          : c.id,
      ip          : c.ip,
      connectedAt : c.connectedAt,
      msgCount    : c.msgCount,
      bytesSent   : c.bytesSent,
      bytesRecv   : c.bytesRecv,
      isMonitor   : c.isMonitor,
    })),
    log: trafficLog.slice(-50),  // last 50 entries
  };
}

// ─── HTTP server (serves dashboard HTML) ─────────────────────────────────────
const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");

const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    if (fs.existsSync(DASHBOARD_FILE)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(DASHBOARD_FILE).pipe(res);
    } else {
      res.writeHead(404);
      res.end("dashboard.html not found. Place it next to server.js.");
    }
    return;
  }

  if (req.url === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(HTTP_PORT, () =>
  console.log(`[HTTP] Dashboard → http://localhost:${HTTP_PORT}`)
);

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

console.log(`[WS]   WebSocket  → ws://localhost:${WS_PORT}`);

wss.on("connection", (ws, req) => {
  const id          = nextId++;
  const ip          = req.headers["x-forwarded-for"]?.split(",")[0].trim()
                      ?? req.socket.remoteAddress
                      ?? "unknown";
  const connectedAt = new Date().toISOString();

  const client = { id, ws, ip, connectedAt, msgCount: 0,
                   bytesSent: 0, bytesRecv: 0, isMonitor: false };
  clients.set(id, client);
  stats.totalConnections++;

  addLog({ event: "connect", clientId: id, ip });
  console.log(`[+] Client ${id} connected  (${ip})  [${clients.size} online]`);

  // Greet the new client
  const greet = JSON.stringify({ type: "welcome", clientId: id, serverTime: connectedAt });
  ws.send(greet);
  client.bytesSent += greet.length;
  stats.totalBytesSent += greet.length;

  // Notify monitors
  broadcastMonitor({ type: "client_connected", clientId: id, ip, connectedAt });

  // ── Message handler ─────────────────────────────────────────────────────
  ws.on("message", (raw, isBinary) => {
    const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw);
    client.bytesRecv   += bytes;
    client.msgCount++;
    stats.totalMessages++;
    stats.totalBytesRecv += bytes;

    let parsed = null;
    let text   = null;

    if (!isBinary) {
      text = raw.toString();
      try { parsed = JSON.parse(text); } catch { /* plain text */ }
    }

    addLog({ event: "message", clientId: id, ip, bytes,
             preview: text ? text.slice(0, 120) : `<binary ${bytes}B>` });
    console.log(`[→] Client ${id}: ${text?.slice(0, 80) ?? `<binary ${bytes}B>`}`);

    // ── Monitor registration ─────────────────────────────────────────────
    if (parsed?.type === "monitor_register") {
      client.isMonitor = true;
      console.log(`[M] Client ${id} registered as monitor`);
      const snap = JSON.stringify(snapshot());
      ws.send(snap);
      client.bytesSent   += snap.length;
      stats.totalBytesSent += snap.length;
      return;
    }

    // ── Echo back to sender (non-monitors) ───────────────────────────────
    if (!client.isMonitor) {
      const reply = JSON.stringify({
        type      : "echo",
        clientId  : id,
        serverTime: new Date().toISOString(),
        original  : parsed ?? text ?? `<binary ${bytes}B>`,
      });
      ws.send(reply);
      client.bytesSent   += reply.length;
      stats.totalBytesSent += reply.length;
    }

    // Notify monitors of the incoming message
    broadcastMonitor({
      type     : "message",
      clientId : id,
      ip,
      bytes,
      preview  : text ? text.slice(0, 120) : `<binary ${bytes}B>`,
      ts       : new Date().toISOString(),
    });
  });

  // ── Close handler ───────────────────────────────────────────────────────
  ws.on("close", (code, reason) => {
    clients.delete(id);
    addLog({ event: "disconnect", clientId: id, ip, code });
    console.log(`[-] Client ${id} disconnected (code ${code}) [${clients.size} online]`);
    broadcastMonitor({ type: "client_disconnected", clientId: id, code,
                       ts: new Date().toISOString() });
  });

  // ── Error handler ───────────────────────────────────────────────────────
  ws.on("error", (err) => {
    console.error(`[!] Client ${id} error:`, err.message);
    addLog({ event: "error", clientId: id, ip, message: err.message });
    broadcastMonitor({ type: "client_error", clientId: id, message: err.message,
                       ts: new Date().toISOString() });
  });
});

wss.on("error", (err) => console.error("[WS] Server error:", err));

// ─── Periodic stats broadcast (every 5 s) ────────────────────────────────────
setInterval(() => {
  broadcastMonitor({ type: "stats", stats, activeClients: clients.size,
                     ts: new Date().toISOString() });
}, 5000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("\n[*] Shutting down…");
  for (const [, c] of clients) c.ws.close(1001, "Server shutting down");
  wss.close(() => httpServer.close(() => {
    console.log("[*] Done.");
    process.exit(0);
  }));
}
