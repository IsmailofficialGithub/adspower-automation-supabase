'use strict';

const path = require('path');
const fs = require('fs');

// User-editable settings live in data/settings.json.
// config.js merges those on top of built-in defaults so everything still works
// even when settings.json doesn't exist or is missing keys.

const DATA_DIR = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, 'data')
  : path.join(__dirname, 'data');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let userSettings = {};
try {
  if (fs.existsSync(SETTINGS_FILE))
    userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch (_) { }


const defaults = {
  adsPower: {
    baseUrl: 'http://127.0.0.1:50325',
    apiKey: '',
  },

  proxySampling: {
    windows: { min: 5, max: 15 },
    mac: { min: 2, max: 8 },
    android: { min: 3, max: 12 },
  },

  concurrency: { min: 3, max: 5 },
  minBrowserStartGapMs: 4000,

  session: {
    minDurationSeconds: 50,
    maxDurationSeconds: 70,
    minActionDelayMs: 1500,
    maxActionDelayMs: 6000,
    clickProbability: 0.35,
    secondTabProbability: 0.3,
  },

  scroll: {
    minPasses: 3,
    maxPasses: 8,
    minStepPx: 80,
    maxStepPx: 450,
    microPauseMin: 100,
    microPauseMax: 600,
    readingPauseMin: 800,
    readingPauseMax: 4000,
  },

  paths: {
    websites: path.join(DATA_DIR, 'websites.json'),
    proxies: path.join(DATA_DIR, 'proxy.json'),
    usedProxies: path.join(DATA_DIR, 'used_proxies.json'),
    logs: path.join(DATA_DIR, 'logs.json'),
  },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const k of Object.keys(source || {})) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k]))
      result[k] = deepMerge(target[k] || {}, source[k]);
    else if (source[k] !== undefined)
      result[k] = source[k];
  }
  return result;
}

module.exports = deepMerge(defaults, userSettings);
