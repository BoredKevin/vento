require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const UAParser = require('ua-parser-js');
const xss = require('xss');
const path = require('path');

const db = require('./db');
const { generateCallsign, isValidCallsign, normalizeCallsign } = require('./utils/callsign');
const { filterMessage } = require('./utils/profanity');
const bot = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// --- Middleware ---

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["https://challenges.cloudflare.com"],
      connectSrc: ["'self'", "ws:", "wss:", "http://ip-api.com"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- Helper Functions ---

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || 'unknown';
}

function parseUserAgent(ua) {
  const parser = new UAParser(ua);
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();
  const parts = [];
  if (browser.name) parts.push(`${browser.name} ${browser.version || ''}`);
  if (os.name) parts.push(`${os.name} ${os.version || ''}`);
  if (device.vendor) parts.push(`${device.vendor} ${device.model || ''}`);
  return parts.join(' · ') || 'Unknown';
}

async function getGeoLocation(ip) {
  if (!ip || ip === 'unknown' || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.')) {
    return 'Local Network';
  }
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp`);
    const data = await response.json();
    if (data.status === 'success') {
      return `${data.city}, ${data.regionName}, ${data.country}`;
    }
  } catch (err) {
    console.error('[Geo] Lookup failed:', err.message);
  }
  return 'Unknown';
}

// Track active callsigns (for collision avoidance)
const activeCallsigns = new Set();
// Track socket -> callsign mapping
const socketToCallsign = new Map();
// Track callsign -> socket mapping
const callsignToSocket = new Map();
// Rate limit: track message timestamps per socket
const messageTimes = new Map();

// --- API Routes ---

// Start a new session (server generates callsign, Turnstile must be done first)
app.post('/api/start-session', async (req, res) => {
  const { fingerprint } = req.body;

  if (!fingerprint) {
    return res.status(400).json({ success: false, error: 'Missing fingerprint' });
  }

  // Generate callsign server-side
  const callsign = generateCallsign(activeCallsigns);

  // Check shadow ban
  const isBanned = db.isBanned(fingerprint);

  // Gather metadata
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const device = parseUserAgent(ua);
  const location = await getGeoLocation(ip);

  if (isBanned) {
    // Shadow ban: create a fake session, don't create Discord channel
    db.createSession({
      callsign,
      fingerprint,
      ip,
      location,
      userAgent: device,
      discordChannelId: null,
      isShadowBanned: true,
    });

    console.log(`[Shadow] Banned user started session: ${callsign} (fp: ${fingerprint?.slice(0, 12)})`);
    return res.json({ success: true, callsign });
  }

  // Real session — create Discord channel
  const channelId = await bot.createVentChannel(callsign, {
    fingerprint,
    ip,
    location,
    device,
  });

  db.createSession({
    callsign,
    fingerprint,
    ip,
    location,
    userAgent: device,
    discordChannelId: channelId,
    isShadowBanned: false,
  });

  console.log(`[Session] Created: ${callsign} from ${location}`);
  res.json({ success: true, callsign });
});

// Verify Turnstile token
app.post('/api/verify-turnstile', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', process.env.TURNSTILE_SECRET);
    formData.append('response', token);

    const ip = getClientIp(req);
    if (ip && ip !== 'unknown') {
      formData.append('remoteip', ip);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    res.json({ success: data.success });
  } catch (err) {
    console.error('[Turnstile] Verification failed:', err);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// Get owner status
app.get('/api/status', (req, res) => {
  res.json({ status: db.getOwnerStatus() });
});

// Check if a callsign has an existing session (for rejoin)
app.get('/api/session/:callsign', (req, res) => {
  const callsign = normalizeCallsign(req.params.callsign);
  if (!isValidCallsign(callsign)) {
    return res.json({ exists: false });
  }
  const session = db.getSession(callsign);
  if (session) {
    return res.json({ exists: true, closed: !!session.closed_at });
  }
  res.json({ exists: false });
});

// --- Socket.IO ---

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // --- Join Session (session already created via POST /api/start-session) ---
  socket.on('start-session', async (data) => {
    const callsign = normalizeCallsign(data.callsign);
    const { fingerprint } = data;

    if (!callsign || !isValidCallsign(callsign)) {
      socket.emit('error-msg', { message: 'Invalid callsign format.' });
      return;
    }

    // Verify session exists in DB
    const session = db.getSession(callsign);
    if (!session) {
      socket.emit('error-msg', { message: 'Session not found. Please start a new one.' });
      return;
    }

    // Check if callsign is already active (another socket connected)
    if (activeCallsigns.has(callsign)) {
      socket.emit('error-msg', { message: 'This callsign is already connected.' });
      return;
    }

    // Join the room
    activeCallsigns.add(callsign);
    socketToCallsign.set(socket.id, callsign);
    callsignToSocket.set(callsign, socket.id);
    socket.join(`session:${callsign}`);

    socket.emit('session-started', {
      callsign,
      status: db.getOwnerStatus(),
    });

    console.log(`[Socket] Joined session: ${callsign}`);
  });

  // --- Rejoin Session ---
  socket.on('rejoin-session', async (data) => {
    const callsign = normalizeCallsign(data.callsign);
    const { fingerprint } = data;

    if (!callsign || !isValidCallsign(callsign)) {
      socket.emit('error-msg', { message: 'Invalid callsign format.' });
      return;
    }

    const session = db.getSession(callsign);
    if (!session) {
      socket.emit('error-msg', { message: 'Session not found.' });
      return;
    }

    if (session.closed_at) {
      socket.emit('error-msg', { message: 'This session has been closed.' });
      return;
    }

    // Gather secondary metadata for evasive incognito users
    const ip = getClientIp(socket.request);
    const ua = socket.request.headers['user-agent'] || '';
    const device = parseUserAgent(ua);

    // Check shadow ban
    const isBanned = db.isBanned(fingerprint, ip, device);

    activeCallsigns.add(callsign);
    socketToCallsign.set(socket.id, callsign);
    callsignToSocket.set(callsign, socket.id);
    socket.join(`session:${callsign}`);

    // Load message history
    const messages = db.getMessages(session.id);

    socket.emit('session-rejoined', {
      callsign,
      status: db.getOwnerStatus(),
      messages: messages.map(m => ({
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp,
      })),
    });

    // Notify on Discord
    if (!isBanned && session.discord_channel_id) {
      bot.sendSystemMessage(callsign, `🔄 **${callsign}** has reconnected.`);
    }

    console.log(`[Session] Rejoined: ${callsign}`);
  });

  // --- Send Message ---
  socket.on('send-message', (data) => {
    const callsign = socketToCallsign.get(socket.id);
    if (!callsign) return;

    // Rate limiting: 1 message per second
    const now = Date.now();
    const lastTime = messageTimes.get(socket.id) || 0;
    if (now - lastTime < 1000) {
      socket.emit('error-msg', { message: 'Slow down! Max 1 message per second.' });
      return;
    }
    messageTimes.set(socket.id, now);

    // Sanitize and filter
    let content = xss(data.content || '');
    if (!content.trim()) return;
    if (content.length > 2000) content = content.slice(0, 2000);

    // Apply profanity filter
    content = filterMessage(content);

    const session = db.getSession(callsign);
    if (!session) return;

    // Save to DB
    db.addMessage({
      sessionId: session.id,
      sender: 'anonymous',
      content,
    });

    // Send back to the user (echo with filtered content)
    socket.emit('message', {
      sender: 'anonymous',
      content,
      timestamp: new Date().toISOString(),
    });

    // Forward to Discord (unless shadow banned)
    if (!session.is_shadow_banned) {
      bot.sendToChannel(callsign, content);
    }
  });

  // --- Typing Indicator ---
  socket.on('typing', () => {
    const callsign = socketToCallsign.get(socket.id);
    if (!callsign) return;

    const session = db.getSession(callsign);
    if (session && !session.is_shadow_banned) {
      bot.sendTypingToChannel(callsign);
    }
  });

  // --- End Session ---
  socket.on('end-session', () => {
    handleDisconnect(socket);
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  const callsign = socketToCallsign.get(socket.id);
  if (!callsign) return;

  const session = db.getSession(callsign);

  // Notify Discord
  if (session && !session.is_shadow_banned) {
    bot.sendSystemMessage(callsign, `👋 **${callsign}** has disconnected.`);
  }

  // Clean up mappings (but don't close session — allow rejoin)
  activeCallsigns.delete(callsign);
  socketToCallsign.delete(socket.id);
  callsignToSocket.delete(callsign);
  messageTimes.delete(socket.id);

  console.log(`[Socket] Disconnected: ${socket.id} (was ${callsign})`);
}

// --- Start Server ---

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await bot.initBot(io);
    console.log('[Bot] Discord bot initialized');
  } catch (err) {
    console.error('[Bot] Failed to initialize Discord bot:', err.message);
    console.log('[Server] Starting without Discord bot...');
  }

  server.listen(PORT, () => {
    console.log(`[Server] Vento running on http://localhost:${PORT}`);
  });
}

start();
