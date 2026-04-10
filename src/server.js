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

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

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

const activeCallsigns = new Set();
const socketToCallsign = new Map();
const callsignToSocket = new Map();
const messageTimes = new Map();

app.post('/api/start-session', async (req, res) => {
  const { fingerprint } = req.body;

  if (!fingerprint) {
    return res.status(400).json({ success: false, error: 'Missing fingerprint' });
  }

  const callsign = generateCallsign(activeCallsigns);

  const isBanned = db.isBanned(fingerprint);

  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const device = parseUserAgent(ua);
  const location = await getGeoLocation(ip);

  if (isBanned) {
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

app.get('/api/status', (req, res) => {
  res.json({ status: db.getOwnerStatus() });
});

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

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on('start-session', async (data) => {
    const callsign = normalizeCallsign(data.callsign);
    const { fingerprint } = data;

    if (!callsign || !isValidCallsign(callsign)) {
      socket.emit('error-msg', { message: 'Invalid callsign format.' });
      return;
    }

    const session = db.getSession(callsign);
    if (!session) {
      socket.emit('error-msg', { message: 'Session not found. Please start a new one.' });
      return;
    }

    if (activeCallsigns.has(callsign)) {
      socket.emit('error-msg', { message: 'This callsign is already connected.' });
      return;
    }

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

    const ip = getClientIp(socket.request);
    const ua = socket.request.headers['user-agent'] || '';
    const device = parseUserAgent(ua);

    const isBanned = db.isBanned(fingerprint, ip, device);

    activeCallsigns.add(callsign);
    socketToCallsign.set(socket.id, callsign);
    callsignToSocket.set(callsign, socket.id);
    socket.join(`session:${callsign}`);

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

    if (!isBanned && session.discord_channel_id) {
      bot.sendSystemMessage(callsign, `🔄 **${callsign}** has reconnected.`);
    }

    console.log(`[Session] Rejoined: ${callsign}`);
  });

  socket.on('send-message', (data) => {
    const callsign = socketToCallsign.get(socket.id);
    if (!callsign) return;

    const now = Date.now();
    const lastTime = messageTimes.get(socket.id) || 0;
    if (now - lastTime < 1000) {
      socket.emit('error-msg', { message: 'Slow down! Max 1 message per second.' });
      return;
    }
    messageTimes.set(socket.id, now);

    let content = xss(data.content || '');
    if (!content.trim()) return;
    if (content.length > 2000) content = content.slice(0, 2000);

    content = filterMessage(content);

    const session = db.getSession(callsign);
    if (!session) return;

    db.addMessage({
      sessionId: session.id,
      sender: 'anonymous',
      content,
    });

    socket.emit('message', {
      sender: 'anonymous',
      content,
      timestamp: new Date().toISOString(),
    });

    if (!session.is_shadow_banned) {
      bot.sendToChannel(callsign, content);
    }
  });

  socket.on('typing', () => {
    const callsign = socketToCallsign.get(socket.id);
    if (!callsign) return;

    const session = db.getSession(callsign);
    if (session && !session.is_shadow_banned) {
      bot.sendTypingToChannel(callsign);
    }
  });

  socket.on('end-session', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  const callsign = socketToCallsign.get(socket.id);
  if (!callsign) return;

  const session = db.getSession(callsign);

  if (session && !session.is_shadow_banned) {
    bot.sendSystemMessage(callsign, `👋 **${callsign}** has disconnected.`);
  }

  activeCallsigns.delete(callsign);
  socketToCallsign.delete(socket.id);
  callsignToSocket.delete(callsign);
  messageTimes.delete(socket.id);

  console.log(`[Socket] Disconnected: ${socket.id} (was ${callsign})`);
}

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

