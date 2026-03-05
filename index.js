'use strict';

/**
 * AdsPower Automation — Proxy-Driven Multi-OS Profile Engine
 *
 * Flow:
 *  1. Load proxy.json  →  sample N proxies per OS (windows / mac / android)
 *  2. PRE-FLIGHT TEST each proxy — skip dead ones before wasting an AdsPower slot
 *  3. Check AdsPower account limit — cap creation to available slots
 *  4. Create profiles sequentially (rate-limited, ~1 per second)
 *  5. Run sessions through a semaphore POOL (max 3–5 concurrent, 4 s start gap)
 *     - Each session picks a RANDOM nav strategy: google-search / direct / via-redirect
 *     - Follows all redirects naturally
 *     - Human-like scroll + random clicks for 50–70 s
 *  6. Stop → wait → retry-delete → mark proxy used
 *  7. Graceful shutdown: SIGINT/SIGTERM lets the current batch finish, THEN exits
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer-core');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const config = require('./config');
const logger = require('./utils/logger');
const { randomInt, sleep } = require('./utils/helpers');

// ─── AdsPower API ─────────────────────────────────────────────────────────────
const MIN_API_GAP_MS = 1200;
let lastApiCallAt = 0;

async function rateLimitedApi(fn) {
  const gap = MIN_API_GAP_MS - (Date.now() - lastApiCallAt);
  if (gap > 0) await sleep(gap);
  lastApiCallAt = Date.now();
  return fn();
}

const api = axios.create({
  baseURL: config.adsPower.baseUrl,
  timeout: 25000,
  headers: config.adsPower.apiKey
    ? { Authorization: `Bearer ${config.adsPower.apiKey}` }
    : {},
});

async function apiCall(fn, label = '', maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await rateLimitedApi(fn);
      const msg = res?.data?.msg || '';
      if (res?.data?.code !== 0 && msg.toLowerCase().includes('too many')) {
        const delay = attempt * 3000;
        logger.warn(`[${label}] Rate-limited — waiting ${delay / 1000}s (attempt ${attempt}/${maxRetries})…`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      const delay = attempt * 3000;
      if (attempt < maxRetries) {
        logger.warn(`[${label}] Error attempt ${attempt}/${maxRetries} — retrying in ${delay / 1000}s… (${err.message})`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// ─── Supabase Configuration ──────────────────────────────────────────────────
const userId = process.env.AUTOMATION_USER_ID;
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'public' }
  })
  : null;

// ─── OS → AdsPower platform ID ───────────────────────────────────────────────
const OS_PLATFORM = { windows: 0, mac: 1, android: 3 };

// ─── Control flags ────────────────────────────────────────────────────────
let shutdownRequested = false;
let pauseRequested = false;

// Listen for PAUSE / RESUME commands sent via stdin by server.js
if (!process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  let stdinBuf = '';
  process.stdin.on('data', chunk => {
    stdinBuf += chunk;
    const lines = stdinBuf.split('\n');
    stdinBuf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      const cmd = line.trim().toUpperCase();
      if (cmd === 'PAUSE') {
        pauseRequested = true;
        logger.info('\u23f8  Automation paused — finishing active sessions then waiting for resume…');
      } else if (cmd === 'RESUME') {
        pauseRequested = false;
        logger.info('\u25b6  Automation resumed.');
      }
    }
  });
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function loadJSON(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return [];
  const raw = fs.readFileSync(abs, 'utf8').trim();
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (_) { return []; }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(path.resolve(filePath), JSON.stringify(data, null, 2), 'utf8');
}

// ─── URL normaliser ─ auto-prepend https:// if no protocol given ─────────────
function normalizeUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;              // already has http(s)
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) return s; // some other scheme
  return 'https://' + s;                               // bare domain → https://
}

// ─── Deep merge (for settings) ────────────────────────────────────────────────────
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

// ─── Pause helper ──────────────────────────────────────────────────────────────
async function waitWhilePaused() {
  if (!pauseRequested) return;
  logger.info('\u23f8  Paused — waiting for resume…');
  while (pauseRequested && !shutdownRequested) await sleep(500);
  if (!shutdownRequested) logger.info('\u25b6  Resumed — continuing…');
}

// ─── Proxy helpers ─────────────────────────────────────────────────────────────

/**
 * Normalise a proxy entry which can be either:
 *   (a) an object  { host, port, user, pass, protocol, os }
 *   (b) a URL string  protocol://host:port:user:pass
 *       (non-standard colon-separated format used for convenience)
 *       optional trailing :os  e.g.  socks5://host:1002:user:pass:mac
 * Returns a normalised object, or null if the entry is invalid.
 */
function parseProxyEntry(entry) {
  if (entry && typeof entry === 'object') return entry; // already object form

  if (typeof entry === 'string') {
    const m = entry.match(/^(socks5|socks4|https?):\/\/(.+)$/);
    if (!m) return null;

    const parts = m[2].split(':');
    if (parts.length < 4) return null;

    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const user = parts[2];

    const knownOs = ['windows', 'mac', 'android', 'linux'];
    const lastPart = parts[parts.length - 1].toLowerCase();
    let os = 'windows';
    let pass;
    if (knownOs.includes(lastPart)) {
      os = lastPart;
      pass = parts.slice(3, -1).join(':');
    } else {
      pass = parts.slice(3).join(':');
    }

    if (!host || isNaN(port) || !user || !pass) return null;
    return { host, port, user, pass, protocol: m[1], os };
  }

  return null;
}

function sampleProxiesForOS(pool, os, count) {
  const candidates = pool.filter(p => (p.os || '').toLowerCase() === os);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, Math.min(count, candidates.length));
}

function proxyKey(proxy) {
  return `${proxy.host}:${proxy.port}:${proxy.pass || ''}`;
}

async function markProxyUsed(proxy) {
  if (supabase && userId) {
    const { error } = await supabase.from('ads_used_proxies').insert({
      user_id: userId,
      host: proxy.host,
      port: proxy.port,
      user: proxy.user,
      pass: proxy.pass,
      protocol: proxy.protocol,
      os: proxy.os
    });
    if (error) logger.warn(`Failed to mark proxy used in Supabase: ${error.message}`);
    else logger.info(`Proxy marked used in Supabase: ${proxy.host}:${proxy.port} [${proxy.os}]`);
    return;
  }

  const used = loadJSON(config.paths.usedProxies);
  const key = proxyKey(proxy);
  if (!used.find(u => proxyKey(u) === key)) {
    used.push({ ...proxy, usedAt: new Date().toISOString() });
    saveJSON(config.paths.usedProxies, used);
    logger.info(`Proxy marked used (file): ${proxy.host}:${proxy.port} [${proxy.os}]`);
  }
}

async function removeProxyFromAdsPower(proxyHost) {
  try {
    // We check the first 100 profiles (page_limit: 100) to find matching proxies.
    // This catches leftovers without scanning thousands of profiles.
    const res = await apiCall(() => api.get('/api/v1/user/list', { params: { page_size: 100 } }), 'Scan for dead proxy profiles');
    if (!res?.data?.list) return;

    const toDelete = res.data.list
      .filter(p => p.user_proxy_config?.proxy_host === proxyHost || p.ip === proxyHost)
      .map(p => p.user_id);

    if (toDelete.length > 0) {
      logger.info(`  \u2717 Deleting ${toDelete.length} leftover profile(s) from AdsPower using ${proxyHost}…`);
      await apiCall(() => api.post('/api/v1/user/delete', { user_ids: toDelete }), 'Cleanup failed proxy profiles');
    }
  } catch (err) {
    logger.debug(`AdsPower cleanup skip for ${proxyHost}: ${err.message}`);
  }
}

async function removeProxyFromSource(proxy) {
  // 1. Remove from database
  if (supabase && userId) {
    const { error } = await supabase.from('ads_proxies')
      .delete()
      .eq('user_id', userId)
      .eq('host', proxy.host)
      .eq('port', proxy.port);
    if (error) logger.warn(`Failed to remove failed proxy from Supabase: ${error.message}`);
    else logger.info(`Failed proxy permanently removed from Supabase: ${proxy.host}:${proxy.port}`);
  } else {
    const pool = loadJSON(config.paths.proxies);
    const key = proxyKey(proxy);
    const filtered = pool.filter(p => {
      const parsed = parseProxyEntry(p);
      return parsed && proxyKey(parsed) !== key;
    });
    if (filtered.length !== pool.length) {
      saveJSON(config.paths.proxies, filtered);
      logger.info(`Failed proxy permanently removed from local file: ${proxy.host}:${proxy.port}`);
    }
  }

  // 2. Remove associated profiles from AdsPower
  await removeProxyFromAdsPower(proxy.host);
}

async function logSessionSuccess(profileId, websiteUrl, durationSeconds, proxy) {
  if (supabase && userId) {
    const { error } = await supabase.from('ads_logs').insert({
      user_id: userId,
      profile_id: profileId,
      website_url: websiteUrl,
      duration_seconds: durationSeconds,
      proxy_host: proxy.host,
      proxy_port: proxy.port,
      status: 'success'
    });
    if (error) logger.warn(`Failed to save success log to Supabase: ${error.message}`);
    else logger.info(`[${profileId}] Success log saved to Supabase.`);
  } else {
    const logs = loadJSON(config.paths.logs);
    logs.push({
      profileId, websiteUrl, durationSeconds,
      proxyHost: proxy.host, proxyPort: proxy.port,
      status: 'success', timestamp: new Date().toISOString()
    });
    saveJSON(config.paths.logs, logs);
  }
}

// ─── Proxy Pre-flight Test ─────────────────────────────────────────────────────

async function testProxy(proxy) {
  const proto = (proxy.protocol || 'http').toLowerCase();
  const user = encodeURIComponent(proxy.user || '');
  const pass = encodeURIComponent(proxy.pass || '');
  const auth = user ? `${user}:${pass}@` : '';
  const proxyUrl = `${proto}://${auth}${proxy.host}:${proxy.port}`;

  const testEndpoints = [
    'http://api.ipify.org',
    'http://icanhazip.com',
    'http://checkip.amazonaws.com',
  ];

  for (const url of testEndpoints) {
    try {
      let agent;
      if (proto === 'socks5' || proto === 'socks4') {
        agent = new SocksProxyAgent(proxyUrl);
      } else {
        agent = new HttpProxyAgent(proxyUrl);
      }

      await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 25000,
        validateStatus: () => true,
      });

      return true;
    } catch (err) {
      logger.debug(`  proxy test [${url}]: ${err.message.split('\n')[0]}`);
    }
  }

  return false;
}


async function fetchExistingProfileCount() {
  try {
    const res = await apiCall(
      () => api.get('/api/v1/user/list', { params: { page: 1, page_size: 1 } }),
      'fetchProfileCount'
    );
    if (res?.data?.code === 0) {
      return res.data.data?.page_info?.total_count ?? 0;
    }
  } catch (_) { }
  return 0;
}

/**
 * Build the fingerprint config from settings, applying all AdsPower options.
 * Falls back to sensible defaults when a setting isn't configured.
 */
function buildFingerprintConfig(proxy, fp) {
  const osPlatform = OS_PLATFORM[(proxy.os || 'windows').toLowerCase()] ?? 0;

  // Screen resolution
  let resolution = '1366x768';
  if (fp?.screenResolution === 'random') {
    const resolutions = ['1366x768', '1920x1080', '1440x900', '1280x800', '1600x900', '1280x1024', '1024x768', '2560x1440'];
    resolution = resolutions[randomInt(0, resolutions.length - 1)];
  } else if (fp?.screenResolution === 'custom' && fp?.customResolution) {
    resolution = fp.customResolution;
  }

  // Language
  let language = ['en-US', 'en'];
  if (fp?.language === 'custom' && fp?.customLanguage) {
    language = fp.customLanguage.split(',').map(l => l.trim()).filter(Boolean);
  }

  // Timezone
  let automaticTimezone = '1';
  let timezone = '';
  if (fp?.timezone === 'real') {
    automaticTimezone = '0';
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } else if (fp?.timezone === 'custom' && fp?.customTimezone) {
    automaticTimezone = '0';
    timezone = fp.customTimezone;
  }

  // WebRTC — AdsPower API requires EXACT string values: forward | proxy | local | disabled | disable_udp
  // Our UI labels map to AdsPower values as follows:
  //   forward  → forward
  //   replace  → proxy   (proxy IP replaces real IP)
  //   real     → local   (expose real local IP)
  //   disabled → disabled
  const webrtcMap = { forward: 'forward', replace: 'proxy', real: 'local', disabled: 'disabled', proxy: 'proxy', local: 'local', disable_udp: 'disable_udp' };
  const webrtcMode = webrtcMap[fp?.webrtc || 'replace'] ?? 'proxy';

  // Canvas noise (1=noise, 0=real)
  const canvas = fp?.canvasNoise === false ? 0 : 1;
  // WebGL image noise
  const webglImage = fp?.webglNoise === false ? 0 : 1;
  // AudioContext noise
  const audio = fp?.audioNoise === false ? 0 : 1;
  // Media devices noise
  const mediaDevices = fp?.mediaDevicesNoise === false ? 0 : 1;
  // ClientRects noise
  const clientRects = fp?.clientRectsNoise === false ? 0 : 1;
  // SpeechVoices noise
  const speechVoices = fp?.speechVoicesNoise === false ? 0 : 1;

  // WebGPU: 0=based on WebGL, 1=real, 2=disabled
  const webgpuMap = { 'based-on-webgl': 0, real: 1, disabled: 2 };
  const webgpu = webgpuMap[fp?.webgpu || 'based-on-webgl'] ?? 0;

  // WebGL metadata
  const webglVendor = fp?.webglVendor || 'Google Inc. (Intel)';
  const webglRenderer = fp?.webglRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';

  // Fonts
  const fonts = (fp?.fonts === 'custom' && Array.isArray(fp?.customFonts)) ? fp.customFonts : [];

  // User-Agent
  const ua = fp?.userAgent || '';

  // Location
  let locationConfig = {};
  if (fp?.location === 'custom' && fp?.customLatitude && fp?.customLongitude) {
    locationConfig = {
      location: 1,
      latitude: parseFloat(fp.customLatitude),
      longitude: parseFloat(fp.customLongitude),
      accuracy: fp.customAccuracy ? parseFloat(fp.customAccuracy) : 100,
    };
  }


  const fingerprintResult = {
    automatic_timezone: automaticTimezone,
    timezone,
    language,
    ua,
    resolution,
    fonts,
    platform: osPlatform,
    webrtc: webrtcMode,
    canvas,
    webgl: webglImage,
    audio,
    media_devices: mediaDevices,
    client_rects: clientRects,
    speech_voices: speechVoices,
    webgl_config: {
      vendor: webglVendor,
      renderer: webglRenderer,
      webgl_type: fp?.webglMetadata === 'real' ? 1 : 0,
    },
    ...locationConfig,
  };

  // Only add random_ua when enabled.
  // AdsPower requires it as a JSON *string* with specific keys — omit entirely when off.
  // ua_version MUST NOT be an empty array; omit it to mean "any version".
  if (fp?.randomFingerprint) {
    try {
      const osName = (proxy.os || 'windows').toLowerCase();
      const browserOs = osName === 'mac' ? 'mac' : osName === 'android' ? 'android' : 'win';
      fingerprintResult.random_ua = JSON.stringify({
        ua_browser: ['chrome'],
        ua_os: [browserOs],
      });
    } catch (_) {
      // If anything goes wrong building random_ua, skip it — don't break profile creation
    }
  }

  return fingerprintResult;
}

async function createProfile(proxy, name) {
  let userSettings = {};
  if (supabase && userId) {
    const { data } = await supabase.from('ads_settings').select('data').eq('user_id', userId).single();
    userSettings = data?.data || {};
  } else {
    // Reload settings fresh each time so UI changes take effect without restart
    const dDir = process.env.USER_DATA_PATH
      ? path.join(process.env.USER_DATA_PATH, 'data')
      : path.join(__dirname, 'data');
    const SETTINGS_FILE = path.join(dDir, 'settings.json');
    try {
      if (fs.existsSync(SETTINGS_FILE))
        userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (_) { }
  }

  const fp = userSettings.fingerprint || {};
  const fingerprintConfig = buildFingerprintConfig(proxy, fp);

  // Open URLs for profile tabs
  const openUrls = Array.isArray(userSettings.openUrls) && userSettings.openUrls.length
    ? userSettings.openUrls
    : [];

  const body = {
    name,
    group_id: userSettings.groupId || '0',
    domain_name: '',
    open_urls: openUrls,
    username: '', password: '', fakey: '', cookie: userSettings.cookie || '',
    ignore_cookie_error: '0',
    sys_app_cate_id: '0',
    user_proxy_config: {
      proxy_soft: 'other',
      proxy_type: proxy.protocol || 'http',
      proxy_host: proxy.host,
      proxy_port: String(proxy.port),
      proxy_user: proxy.user || '',
      proxy_password: proxy.pass || '',
    },
    fingerprint_config: fingerprintConfig,
  };

  const res = await apiCall(() => api.post('/api/v1/user/create', body), 'createProfile');
  if (res.data.code !== 0) throw new Error(`Profile create failed: ${res.data.msg}`);
  const profileId = res.data.data.id;
  logger.info(`Created profile [${profileId}] "${name}" (${proxy.os}) via ${proxy.protocol}://${proxy.host}:${proxy.port}`);
  return profileId;
}

async function activateProfile(profileId, { headless = false } = {}) {
  const params = { user_id: profileId };
  if (headless) params.headless = 1;  // AdsPower headless launch param
  const res = await apiCall(
    () => api.get('/api/v1/browser/start', { params }),
    `activate:${profileId}`
  );
  if (res.data.code !== 0) throw new Error(`Start failed [${profileId}]: ${res.data.msg}`);
  return res.data.data;
}

async function stopProfile(profileId) {
  try {
    await apiCall(
      () => api.get('/api/v1/browser/stop', { params: { user_id: profileId } }),
      `stop:${profileId}`, 3
    );
    logger.info(`Profile [${profileId}] stopped.`);
  } catch (err) {
    logger.warn(`Stop [${profileId}] error: ${err.message}`);
  }
  await sleep(3000);
}

async function deleteProfile(profileId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await apiCall(
        () => api.post('/api/v1/user/delete', { user_ids: [profileId] }),
        `delete:${profileId}`, 3
      );
      const msg = res?.data?.msg || '';
      if (res?.data?.code === 0) {
        logger.info(`Profile [${profileId}] deleted from AdsPower.`);
        return;
      }
      if (msg.includes('being used') || msg.includes('Too many')) {
        const delay = attempt * 4000;
        logger.warn(`Delete attempt ${attempt}/5 — "${msg}" — retrying in ${delay / 1000}s…`);
        await sleep(delay);
        continue;
      }
      logger.warn(`Delete [${profileId}]: ${msg}`);
      return;
    } catch (err) {
      logger.warn(`Delete error [${profileId}] attempt ${attempt}: ${err.message}`);
      if (attempt < 5) await sleep(attempt * 4000);
    }
  }
}

// ─── Human Behaviour ──────────────────────────────────────────────────────────

async function humanScroll(page) {
  const { scroll, session } = config;
  const passes = randomInt(scroll.minPasses, scroll.maxPasses);
  for (let i = 0; i < passes; i++) {
    const goDown = Math.random() < 0.8;
    const burstSteps = randomInt(3, 8);
    for (let s = 0; s < burstSteps; s++) {
      const px = randomInt(scroll.minStepPx, scroll.maxStepPx) * (goDown ? 1 : -1);
      await page.evaluate(d => window.scrollBy({ top: d, behavior: 'smooth' }), px);
      await sleep(randomInt(scroll.microPauseMin, scroll.microPauseMax));
    }
    const pause = randomInt(scroll.readingPauseMin, scroll.readingPauseMax);
    logger.debug(`Scroll burst — reading pause ${pause}ms`);
    await sleep(pause);
    if (Math.random() < session.clickProbability) await randomClick(page);
  }
}

async function randomClick(page) {
  try {
    const handles = await page.$$(
      'button:not([disabled]):not([type="submit"]):not([type="reset"]), ' +
      '[role="button"]:not(a):not([disabled])'
    );

    const visible = [];
    for (const el of handles) {
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0 && box.y > 0) visible.push(el);
      if (visible.length >= 15) break;
    }
    if (!visible.length) return;

    const target = visible[randomInt(0, visible.length - 1)];
    const text = await target.evaluate(el => el.innerText?.trim().slice(0, 60) || '');

    const isAnchor = await target.evaluate(el => {
      let node = el;
      while (node) {
        if (node.tagName === 'A') return true;
        node = node.parentElement;
      }
      return false;
    }).catch(() => true);
    if (isAnchor) return;

    await target.click().catch(() => { });
    logger.debug(`Clicked button: "${text}"`);
    await sleep(randomInt(1000, 3000));
  } catch (_) { }
}

async function simulateCursorMovement(page) {
  const steps = randomInt(3, 7);
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(randomInt(60, 1300), randomInt(60, 700), { steps: randomInt(8, 25) }).catch(() => { });
    await sleep(randomInt(150, 700));
  }
}

// ─── Navigation Strategies ────────────────────────────────────────────────────

/**
 * Strategy 1: Navigate via Google Search (SERP click)
 * Works for all OS types. Mobile profiles land on the SERP and click through.
 */
async function navigateViaSearch(page, profileId, targetUrl) {
  let domain;
  try {
    domain = new URL(targetUrl).hostname.replace(/^www\./, '');
  } catch (_) {
    domain = targetUrl;
  }

  logger.info(`[${profileId}] [Google] Searching for: ${domain}`);

  try {
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 40000 });
  } catch (err) {
    logger.warn(`[${profileId}] Google load failed (${err.message}) — falling back to direct nav`);
    return navigateDirect(page, profileId, targetUrl);
  }

  // Dismiss cookie/consent dialogs (crucial for mobile profiles)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const accept = btns.find(b => /accept all|accept|agree|got it|i agree|allow all/i.test(b.innerText || b.textContent));
    if (accept) accept.click();
  }).catch(() => { });
  await sleep(randomInt(800, 1500));

  // Find search box — mobile layout may use different selectors
  let searchBox;
  for (const sel of ['textarea[name="q"]', 'input[name="q"]', '[role="combobox"]', 'input[type="search"]']) {
    searchBox = await page.$(sel);
    if (searchBox) break;
  }
  if (!searchBox) {
    logger.warn(`[${profileId}] Search box not found — falling back to direct nav`);
    return navigateDirect(page, profileId, targetUrl);
  }

  await searchBox.click();
  await sleep(randomInt(400, 900));
  for (const char of domain) {
    await page.keyboard.type(char, { delay: randomInt(60, 190) });
  }
  await sleep(randomInt(400, 900));
  await page.keyboard.press('Enter');

  // Wait for SERP
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (_) { }
  await sleep(randomInt(1000, 2000));

  const currentUrl = page.url();
  logger.info(`[${profileId}] [Google] SERP loaded: ${currentUrl.slice(0, 80)}`);

  // Check we actually got to a results page (mobile may redirect differently)
  if (!currentUrl.includes('google.') && !currentUrl.includes('/search')) {
    // Already landed on the target or was redirected somewhere
    logger.info(`[${profileId}] [Google] Redirected to: ${currentUrl}`);
    return;
  }

  // Click the matching organic result
  const clicked = await page.evaluate((d) => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      try {
        const href = link.getAttribute('href') || '';
        if (href && href.includes(d) && !href.startsWith('/search') && !href.includes('google.com/search')) {
          link.scrollIntoView({ behavior: 'smooth', block: 'center' });
          link.click();
          return true;
        }
      } catch (_) { }
    }
    return false;
  }, domain);

  if (clicked) {
    logger.info(`[${profileId}] [Google] Clicked search result — waiting for page load…`);
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (_) { }
    await sleep(randomInt(2000, 4000));
    logger.info(`[${profileId}] [Google] Landed on: ${page.url()}`);
  } else {
    logger.warn(`[${profileId}] [Google] Domain not visible in SERP — falling back to direct nav`);
    return navigateDirect(page, profileId, targetUrl);
  }
}

/**
 * Strategy 2: Direct navigation to the target URL
 */
async function navigateDirect(page, profileId, targetUrl, maxAttempts = 3) {
  logger.info(`[${profileId}] [Direct] Navigating to: ${targetUrl}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      logger.info(`[${profileId}] [Direct] Landed on: ${page.url()}`);
      return;
    } catch (err) {
      logger.warn(`[${profileId}] [Direct] Attempt ${attempt}/${maxAttempts}: ${err.message}`);
      if (attempt < maxAttempts) await sleep(attempt * 5000);
      else throw err;
    }
  }
}

/**
 * Strategy 3: Navigate via an intermediate redirect/referrer site
 * Opens a known link-sharing or redirect site first, then navigates to target.
 * Gives the target site a realistic referrer header.
 */
async function navigateViaRedirect(page, profileId, targetUrl) {
  // Pool of intermediate sites — pick one randomly
  const intermediates = [
    'https://www.reddit.com',
    'https://www.twitter.com',
    'https://www.facebook.com',
    'https://www.youtube.com',
    'https://www.t.co',
    'https://www.linkedin.com',
    'https://news.ycombinator.com',
    'https://www.pinterest.com',
    'https://www.instagram.com',
    'https://www.quora.com',
  ];
  const intermediate = intermediates[randomInt(0, intermediates.length - 1)];

  logger.info(`[${profileId}] [Redirect] Via ${intermediate} → ${targetUrl}`);

  try {
    await page.goto(intermediate, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logger.info(`[${profileId}] [Redirect] Intermediate loaded: ${intermediate}`);
    await sleep(randomInt(1500, 3500));
    // Now navigate to the actual target — referrer is set automatically
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    logger.info(`[${profileId}] [Redirect] Landed on: ${page.url()}`);
  } catch (err) {
    logger.warn(`[${profileId}] [Redirect] Failed (${err.message}) — falling back to direct`);
    return navigateDirect(page, profileId, targetUrl);
  }
}

/**
 * Pick a random navigation strategy with OS-aware weights.
 *
 * Android (mobile) profiles:
 *   - NEVER use Google SERP — mobile browser gets stuck on consent dialogs,
 *     different SERP layout, and waitForNavigation timeouts.
 *   - 60% Direct  |  40% Via Redirect
 *
 * Windows / Mac (desktop) profiles:
 *   - 50% Google SERP  |  25% Direct  |  25% Via Redirect
 */
async function navigateToTarget(page, profileId, targetUrl, os = 'windows') {
  const isMobile = (os || '').toLowerCase() === 'android';

  if (isMobile) {
    // Mobile: skip Google entirely to avoid stuck sessions
    const roll = Math.random();
    if (roll < 0.60) {
      logger.info(`[${profileId}] [Mobile] Strategy: Direct`);
      return navigateDirect(page, profileId, targetUrl);
    } else {
      logger.info(`[${profileId}] [Mobile] Strategy: Redirect`);
      return navigateViaRedirect(page, profileId, targetUrl);
    }
  } else {
    // Desktop: random mix including Google
    const roll = Math.random();
    if (roll < 0.50) {
      logger.info(`[${profileId}] [Desktop] Strategy: Google Search`);
      return navigateViaSearch(page, profileId, targetUrl);
    } else if (roll < 0.75) {
      logger.info(`[${profileId}] [Desktop] Strategy: Direct`);
      return navigateDirect(page, profileId, targetUrl);
    } else {
      logger.info(`[${profileId}] [Desktop] Strategy: Redirect`);
      return navigateViaRedirect(page, profileId, targetUrl);
    }
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────

async function runSession(profileId, proxy, url) {
  let browser = null;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await stopProfile(profileId);
    await deleteProfile(profileId);
    await markProxyUsed(proxy);
    logger.info(`[${profileId}] Cleanup done — proxy removed from AdsPower and marked used.`);
  };

  try {
    const headlessMode = !!(global._effectiveCfg?.headlessMode);
    const endpoint = await activateProfile(profileId, { headless: headlessMode });
    const wsUrl = endpoint.ws.puppeteer;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        logger.warn(`WS connect attempt ${attempt} failed — retrying in 3s…`);
        await sleep(3000);
      }
    }

    const page = (await browser.pages())[0] || (await browser.newPage());

    // If headless mode: minimize the browser window via CDP so it runs in background
    if (headlessMode) {
      try {
        const cdp = await page.target().createCDPSession();
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        logger.info(`[${profileId}] 💻 Browser minimized (headless mode).`);
      } catch (e) {
        logger.debug(`[${profileId}] Could not minimize window: ${e.message}`);
      }
    }

    // ── Step 1: Navigate (with generous timeout for redirect strategy) ──────────
    // Redirect strategy does: intermediate site (30s) + sleep (3.5s) + target (60s) = ~93.5s max.
    // We give 130s so the strategy always has room to complete before the hard cap fires.
    const NAV_TIMEOUT_MS = 130000;
    await Promise.race([
      navigateToTarget(page, profileId, url, proxy.os),
      sleep(NAV_TIMEOUT_MS).then(() => {
        logger.warn(`[${profileId}] Navigation hard-cap (${NAV_TIMEOUT_MS / 1000}s) reached.`);
      }),
    ]);

    // ── Step 2: Verify we are on the TARGET domain ──────────────────────────────
    // After a redirect or Google strategy the browser might still be on an
    // intermediate page.  If so, do a fast direct fallback navigation NOW,
    // BEFORE starting the session timer.
    let targetHost;
    try { targetHost = new URL(normalizeUrl(url)).hostname.replace(/^www\./, ''); } catch (_) { targetHost = ''; }

    const landedUrl = page.url();
    const onTarget = targetHost && landedUrl.includes(targetHost);

    if (!onTarget && targetHost) {
      logger.warn(`[${profileId}] Landed on ${landedUrl.slice(0, 70)} — NOT the target. Navigating directly…`);
      try {
        await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 45000 });
        logger.info(`[${profileId}] Direct fallback landed on: ${page.url()}`);
      } catch (err) {
        logger.warn(`[${profileId}] Direct fallback failed: ${err.message} — browsing current page anyway.`);
      }
    }

    // ── Step 3: START the browse timer now that we are on the target site ───────
    const finalUrl = page.url();
    logger.info(`[${profileId}] ✓ Starting browse session on: ${finalUrl}`);

    const cfg = (global._effectiveCfg) || config; // use settings loaded in main() if available
    const durationMs = randomInt(
      (cfg.session?.minDurationSeconds ?? config.session.minDurationSeconds) * 1000,
      (cfg.session?.maxDurationSeconds ?? config.session.maxDurationSeconds) * 1000
    );
    const deadline = Date.now() + durationMs;
    logger.info(`[${profileId}] Browsing for ${Math.round(durationMs / 1000)}s (timer starts NOW on target page)…`);

    while (Date.now() < deadline) {
      const action = randomInt(0, 2);
      if (action === 0) await simulateCursorMovement(page);
      else if (action === 1) await humanScroll(page);
      else await randomClick(page);
      await sleep(randomInt(
        cfg.session?.minActionDelayMs ?? config.session.minActionDelayMs,
        cfg.session?.maxActionDelayMs ?? config.session.maxActionDelayMs
      ));
    }

    // ── Step 4: Record success log ──────────────────────────────────────────────
    await logSessionSuccess(profileId, finalUrl, Math.round(durationMs / 1000), proxy);

    await browser.disconnect().catch(() => { });
  } finally {
    await cleanup();
  }
}


// ─── Semaphore Pool ───────────────────────────────────────────────────────────

/**
 * Runs tasks in parallel up to `limit` at a time.
 * When shutdownRequested is true, no NEW tasks are started, but
 * any already-running tasks are allowed to finish (graceful drain).
 */
async function runPool(tasks, limit, startGapMs) {
  const queue = [...tasks];
  let active = 0;
  let lastStart = 0;

  await new Promise((resolve) => {
    function tryStart() {
      // Paused: hold here and re-check after 500ms
      if (pauseRequested && !shutdownRequested) {
        setTimeout(tryStart, 500);
        return;
      }
      // Shutdown: drain active tasks then resolve
      while (!shutdownRequested && !pauseRequested && active < limit && queue.length > 0) {
        const gap = startGapMs - (Date.now() - lastStart);
        if (gap > 0) { setTimeout(tryStart, gap); return; }
        active++;
        lastStart = Date.now();
        const task = queue.shift();
        task().finally(() => {
          active--;
          tryStart();
          if (active === 0 && (queue.length === 0 || shutdownRequested)) resolve();
        });
      }
      if (shutdownRequested && active === 0) resolve();
      if (active === 0 && queue.length === 0) resolve();
    }
    tryStart();
  });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Run a single automation batch:
 *  1. Pick a random NUM target (from proxySampling total range)
 *  2. Draw fresh proxies from the pool one-by-one, testing each
 *  3. Stop drawing as soon as NUM live proxies are collected
 *  4. Create AdsPower profiles for live proxies → run sessions
 * Returns: 'done' | 'no-websites' | 'no-proxies' | 'no-live' | 'no-profiles' | 'no-slots'
 */
async function runBatch(freshPool, websites, cfg) {
  if (!websites.length) {
    logger.warn('No websites found to browse.');
    return 'no-websites';
  }
  if (!freshPool.length) {
    logger.warn('No fresh proxies remaining.');
    return 'no-proxies';
  }

  // ── 1. Pick target = random number in the Browser Concurrency range ───────
  //    This is exactly what the user configured: how many browsers to run per batch.
  const concMin = cfg.concurrency?.min ?? 3;
  const concMax = cfg.concurrency?.max ?? 5;
  const targetLive = randomInt(
    Math.min(concMin, freshPool.length),
    Math.min(concMax, freshPool.length)
  );
  logger.info(`\nTarget: ${targetLive} live proxies (concurrency min=${concMin} max=${concMax}, pool=${freshPool.length}).`);

  // ── 2. Shuffle the fresh pool and test one-by-one until quota met ────────
  //    We shuffle a COPY so the caller's freshPool array is not mutated.
  const shuffled = [...freshPool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const liveProxies = [];
  const testedProxies = []; // track all tested (live + dead) so we can remove from freshPool

  logger.info(`Testing proxies one-by-one until ${targetLive} live found…\n`);

  for (const proxy of shuffled) {
    if (shutdownRequested) break;
    if (pauseRequested) await waitWhilePaused();
    if (shutdownRequested) break;
    if (liveProxies.length >= targetLive) break;

    testedProxies.push(proxy);
    const ok = await testProxy(proxy);
    if (ok) {
      logger.info(`  ✓ LIVE   ${proxy.protocol}://${proxy.host}:${proxy.port} [${proxy.os}]  (${liveProxies.length + 1}/${targetLive})`);
      liveProxies.push(proxy);
    } else {
      logger.warn(`  \u2717 DEAD   ${proxy.protocol}://${proxy.host}:${proxy.port} [${proxy.os}] \u2014 removing from pool`);
      await removeProxyFromSource(proxy);
      // Remove dead proxy from the caller's copy of freshPool
      const idx = freshPool.findIndex(p => proxyKey(p) === proxyKey(proxy));
      if (idx !== -1) freshPool.splice(idx, 1);
    }
    await sleep(300);
  }

  logger.info(`\nProxy test complete: ${liveProxies.length} live found (tested ${testedProxies.length}).`);

  if (!liveProxies.length) {
    logger.error('No live proxies found in this batch. Check proxy credentials.');
    return 'no-live';
  }
  if (liveProxies.length < targetLive) {
    logger.warn(`Only ${liveProxies.length} of ${targetLive} target live proxies found — continuing with what we have.`);
  }

  // ── 3. Check AdsPower slot limit ────────────────────────────────────────
  const ADSPOWER_MAX = 22;
  const existingCount = await fetchExistingProfileCount();
  const availableSlots = Math.max(0, ADSPOWER_MAX - existingCount);
  logger.info(`AdsPower: ${existingCount} existing profile(s), ${availableSlots} slot(s) free (max ${ADSPOWER_MAX}).`);

  if (availableSlots === 0) {
    logger.warn('No AdsPower slots free. Delete old profiles and retry.');
    return 'no-slots';
  }

  const toCreate = liveProxies.slice(0, availableSlots);
  if (toCreate.length < liveProxies.length) {
    logger.warn(`Capped: creating ${toCreate.length} of ${liveProxies.length} live proxies (plan limit).`);
  }

  // ── 4. Create profiles sequentially ────────────────────────────────────
  logger.info(`\nCreating ${toCreate.length} profile(s)…`);
  const profileMap = [];
  for (let i = 0; i < toCreate.length; i++) {
    if (shutdownRequested) { logger.warn('Shutdown requested — stopping profile creation early.'); break; }
    const proxy = toCreate[i];
    const name = `auto_${proxy.os}_${Date.now()}_${i}`;
    try {
      const profileId = await createProfile(proxy, name);
      profileMap.push({ profileId, proxy });
    } catch (err) {
      logger.warn(`Profile create failed (${proxy.os}): ${err.message}`);
    }
    await sleep(randomInt(1500, 2000));
  }
  if (!profileMap.length) { logger.error('No profiles created. Aborting batch.'); return 'no-profiles'; }

  const concurrency = Math.min(
    randomInt(cfg.concurrency.min, cfg.concurrency.max),
    profileMap.length
  );
  logger.info(`\n${profileMap.length} profile(s) ready. Running ${concurrency} browser(s) at a time.`);

  // ── 5. Run sessions ─────────────────────────────────────────────────────
  const tasks = profileMap.map(({ profileId, proxy }) => async () => {
    const rawUrl = websites[randomInt(0, websites.length - 1)];
    const url = normalizeUrl(rawUrl);  // ensure https:// prefix
    if (url !== rawUrl) logger.info(`URL normalized: "${rawUrl}" → "${url}"`);
    try {
      await runSession(profileId, proxy, url);
    } catch (err) {
      logger.warn(`Session [${profileId}] failed: ${err.message}`);
      try { await deleteProfile(profileId); } catch (_) { }
      markProxyUsed(proxy);
    }
    // Remove this proxy from freshPool after it is used
    const idx = freshPool.findIndex(p => proxyKey(p) === proxyKey(proxy));
    if (idx !== -1) freshPool.splice(idx, 1);
  });

  await runPool(tasks, concurrency, cfg.minBrowserStartGapMs);
  logger.info('\n=== Batch complete ===');
  return 'done';
}

async function main() {
  const runMode = (process.env.RUN_MODE || 'once').toLowerCase();
  logger.info(`=== Money Money Money Automation Starting${userId ? ` (User: ${userId})` : ''} | mode: ${runMode} ===`);

  // \u2500\u2500 Load effective config: start with file defaults, overlay Supabase user settings \u2500\u2500
  let cfg = { ...config };
  let websites = [];
  let allProxies = [];
  let usedKeys = new Set();

  if (supabase && userId) {
    logger.info('Fetching data and settings from Supabase...');
    const [wRes, pRes, uRes, sRes] = await Promise.all([
      supabase.from('ads_website').select('url').eq('user_id', userId),
      supabase.from('ads_proxies').select('*').eq('user_id', userId),
      supabase.from('ads_used_proxies').select('host,port,pass').eq('user_id', userId),
      supabase.from('ads_settings').select('data').eq('user_id', userId).single(),
    ]);
    websites = (wRes.data || []).map(w => normalizeUrl(w.url));
    allProxies = (pRes.data || []).map(p => ({ ...p, protocol: p.protocol || 'socks5' }));
    usedKeys = new Set((uRes.data || []).map(p => proxyKey(p)));

    // Merge saved user settings on top of defaults so every knob works
    if (sRes.data?.data) {
      cfg = deepMerge(config, sRes.data.data);

      // Update the active API instance with user-specific AdsPower settings
      if (cfg.adsPower?.baseUrl) api.defaults.baseURL = cfg.adsPower.baseUrl;
      if (cfg.adsPower?.apiKey) {
        api.defaults.headers.common['Authorization'] = `Bearer ${cfg.adsPower.apiKey}`;
      } else {
        delete api.defaults.headers.common['Authorization'];
      }

      logger.info(`Settings loaded from Supabase — concurrency: ${cfg.concurrency.min}\u2013${cfg.concurrency.max}`);
    }
  } else {
    websites = loadJSON(config.paths.websites).map(normalizeUrl);
    allProxies = loadJSON(config.paths.proxies).map(parseProxyEntry).filter(Boolean);
    usedKeys = new Set(loadJSON(config.paths.usedProxies).map(p => proxyKey(p)));
    cfg = config; // already loaded from data/settings.json by config.js
  }

  // Make cfg accessible to runSession() via global so session timings always
  // reflect the user's saved settings, not the hard-coded file defaults
  global._effectiveCfg = cfg;


  // Rebuild the AdsPower API instance in case baseUrl/apiKey changed in settings
  if (cfg.adsPower?.baseUrl !== config.adsPower.baseUrl) {
    api.defaults.baseURL = cfg.adsPower.baseUrl;
    if (cfg.adsPower.apiKey)
      api.defaults.headers['Authorization'] = `Bearer ${cfg.adsPower.apiKey}`;
  }

  if (!websites.length) { logger.warn('No websites configured.'); return; }

  const freshPool = allProxies.filter(p => !usedKeys.has(proxyKey(p)));
  logger.info(`Proxy pool: ${allProxies.length} total, ${freshPool.length} fresh, ${usedKeys.size} used.`);
  if (!freshPool.length) { logger.warn('All proxies have been used. Exiting.'); return; }

  // \u2500\u2500 Run mode logic \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (runMode === 'all') {
    logger.info('Mode: RUN ALL \u2014 looping batches until all fresh proxies exhausted.');
    let batchNum = 0;

    while (freshPool.length > 0 && !shutdownRequested) {
      // Pause between batches if requested
      if (pauseRequested) await waitWhilePaused();
      if (shutdownRequested) break;

      batchNum++;
      logger.info(`\n${'\u2500'.repeat(60)}`);
      logger.info(`BATCH #${batchNum} \u2014 ${freshPool.length} fresh proxies remaining`);
      logger.info('\u2500'.repeat(60));

      const result = await runBatch(freshPool, websites, cfg);

      if (['no-proxies', 'no-live'].includes(result)) {
        logger.warn(`Batch #${batchNum} ended with "${result}" \u2014 stopping loop.`);
        break;
      }
      if (['no-websites', 'no-slots'].includes(result)) {
        logger.warn(`Batch #${batchNum} ended with "${result}" \u2014 cannot continue.`);
        break;
      }

      if (freshPool.length > 0 && !shutdownRequested) {
        logger.info('Cooling down 5s before next batch\u2026');
        await sleep(5000);
      }
    }

    logger.info(shutdownRequested
      ? '\n=== Graceful shutdown \u2014 all sessions finished ==='
      : `\n=== RUN ALL complete \u2014 ${batchNum} batch(es) done ===`);
  } else {
    logger.info('Mode: RUN ONCE \u2014 single batch then exit.');
    await runBatch(freshPool, websites, cfg);
    logger.info(shutdownRequested ? '\n=== Graceful shutdown complete ===' : '\n=== Run Once complete ===');
  }
}


// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  if (shutdownRequested) {
    logger.warn('Force-quit — killing immediately.');
    process.exit(1);
  }
  shutdownRequested = true;
  logger.warn('Shutdown requested — finishing current sessions before exit (press Ctrl+C again to force-quit)…');
});
process.on('SIGTERM', () => {
  shutdownRequested = true;
  logger.warn('SIGTERM — finishing current sessions before exit…');
});

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
