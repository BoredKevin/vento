// Profanity filter — replaces offensive words with asterisks
// Messages are still delivered, only the words are masked

// Core slur list (kept minimal and targeted)
const SLURS = [
  'nigger', 'nigga', 'niggers', 'niggas',
  'faggot', 'faggots', 'fag', 'fags',
  'retard', 'retards', 'retarded',
  'tranny', 'trannies',
  'dyke', 'dykes',
  'spic', 'spics',
  'chink', 'chinks',
  'wetback', 'wetbacks',
  'kike', 'kikes',
  'gook', 'gooks',
  'coon', 'coons',
  'beaner', 'beaners',
  'raghead', 'ragheads',
  'towelhead', 'towelheads',
];

// Common letter substitutions for bypass detection
const SUBSTITUTIONS = {
  'a': ['@', '4'],
  'e': ['3'],
  'i': ['1', '!', '|'],
  'o': ['0'],
  's': ['$', '5'],
  'g': ['9'],
  't': ['7'],
};

/**
 * Build regex pattern that accounts for common letter substitutions
 */
function buildPattern(word) {
  let pattern = '';
  for (const char of word.toLowerCase()) {
    const subs = SUBSTITUTIONS[char];
    if (subs) {
      pattern += `[${char}${subs.join('')}]`;
    } else {
      pattern += char;
    }
  }
  return pattern;
}

// Pre-compile all patterns
const PATTERNS = SLURS.map(word => ({
  regex: new RegExp(`\\b${buildPattern(word)}\\b`, 'gi'),
  word,
}));

/**
 * Filter a message — replaces slur words with asterisks
 * @param {string} message - The raw message
 * @returns {string} - The filtered message
 */
function filterMessage(message) {
  if (!message || typeof message !== 'string') return message;

  let filtered = message;

  for (const { regex } of PATTERNS) {
    filtered = filtered.replace(regex, (match) => {
      // Keep first letter, replace rest with asterisks
      return match[0] + '*'.repeat(match.length - 1);
    });
  }

  return filtered;
}

module.exports = { filterMessage };
