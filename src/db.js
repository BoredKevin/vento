const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/vento.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callsign TEXT NOT NULL UNIQUE,
    fingerprint TEXT,
    ip TEXT,
    location TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    discord_channel_id TEXT,
    is_shadow_banned INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_callsign ON sessions(callsign);
  CREATE INDEX IF NOT EXISTS idx_sessions_fingerprint ON sessions(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_bans_fingerprint ON bans(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
`);

// Support upgrading older schemas
try { db.exec('ALTER TABLE bans ADD COLUMN ip TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE bans ADD COLUMN user_agent TEXT'); } catch(e) {}

// Initialize default settings
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
initSetting.run('owner_status', 'offline');

// Prepared statements
const stmts = {
  // Sessions
  createSession: db.prepare(`
    INSERT INTO sessions (callsign, fingerprint, ip, location, user_agent, discord_channel_id, is_shadow_banned)
    VALUES (@callsign, @fingerprint, @ip, @location, @userAgent, @discordChannelId, @isShadowBanned)
  `),
  getSessionByCallsign: db.prepare('SELECT * FROM sessions WHERE callsign = ?'),
  getActiveSessionByCallsign: db.prepare('SELECT * FROM sessions WHERE callsign = ? AND closed_at IS NULL'),
  closeSession: db.prepare('UPDATE sessions SET closed_at = CURRENT_TIMESTAMP WHERE callsign = ?'),
  setChannelId: db.prepare('UPDATE sessions SET discord_channel_id = ? WHERE callsign = ?'),

  // Messages
  addMessage: db.prepare(`
    INSERT INTO messages (session_id, sender, content) VALUES (@sessionId, @sender, @content)
  `),
  getMessagesBySession: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC'),

  // Bans
  addBan: db.prepare('INSERT INTO bans (fingerprint, ip, user_agent, reason) VALUES (?, ?, ?, ?)'),
  removeBan: db.prepare('DELETE FROM bans WHERE fingerprint = ?'),
  isBanned: db.prepare('SELECT COUNT(*) as count FROM bans WHERE fingerprint = ?'),
  getAllBans: db.prepare('SELECT * FROM bans ORDER BY created_at DESC'),

  // Sync session states
  shadowBanSession: db.prepare('UPDATE sessions SET is_shadow_banned = 1 WHERE fingerprint = ? AND closed_at IS NULL'),
  unshadowBanSession: db.prepare('UPDATE sessions SET is_shadow_banned = 0 WHERE fingerprint = ? AND closed_at IS NULL'),

  // Settings
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
};

module.exports = {
  db,

  createSession({ callsign, fingerprint, ip, location, userAgent, discordChannelId, isShadowBanned }) {
    return stmts.createSession.run({ callsign, fingerprint, ip, location, userAgent, discordChannelId, isShadowBanned: isShadowBanned ? 1 : 0 });
  },

  getSession(callsign) {
    return stmts.getSessionByCallsign.get(callsign);
  },

  getActiveSession(callsign) {
    return stmts.getActiveSessionByCallsign.get(callsign);
  },

  closeSession(callsign) {
    return stmts.closeSession.run(callsign);
  },

  setChannelId(channelId, callsign) {
    return stmts.setChannelId.run(channelId, callsign);
  },

  addMessage({ sessionId, sender, content }) {
    return stmts.addMessage.run({ sessionId, sender, content });
  },

  getMessages(sessionId) {
    return stmts.getMessagesBySession.all(sessionId);
  },

  addBan(fingerprint, reason = '') {
    // Snapshot the user's latest networking info to ban via secondary methods (Incognito bypass)
    const session = db.prepare('SELECT ip, user_agent FROM sessions WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1').get(fingerprint);
    const ip = session ? session.ip : null;
    const ua = session ? session.user_agent : null;

    const result = stmts.addBan.run(fingerprint, ip, ua, reason);
    stmts.shadowBanSession.run(fingerprint);

    if (ip && ua) {
      db.prepare('UPDATE sessions SET is_shadow_banned = 1 WHERE ip = ? AND user_agent = ? AND closed_at IS NULL').run(ip, ua);
    }
    return result;
  },

  removeBan(fingerprint) {
    const ban = db.prepare('SELECT ip, user_agent FROM bans WHERE fingerprint = ?').get(fingerprint);
    const result = stmts.removeBan.run(fingerprint);
    stmts.unshadowBanSession.run(fingerprint);

    if (ban && ban.ip && ban.user_agent) {
      db.prepare('UPDATE sessions SET is_shadow_banned = 0 WHERE ip = ? AND user_agent = ? AND closed_at IS NULL').run(ban.ip, ban.user_agent);
    }
    return result;
  },

  isBanned(fingerprint, ip = null, userAgent = null) {
    if (!fingerprint) return false;
    
    // Check primary fingerprint
    const fpCheck = stmts.isBanned.get(fingerprint);
    if (fpCheck && fpCheck.count > 0) return true;

    // Check secondary network profile (defeats incognito)
    if (ip && ip !== 'unknown' && ip !== '::1' && userAgent && userAgent !== 'Unknown') {
      const ipCheck = db.prepare('SELECT COUNT(*) as count FROM bans WHERE ip = ? AND user_agent = ?').get(ip, userAgent);
      if (ipCheck && ipCheck.count > 0) return true;
    }

    return false;
  },

  getAllBans() {
    return stmts.getAllBans.all();
  },

  getSetting(key) {
    const row = stmts.getSetting.get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    return stmts.setSetting.run(key, value);
  },

  getOwnerStatus() {
    return this.getSetting('owner_status') || 'offline';
  },

  setOwnerStatus(status) {
    return this.setSetting('owner_status', status);
  }
};
