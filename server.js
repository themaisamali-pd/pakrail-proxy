const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { io: upstreamIO } = require('socket.io-client');
const cors = require('cors');

const UPSTREAM_URL = 'http://socket.pakraillive.com:3019';
const PORT = process.env.PORT || 3000;

// Keep Render free tier awake (pings itself every 14 minutes)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 14 * 60 * 1000);
}

const app = express();
app.use(cors());
app.get('/health', (_, res) => res.json({ status: 'ok', upstream: upstreamConnected }));

const httpServer = createServer(app);

// Our Socket.IO server — clients (the app) connect here
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ─── Upstream connection (us → pakraillive socket server) ───────────────────
let upstreamSocket = null;
let upstreamConnected = false;

// Cache latest all-trains snapshot so new clients get it instantly
let latestAllTrains = null;

function connectUpstream() {
  console.log('[Upstream] Connecting to', UPSTREAM_URL);

  upstreamSocket = upstreamIO(UPSTREAM_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionAttempts: Infinity,
  });

  upstreamSocket.on('connect', () => {
    console.log('[Upstream] Connected');
    upstreamConnected = true;

    // Subscribe to all trains immediately
    upstreamSocket.emit('all-trains', '');
  });

  upstreamSocket.on('disconnect', (reason) => {
    console.log('[Upstream] Disconnected:', reason);
    upstreamConnected = false;
  });

  upstreamSocket.on('connect_error', (err) => {
    console.log('[Upstream] Error:', err.message);
  });

  // Forward all-trains broadcast to all connected app clients
  upstreamSocket.on('all-trains', (data) => {
    latestAllTrains = data;
    io.emit('all-trains', data);
    console.log('[Upstream] all-trains → forwarded to', io.engine.clientsCount, 'clients');
  });

  // Forward train-status responses
  upstreamSocket.on('train-status', (data) => {
    io.emit('train-status', data);
  });

  // Re-request all-trains every 30 seconds to keep data fresh
  setInterval(() => {
    if (upstreamConnected) {
      upstreamSocket.emit('all-trains', '');
    }
  }, 30_000);
}

connectUpstream();

// ─── App clients connect here ────────────────────────────────────────────────
io.on('connection', (clientSocket) => {
  console.log('[Client] Connected:', clientSocket.id, '| Total:', io.engine.clientsCount);

  // Send cached snapshot immediately so client doesn't wait 30s
  if (latestAllTrains) {
    clientSocket.emit('all-trains', latestAllTrains);
  }

  // Client requests all trains
  clientSocket.on('all-trains', () => {
    if (upstreamConnected) {
      upstreamSocket.emit('all-trains', '');
    } else if (latestAllTrains) {
      clientSocket.emit('all-trains', latestAllTrains);
    }
  });

  // Client requests specific train status
  clientSocket.on('train-status', (data) => {
    if (!upstreamConnected) return;
    const { trainId } = data ?? {};
    if (!trainId) return;

    // Forward to upstream and relay response back to this specific client
    upstreamSocket.emit('train-status', data);

    // Subscribe to IMEI channel for this train's real-time updates
    if (!upstreamSocket.hasListeners(trainId)) {
      upstreamSocket.on(trainId, (coord) => {
        io.emit(trainId, coord); // broadcast to all clients tracking this train
      });
    }
  });

  clientSocket.on('disconnect', () => {
    console.log('[Client] Disconnected:', clientSocket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Server] Proxy running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
});
