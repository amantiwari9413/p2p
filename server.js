// server.js — Signaling server + static file serving for production
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { handleMessage, handleDisconnect } = require('./signaling');

const PORT = process.env.PORT || 8080;

// dist folder is at ../client/dist relative to server/
const DIST_DIR = path.join(__dirname, '..', 'client', 'dist');

// MIME types for static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
    return;
  }

  // Strip query string
  let urlPath = req.url.split('?')[0];

  // Try to serve file from dist
  let filePath = path.join(DIST_DIR, urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // If path is a directory, look for index.html inside it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // If file doesn't exist → SPA fallback: serve index.html
  // (React Router / client-side routing needs this)
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  // Cache-control: assets (hashed filenames) can be cached long, HTML no-cache
  const isAsset = urlPath.startsWith('/assets/');
  const cacheHeader = isAsset
    ? 'public, max-age=31536000, immutable'  // 1 year for hashed assets
    : 'no-cache, no-store, must-revalidate'; // always fresh for HTML

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheHeader,
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

// ── Rate limiting ─────────────────────────────────────────────────
// Separate limits for signaling messages vs ICE candidates.
// ICE candidates fire rapidly (10-30 per session) so they get their own
// higher limit. Room create/join are low-frequency and keep a tighter limit.
const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minute window

// Per message-type limits per IP per window
const RATE_LIMITS = {
  'create-room':  5,    // max 5 room creates per minute
  'join-room':    10,   // max 10 joins per minute
  'ice-candidate': 300, // ICE fires 10-30 per connection, allow many viewers
  'offer':        50,
  'answer':       50,
  'leave':        20,
  '__default':    200,  // catch-all for other message types
};

function isRateLimited(ip, msgType) {
  const now = Date.now();
  const key = `${ip}::${msgType}`;
  const limit = RATE_LIMITS[msgType] ?? RATE_LIMITS['__default'];

  let entry = rateLimits.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 1, windowStart: now };
    rateLimits.set(key, entry);
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW_MS * 2) rateLimits.delete(ip);
  }
}, RATE_WINDOW_MS);

// ── WebSocket ─────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws._socketId = uuidv4();
  ws._roomId = null;
  ws._role = null;
  ws._ip = req.socket.remoteAddress;

  console.log(`[server] Client connected: ${ws._socketId} from ${ws._ip}`);
  send(ws, { type: 'connected', socketId: ws._socketId });

  ws.on('message', (data) => {
    const raw = data.toString();
    // Parse just the type for rate-limit check (don't full-parse yet)
    let msgType = '__default';
    try {
      const peek = JSON.parse(raw);
      msgType = peek.type || '__default';
    } catch { /* malformed — let handleMessage reject it */ }

    if (isRateLimited(ws._ip, msgType)) {
      // Only log rate-limit hits for non-ICE to avoid log spam
      if (msgType !== 'ice-candidate') {
        console.warn(`[server] Rate limited ${ws._ip} on ${msgType}`);
        send(ws, { type: 'error', code: 'rate-limited', message: 'Too many requests' });
      }
      return;
    }
    handleMessage(wss, ws, raw);
  });

  ws.on('close', () => {
    console.log(`[server] Client disconnected: ${ws._socketId}`);
    handleDisconnect(wss, ws);
  });

  ws.on('error', (err) => {
    console.error(`[server] WS error for ${ws._socketId}:`, err.message);
  });
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

server.listen(PORT, () => {
  const distExists = fs.existsSync(DIST_DIR);
  console.log(`[server] Running on http://localhost:${PORT}`);
  console.log(`[server] Serving frontend from: ${DIST_DIR} ${distExists ? '✓' : '✗ (run npm run build in client/)'}`);
});
