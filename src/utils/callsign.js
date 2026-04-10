// Curated word list — short, memorable, easy to type
const WORDS = [
  'Amber', 'Ash', 'Atlas', 'Aurora', 'Autumn',
  'Birch', 'Blaze', 'Bloom', 'Bolt', 'Breeze',
  'Brook', 'Briar', 'Canyon', 'Cedar', 'Chase',
  'Cinder', 'Clay', 'Cliff', 'Cloud', 'Coal',
  'Cobalt', 'Coral', 'Crane', 'Crest', 'Crimson',
  'Crown', 'Crystal', 'Cypress', 'Dagger', 'Dawn',
  'Delta', 'Dew', 'Drift', 'Dusk', 'Dust',
  'Eagle', 'Echo', 'Edge', 'Elm', 'Ember',
  'Falcon', 'Fern', 'Flame', 'Flare', 'Flint',
  'Flora', 'Fog', 'Forge', 'Frost', 'Fury',
  'Gale', 'Ghost', 'Glacier', 'Gleam', 'Glimmer',
  'Glow', 'Granite', 'Grove', 'Gust', 'Halo',
  'Haven', 'Hawk', 'Haze', 'Heath', 'Hollow',
  'Horizon', 'Ivy', 'Jade', 'Jasper', 'Jet',
  'Kindle', 'Lake', 'Lark', 'Lava', 'Leaf',
  'Lightning', 'Lily', 'Lotus', 'Luna', 'Lynx',
  'Maple', 'Marsh', 'Meadow', 'Mist', 'Moon',
  'Moss', 'Nebula', 'Night', 'Nova', 'Oak',
  'Oasis', 'Obsidian', 'Ocean', 'Onyx', 'Orbit',
  'Orchid', 'Otter', 'Owl', 'Panda', 'Pebble',
  'Peak', 'Pearl', 'Phoenix', 'Pine', 'Pixel',
  'Prism', 'Pulse', 'Quartz', 'Rain', 'Raven',
  'Reed', 'Ridge', 'Ripple', 'River', 'Robin',
  'Rose', 'Ruby', 'Sage', 'Sand', 'Shade',
  'Shadow', 'Shell', 'Silver', 'Sky', 'Slate',
  'Snow', 'Solar', 'Spark', 'Spirit', 'Star',
  'Steel', 'Stone', 'Storm', 'Summit', 'Swift',
  'Thorn', 'Thunder', 'Tide', 'Tiger', 'Timber',
  'Trail', 'Tulip', 'Tundra', 'Vapor', 'Velvet',
  'Vine', 'Violet', 'Viper', 'Void', 'Vortex',
  'Wave', 'Whisper', 'Willow', 'Wind', 'Winter',
  'Wolf', 'Wren', 'Zeal', 'Zen', 'Zephyr',
];

/**
 * Generates a callsign like "Tiger42", "Ocean15", "Falcon87"
 * @param {Set<string>} [activeCallsigns] - Set of currently active callsigns to avoid collisions
 * @returns {string}
 */
function generateCallsign(activeCallsigns = new Set()) {
  const maxAttempts = 500;

  for (let i = 0; i < maxAttempts; i++) {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    const num = Math.floor(Math.random() * 90) + 10; // 10-99
    const callsign = `${word}${num}`;

    if (!activeCallsigns.has(callsign)) {
      return callsign;
    }
  }

  // Extremely unlikely fallback — just append timestamp
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${word}${Date.now() % 100}`;
}

/**
 * Validates that a string looks like a valid callsign format (case-insensitive)
 * @param {string} str
 * @returns {boolean}
 */
function isValidCallsign(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-zA-Z]+\d{2}$/.test(str);
}

/**
 * Normalizes a callsign to TitleCase (e.g. "tiger42" -> "Tiger42")
 * @param {string} str
 * @returns {string}
 */
function normalizeCallsign(str) {
  if (!str || typeof str !== 'string') return '';
  const trimmed = str.trim();
  const match = trimmed.match(/^([a-zA-Z]+)(\d{2})$/);
  if (match) {
    return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() + match[2];
  }
  return trimmed;
}

module.exports = { generateCallsign, isValidCallsign, normalizeCallsign, WORDS };
