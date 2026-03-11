'use strict';

/**
 * AdsPower Dashboard — Express API + static server
 * Multi-user edition powered by Supabase Auth + Database
 * Run: node server.js  →  http://localhost:3000
 */

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const express = require('express');
const path = require('path');
const { spawn, fork } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ─── Helpers: Local JSON Storage ─────────────────────────────────────────────
// Use USER_DATA_PATH if passed (production), otherwise fallback to local data/
const DATA_DIR = process.env.USER_DATA_PATH
    ? path.join(process.env.USER_DATA_PATH, 'data')
    : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
        console.error(`[storage] Failed to create data dir: ${err.message}`);
    }
}

const DEFAULT_PATHS = {
    settings: path.join(DATA_DIR, 'settings.json'),
    proxies: path.join(DATA_DIR, 'proxy.json'),
    usedProxies: path.join(DATA_DIR, 'used_proxies.json'),
    websites: path.join(DATA_DIR, 'websites.json'),
    logs: path.join(DATA_DIR, 'logs.json'),
};


function loadJsonFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return [];
    }
}

function saveJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`[storage] Failed to save ${filePath}: ${err.message}`);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Local Mode Check ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const IS_LOCAL_MODE = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY;

if (IS_LOCAL_MODE) {
    console.warn('\n⚠️  Supabase environment variables missing. RUNNING IN LOCAL MODE.');
    console.log('    SUPABASE_URL:', SUPABASE_URL ? 'PRESENT' : 'MISSING');
    console.log('    SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? 'PRESENT' : 'MISSING');
    console.log('    SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_KEY ? 'PRESENT' : 'MISSING');
    console.warn('    Local storage (JSON) will be used instead of Supabase.\n');
}

// ─── Supabase clients ─────────────────────────────────────────────────────────
// (Only initialize if not in local mode)
const supabaseAdmin = IS_LOCAL_MODE ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    db: { schema: 'public' },
    auth: { autoRefreshToken: false, persistSession: false }
});

const supabaseAnon = IS_LOCAL_MODE ? null : createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'public' },
    auth: { autoRefreshToken: false, persistSession: false }
});


// ─── Auth middleware ───────────────────────────────────────────────────────────
// Keep track of active background creation tasks
const creationTasks = new Map(); // userId -> count

/**
 * requireAuth — validates the Bearer token from Authorization header
 * Attaches req.user (Supabase user object) and req.supabase (user-scoped client)
 */
async function requireAuth(req, res, next) {
    if (IS_LOCAL_MODE) {
        req.user = { id: 'local-user', email: 'local@automation.internal' };
        req.supabase = null; // Should not be used in local mode
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : (req.query.token || null);

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized — missing token' });
    }

    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized — invalid token' });
    }

    req.user = user;
    req.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        db: { schema: 'public' },
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false }
    });

    next();
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ─── Public page routes ────────────────────────────────────────────────────────
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));

// ─── Auth APIs ────────────────────────────────────────────────────────────────
// Sign Up
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'email and password required' });

        const { data, error } = await supabaseAnon.auth.signUp({ email, password });
        if (error) return res.status(400).json({ error: error.message });

        res.json({
            ok: true,
            message: 'Account created! Check your email to confirm your account.',
            user: { id: data.user?.id, email: data.user?.email }
        });
    } catch (err) {
        console.error('[auth:signup] Critical error:', err.message);
        if (IS_LOCAL_MODE) {
            return res.status(503).json({ error: 'Sign up unavailable in Local Mode. Please provide Supabase credentials in .env' });
        }
        res.status(500).json({ error: 'Sign up failed: Could not connect to Supabase.' });
    }
});

// Sign In
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'email and password required' });

        const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ ok: false, error: error.message });

        res.json({
            ok: true,
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_in: data.session.expires_in,
            user: { id: data.user.id, email: data.user.email }
        });
    } catch (err) {
        console.error('[auth:login] Critical error:', err.message);
        if (IS_LOCAL_MODE) {
            return res.status(503).json({ error: 'Auth unavailable in Local Mode. Please provide Supabase credentials in .env' });
        }
        res.status(500).json({ error: 'Auth failed: Could not connect to Supabase.' });
    }
});

// Refresh token
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body || {};
        if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

        const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token });
        if (error) return res.status(401).json({ error: error.message });

        res.json({
            ok: true,
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_in: data.session.expires_in
        });
    } catch (err) {
        res.status(500).json({ error: 'Refresh failed: Could not connect to Supabase.' });
    }
});

// Sign Out
app.post('/api/auth/logout', async (req, res) => {
    // JWT is stateless; client just drops the token. Optionally revoke server-side.
    res.json({ ok: true });
});

// Serve static files (index.html, login.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ─── Protected middleware (all routes below require auth) ─────────────────────
app.use('/api', requireAuth);

// ─── Helpers ───────────────────────────────────────────────────────────────────
const KNOWN_OS = new Set(['windows', 'mac', 'android', 'linux', 'ios', 'iphone']);

function parseProxyUrl(str, defaultOs = 'windows') {
    let raw = str.trim();
    if (!/^[a-z0-9]+:\/\//i.test(raw)) {
        raw = 'socks5://' + raw; // Default to socks5 if no protocol
    }
    const m = raw.match(/^(socks5|socks4|https?):\/\/(.+)$/i);
    if (!m) return null;
    const parts = m[2].split(':');
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    let user = parts[2] || '';
    let pass = '';
    const last = parts[parts.length - 1]?.toLowerCase() || '';
    let os;

    if (parts.length >= 4) {
        if (KNOWN_OS.has(last)) {
            os = last;
            pass = parts.slice(3, -1).join(':');
        } else {
            os = defaultOs;
            pass = parts.slice(3).join(':');
        }
    } else {
        os = defaultOs;
        if (parts.length === 2) {
            user = ''; pass = '';
        } else if (parts.length === 3) {
            user = parts[2]; pass = '';
        }
    }
    if (!host || isNaN(port)) return null;
    return { host, port, user, pass, protocol: m[1].toLowerCase(), os };
}

function normalizeProxy(entry, defaultOs = 'windows') {
    if (typeof entry === 'string') return parseProxyUrl(entry, defaultOs);
    if (entry && typeof entry === 'object') {
        const cleanOs = (defaultOs || entry.os || 'windows').toLowerCase();
        return { ...entry, os: cleanOs };
    }
    return null;
}

function proxyKey(p) {
    if (!p) return '';
    return `${(p.protocol || 'socks5').toLowerCase()}://${(p.host || '').toLowerCase()}:${p.port}:${(p.user || '').toLowerCase()}:${(p.pass || '').toLowerCase()}`;
}

// ─── Settings Defaults ───────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    adsPower: { baseUrl: 'http://127.0.0.1:50325', apiKey: '' },
    proxySampling: { windows: { min: 5, max: 15 }, mac: { min: 2, max: 8 }, android: { min: 3, max: 12 } },
    concurrency: { min: 3, max: 5 },
    minBrowserStartGapMs: 4000,
    headlessMode: false,
    session: { minDurationSeconds: 50, maxDurationSeconds: 70, clickProbability: 0.35 },
    groupId: '0',
    cookie: '',
    openUrls: [],
    fingerprint: {
        userAgent: '', webrtc: 'proxy',
        timezone: 'based-on-ip', customTimezone: '',
        location: 'based-on-ip', customLatitude: '', customLongitude: '', customAccuracy: '100',
        language: 'based-on-ip', customLanguage: 'en-US,en', displayLanguage: 'based-on-language',
        screenResolution: 'random', customResolution: '1920x1080',
        fonts: 'default', customFonts: [],
        canvasNoise: true, webglNoise: true, audioNoise: true,
        mediaDevicesNoise: true, clientRectsNoise: true, speechVoicesNoise: true,
        webglMetadata: 'custom',
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        webgpu: 'based-on-webgl',
        randomFingerprint: false,
    },
};

// (Moved proxyKey up)

async function removeProxyFromAdsPower(userId, proxyHost, db) {
    try {
        let baseUrl = 'http://127.0.0.1:50325';
        let apiKey = '';

        if (IS_LOCAL_MODE) {
            const settings = loadJsonFile(DEFAULT_PATHS.settings);
            baseUrl = settings.adsPower?.baseUrl || baseUrl;
            apiKey = settings.adsPower?.apiKey || apiKey;
        } else {
            const { data: sRes } = await db.from('ads_settings').select('data').eq('user_id', userId).single();
            const settings = deepMerge(DEFAULT_SETTINGS, sRes?.data || {});
            baseUrl = settings.adsPower?.baseUrl || baseUrl;
            apiKey = settings.adsPower?.apiKey || apiKey;
        }

        if (!baseUrl) return;

        const api = axios.create({
            baseURL: baseUrl,
            timeout: 20000,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
        });

        const res = await api.get('/api/v1/user/list', { params: { page_size: 100 } }).catch(() => null);
        const list = res?.data?.list || res?.data?.data?.list;
        if (!list) return;

        const toDelete = list
            .filter(p => p.user_proxy_config?.proxy_host === proxyHost || p.ip === proxyHost)
            .map(p => p.user_id);

        if (toDelete.length > 0) {
            console.log(`[AdsPower] Cleaning up ${toDelete.length} profile(s) for proxy host ${proxyHost}...`);
            await api.post('/api/v1/user/delete', { user_ids: toDelete }).catch(() => null);
        }
    } catch (err) {
        console.warn(`[AdsPower] Cleanup skip for ${proxyHost}: ${err.message}`);
    }
}

function buildFingerprintConfig(proxy, fp, osInput) {
    const effectiveOs = (osInput || 'windows').toLowerCase();
    const osMap = { windows: 0, mac: 1, ios: 2, iphone: 2, android: 3 };
    const osPlatform = osMap[effectiveOs] ?? 0;

    let resolution = '1366x768';
    if (fp?.screenResolution === 'random') {
        const resolutions = ['1366x768', '1920x1080', '1440x900', '1280x800', '1600x900', '1280x1024', '1024x768', '2560x1440'];
        resolution = resolutions[Math.floor(Math.random() * resolutions.length)];
    } else if (fp?.screenResolution === 'custom' && fp?.customResolution) {
        resolution = fp.customResolution;
    }

    let language = ['en-US', 'en'];
    if (fp?.language === 'custom' && fp?.customLanguage) {
        language = fp.customLanguage.split(',').map(l => l.trim()).filter(Boolean);
    }

    let automaticTimezone = '1';
    let timezone = '';
    if (fp?.timezone === 'real') {
        automaticTimezone = '0';
        timezone = 'UTC'; // Placeholder or system TZ
    } else if (fp?.timezone === 'custom' && fp?.customTimezone) {
        automaticTimezone = '0';
        timezone = fp.customTimezone;
    }

    const webrtcMap = { forward: 'forward', replace: 'proxy', real: 'local', disabled: 'disabled', proxy: 'proxy', local: 'local', disable_udp: 'disable_udp' };
    const webrtcMode = webrtcMap[fp?.webrtc || 'proxy'] ?? 'proxy';

    const fingerprintResult = {
        automatic_timezone: automaticTimezone,
        timezone,
        language,
        ua: fp?.userAgent || '',
        resolution,
        fonts: (fp?.fonts === 'custom' && Array.isArray(fp?.customFonts)) ? fp.customFonts : [],
        platform: osPlatform,
        webrtc: webrtcMode,
        canvas: fp?.canvasNoise === false ? 0 : 1,
        webgl: fp?.webglNoise === false ? 0 : 1,
        audio: fp?.audioNoise === false ? 0 : 1,
        media_devices: fp?.mediaDevicesNoise === false ? 0 : 1,
        client_rects: fp?.clientRectsNoise === false ? 0 : 1,
        speech_voices: fp?.speechVoicesNoise === false ? 0 : 1,
        webgl_config: {
            vendor: fp?.webglVendor || 'Google Inc. (Intel)',
            renderer: fp?.webglRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
            webgl_type: fp?.webglMetadata === 'real' ? 1 : 0,
        }
    };

    if (fp?.location === 'custom' && fp?.customLatitude && fp?.customLongitude) {
        fingerprintResult.location = 1;
        fingerprintResult.latitude = parseFloat(fp.customLatitude);
        fingerprintResult.longitude = parseFloat(fp.customLongitude);
        fingerprintResult.accuracy = fp.customAccuracy ? parseFloat(fp.customAccuracy) : 100;
    }

    // Generate randomized User-Agent instructions targeting the specific OS
    if (fp?.randomFingerprint || !fp?.userAgent) {
        // Map our internal OS strings to AdsPower's random_ua platform strings
        let browserOs = 'Windows';
        if (effectiveOs === 'mac') browserOs = 'Mac OS X';
        else if (effectiveOs === 'android') browserOs = 'Android';
        else if (effectiveOs === 'ios' || effectiveOs === 'iphone') browserOs = 'iOS';

        fingerprintResult.random_ua = {
            ua_browser: ['chrome'],
            ua_system_version: [browserOs]
        };
        // Ensure hardcoded UA doesn't override random_ua for the wrong OS
        fingerprintResult.ua = '';
    } else {
        console.log(`[buildFingerprintConfig] Using hardcoded UA: ${fp.userAgent}. This might conflict with effectiveOs: ${effectiveOs}`);
    }

    return fingerprintResult;
}

async function createAdsPowerProfile(userId, proxy, settings, db) {
    const { baseUrl, apiKey } = settings.adsPower;
    if (!baseUrl) throw new Error('AdsPower Base URL not set');

    const api = axios.create({
        baseURL: baseUrl,
        timeout: 25000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    });

    const fp = settings.fingerprint || {};
    const effectiveOs = (proxy.os || 'windows').toLowerCase();
    const fingerprintConfig = buildFingerprintConfig(proxy, fp, effectiveOs);

    const name = `Profile-${proxy.host.slice(-6)}-${Math.floor(Math.random() * 999)}`;
    const body = {
        name,
        os_type: effectiveOs,
        platform: fingerprintConfig.platform, // Ensure root level platform is set
        group_id: settings.groupId || '0',
        domain_name: '',
        open_urls: Array.isArray(settings.openUrls) ? settings.openUrls : [],
        username: '', password: '', fakey: '',
        cookie: settings.cookie || '',
        ignore_cookie_error: '1',
        sys_app_cate_id: '0',
        user_proxy_config: {
            proxy_soft: 'other',
            proxy_type: proxy.protocol || 'socks5',
            proxy_host: proxy.host,
            proxy_port: String(proxy.port),
            proxy_user: proxy.user || '',
            proxy_password: proxy.pass || '',
        },
        fingerprint_config: fingerprintConfig,
    };

    console.log(`\n--- CREATING PROFILE: ${proxy.host} ---`);
    console.log(`Requested OS: ${effectiveOs}`);
    console.log(`Request Body:`, JSON.stringify(body, null, 2));

    const res = await api.post('/api/v1/user/create', body);
    console.log(`AdsPower API Response:`, JSON.stringify(res.data));
    if (res.data.code !== 0) throw new Error(res.data.msg);
    return res.data.data;
}

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

// ─── SSE log streaming (per-user map) ────────────────────────────────────────
const userLogClients = new Map();  // userId → [res, ...]
const userLogBuffers = new Map();  // userId → string[]
const userAutomations = new Map(); // userId → child_process

function getUserClients(userId) {
    if (!userLogClients.has(userId)) userLogClients.set(userId, []);
    return userLogClients.get(userId);
}

function getUserBuffer(userId) {
    if (!userLogBuffers.has(userId)) userLogBuffers.set(userId, []);
    return userLogBuffers.get(userId);
}

function broadcastToUser(userId, line) {
    const msg = JSON.stringify({ time: new Date().toISOString(), line });
    const buf = getUserBuffer(userId);
    buf.push(msg);
    if (buf.length > 600) buf.shift();

    const clients = getUserClients(userId);
    const alive = clients.filter(res => {
        try { res.write(`data: ${msg}\n\n`); return true; } catch (_) { return false; }
    });
    userLogClients.set(userId, alive);
}

// ─── SSE Logs ─────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
    const userId = req.user.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send last 150 buffered lines
    getUserBuffer(userId).slice(-150).forEach(e => res.write(`data: ${e}\n\n`));
    getUserClients(userId).push(res);

    req.on('close', () => {
        const clients = getUserClients(userId);
        userLogClients.set(userId, clients.filter(c => c !== res));
    });
});

// ─── Automation control ──────────────────────────────────────────────────────────
const userPauseStates = new Map(); // userId => true/false

// Helper: spawn index.js, pipe stdout/stderr to SSE log, wire up cleanup
function spawnAutomation(userId, runMode) {
    if (userAutomations.has(userId)) return null;
    userLogBuffers.set(userId, []);
    userPauseStates.set(userId, false);
    broadcastToUser(userId, `=== Starting Automation [mode: ${runMode}] ===`);

    const scriptPath = path.join(__dirname, 'index.js');

    // In production, __dirname is inside app.asar. fork() requires a REAL directory for 'cwd'.
    // We already set process.cwd() to a real directory (resources/) in main.js.
    const realCwd = __dirname.includes('app.asar') ? process.cwd() : __dirname;

    const options = {
        cwd: realCwd,
        env: {
            ...process.env,
            AUTOMATION_USER_ID: userId,
            RUN_MODE: runMode,
            ELECTRON_RUN_AS_NODE: '1'
        },
        silent: true,  // Piped stdout, stderr, and stdin
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execPath: process.execPath, // Ensure we use the same Electron binary
    };

    console.log(`[server] Spawning automation: ${scriptPath} in ${realCwd}`);
    broadcastToUser(userId, `[system] Initializing engine process...`);

    try {
        const proc = fork(scriptPath, [], options);
        userAutomations.set(userId, proc);

        const pipe = d => {
            if (!d) return;
            d.toString().split(/\r?\n/).forEach(line => {
                const trimmed = line.trim();
                if (trimmed) broadcastToUser(userId, trimmed);
            });
        };

        if (proc.stdout) {
            proc.stdout.on('data', pipe);
            console.log(`[server] Automation stdout piped (pid ${proc.pid})`);
        }
        if (proc.stderr) {
            proc.stderr.on('data', pipe);
            console.log(`[server] Automation stderr piped (pid ${proc.pid})`);
        }

        proc.on('spawn', () => {
            console.log(`[server] Automation process spawned (pid ${proc.pid})`);
            broadcastToUser(userId, `[system] Engine process spawned (pid ${proc.pid})`);
        });

        proc.on('error', (err) => {
            console.error(`[server] Failed to start automation process:`, err);
            broadcastToUser(userId, `!!! ERROR spawning automation: ${err.message}`);
        });

        proc.on('close', code => {
            console.log(`[server] Automation process exited with code ${code}`);
            broadcastToUser(userId, `=== EXITED (code ${code ?? 0}) ===`);
            userAutomations.delete(userId);
            userPauseStates.delete(userId);
        });

        return proc;
    } catch (err) {
        console.error(`[server] Critical error spawning automation:`, err);
        broadcastToUser(userId, `!!! CRITICAL ERROR: ${err.message}`);
        return null;
    }
}

app.get('/api/status', (req, res) => {
    const userId = req.user.id;
    res.json({
        running: userAutomations.has(userId),
        paused: userPauseStates.get(userId) || false,
    });
});

app.post('/api/run', (req, res) => {
    const userId = req.user.id;
    const runMode = (['once', 'all'].includes(req.body?.runMode)) ? req.body.runMode : 'once';
    const proc = spawnAutomation(userId, runMode);
    if (!proc) return res.status(400).json({ error: 'Already running' });
    res.json({ started: true, runMode });
});

app.post('/api/run/once', (req, res) => {
    const proc = spawnAutomation(req.user.id, 'once');
    if (!proc) return res.status(400).json({ error: 'Already running' });
    res.json({ started: true, runMode: 'once' });
});

app.post('/api/run/all', (req, res) => {
    const proc = spawnAutomation(req.user.id, 'all');
    if (!proc) return res.status(400).json({ error: 'Already running' });
    res.json({ started: true, runMode: 'all' });
});

app.post('/api/pause', (req, res) => {
    const userId = req.user.id;
    const proc = userAutomations.get(userId);
    if (!proc) return res.status(400).json({ error: 'Not running' });
    if (userPauseStates.get(userId)) return res.json({ paused: true }); // already paused
    userPauseStates.set(userId, true);
    proc.stdin.write('PAUSE\n');
    broadcastToUser(userId, '=== ⏸ Automation paused — batches will wait after current sessions finish ===');
    res.json({ paused: true });
});

app.post('/api/resume', (req, res) => {
    const userId = req.user.id;
    const proc = userAutomations.get(userId);
    if (!proc) return res.status(400).json({ error: 'Not running' });
    userPauseStates.set(userId, false);
    proc.stdin.write('RESUME\n');
    broadcastToUser(userId, '=== ▶ Automation resumed ===');
    res.json({ paused: false });
});

app.post('/api/stop', (req, res) => {
    const userId = req.user.id;
    const proc = userAutomations.get(userId);
    if (proc) {
        // If paused, resume first so the process isn't stuck waiting
        if (userPauseStates.get(userId)) proc.stdin.write('RESUME\n');
        userPauseStates.set(userId, false);
        broadcastToUser(userId, '=== ⏹ Stop requested — finishing current sessions gracefully… ===');
        proc.kill('SIGINT');
    }
    res.json({ stopped: true });
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
    if (IS_LOCAL_MODE) {
        const proxies = loadJsonFile(DEFAULT_PATHS.proxies);
        const used = loadJsonFile(DEFAULT_PATHS.usedProxies);
        const websites = loadJsonFile(DEFAULT_PATHS.websites);
        const running = userAutomations.has(req.user.id);

        let activeProfiles = 0;
        const settings = loadJsonFile(DEFAULT_PATHS.settings);
        const { baseUrl, apiKey } = settings.adsPower || {};
        if (baseUrl) {
            try {
                const api = axios.create({ baseURL: baseUrl, timeout: 5000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
                const resp = await api.get('/api/v1/user/list', { params: { page_size: 1 } }).catch(() => null);
                activeProfiles = resp?.data?.data?.page_info?.total_count || resp?.data?.page_info?.total_count || 0;
            } catch (_) { }
        }

        return res.json({
            totalProxies: proxies.length,
            usedProxies: used.length,
            freshProxies: proxies.length - used.length,
            websites: websites.length,
            activeProfiles,
            running
        });
    }
    const db = req.supabase;
    const userId = req.user.id;

    const [
        { count: totalProxies },
        { count: usedCount },
        { count: websites },
        sRes
    ] = await Promise.all([
        db.from('ads_proxies').select('*', { count: 'exact', head: true }),
        db.from('ads_used_proxies').select('*', { count: 'exact', head: true }),
        db.from('ads_website').select('*', { count: 'exact', head: true }),
        db.from('ads_settings').select('data').eq('user_id', userId).single()
    ]);

    const settings = deepMerge(DEFAULT_SETTINGS, sRes?.data || {});
    const { baseUrl, apiKey } = settings.adsPower;
    let activeProfiles = 0;
    if (baseUrl) {
        try {
            const api = axios.create({ baseURL: baseUrl, timeout: 5000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
            const resp = await api.get('/api/v1/user/list', { params: { page_size: 1 } }).catch(() => null);
            activeProfiles = resp?.data?.data?.page_info?.total_count || resp?.data?.page_info?.total_count || 0;
        } catch (_) { }
    }

    const { data: proxies } = await db.from('ads_proxies').select('*');
    const { data: used } = await db.from('ads_used_proxies').select('*');
    const usedKeys = new Set((used || []).map(p => proxyKey(p)));
    const freshProxies = (proxies || []).filter(p => !usedKeys.has(proxyKey(p))).length;

    res.json({
        totalProxies: totalProxies || 0,
        usedProxies: usedCount || 0,
        freshProxies,
        websites: websites || 0,
        activeProfiles,
        creatingProfiles: creationTasks.get(userId) || 0,
        running: userAutomations.has(userId)
    });
});

// ─── Profiles ─────────────────────────────────────────────────────────────────
app.get('/api/profiles/list', async (req, res) => {
    const userId = req.user.id;
    const db = req.supabase;
    let settings;
    if (IS_LOCAL_MODE) {
        settings = deepMerge(DEFAULT_SETTINGS, loadJsonFile(DEFAULT_PATHS.settings));
    } else {
        const { data } = await db.from('ads_settings').select('data').eq('user_id', userId).single();
        settings = deepMerge(DEFAULT_SETTINGS, data?.data || {});
    }

    const { baseUrl, apiKey } = settings.adsPower;
    if (!baseUrl) return res.json({ list: [] });

    try {
        console.log(`[profiles:list] Fetching from AdsPower: ${baseUrl}`);
        const api = axios.create({ baseURL: baseUrl, timeout: 25000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
        const resp = await api.get('/api/v1/user/list', { params: { page_size: 100 } });
        
        if (resp.data.code !== 0) {
            console.warn(`[profiles:list] AdsPower API returned error code ${resp.data.code}: ${resp.data.msg}`);
            return res.json({ list: [], error: resp.data.msg });
        }

        const rawList = resp?.data?.data?.list || resp?.data?.list || [];
        console.log(`[profiles:list] Found ${rawList.length} profiles.`);
        res.json({ list: rawList });
    } catch (err) {
        console.error(`[profiles:list] Connection failed: ${err.message}`);
        res.status(500).json({ error: `Connection to AdsPower failed: ${err.message}. Ensure AdsPower is running and API is enabled.` });
    }
});

app.post('/api/profiles/create', async (req, res) => {
    const userId = req.user.id;
    const db = req.supabase;
    const { source, proxies: reqProxies, defaultOs = 'windows' } = req.body;

    let settings;
    if (IS_LOCAL_MODE) {
        settings = deepMerge(DEFAULT_SETTINGS, loadJsonFile(DEFAULT_PATHS.settings));
    } else {
        const { data: s } = await db.from('ads_settings').select('data').eq('user_id', userId).single();
        settings = deepMerge(DEFAULT_SETTINGS, s?.data || {});
    }

    let targets = [];
    if (source === 'new' && Array.isArray(reqProxies)) {
        // Parse raw bulk strings and force the user's selected defaultOs
        targets = reqProxies.map(p => {
            const normalized = normalizeProxy(p, defaultOs);
            if (normalized) normalized.os = defaultOs; // Force override
            return normalized;
        }).filter(Boolean);

        // Add to database if new
        if (IS_LOCAL_MODE) {
            const pool = loadJsonFile(DEFAULT_PATHS.proxies);
            targets.forEach(t => { if (!pool.find(p => proxyKey(p) === proxyKey(t))) pool.push(t); });
            saveJsonFile(DEFAULT_PATHS.proxies, pool);
        } else {
            const toInsert = targets.map(t => ({ user_id: userId, ...t }));
            const { data: existing } = await db.from('ads_proxies').select('*');
            const exKeys = new Set((existing || []).map(p => proxyKey(p)));
            const uniqueToInsert = toInsert.filter(t => !exKeys.has(proxyKey(t)));
            if (uniqueToInsert.length > 0) {
                await db.from('ads_proxies').insert(uniqueToInsert);
            }
        }
    } else if (source === 'existing' && Array.isArray(reqProxies)) {
        // Force the user's selected defaultOs even on existing proxies
        targets = reqProxies.map(p => ({ ...p, os: defaultOs }));
    } else {
        return res.status(400).json({ error: 'Invalid source or proxies' });
    }

    if (!targets.length) return res.json({ error: 'Selected proxies could not be parsed. Ensure they follow the format: host:port:user:pass' });

    res.json({ message: `Success! Creating ${targets.length} profile(s). You can close this modal.` });

    (async () => {
        creationTasks.set(userId, (creationTasks.get(userId) || 0) + targets.length);
        
        // Fetch existing profiles to avoid duplicates (first 200)
        let existingProfiles = [];
        try {
            const { baseUrl, apiKey } = settings.adsPower;
            const api = axios.create({ baseURL: baseUrl, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
            const listRes = await api.get('/api/v1/user/list', { params: { page_size: 100 } });
            existingProfiles = listRes?.data?.data?.list || [];
        } catch (err) {
            console.warn('Existing profile check failed:', err.message);
        }

        for (const p of targets) {
            try {
                // (Overwrite check removed to allow multiple profiles per proxy)
                await createAdsPowerProfile(userId, p, settings, db);

                if (IS_LOCAL_MODE) {
                    const uPool = loadJsonFile(DEFAULT_PATHS.usedProxies);
                    if (!uPool.find(up => proxyKey(up) === proxyKey(p))) {
                        uPool.push({ ...p, usedAt: new Date().toISOString() });
                        saveJsonFile(DEFAULT_PATHS.usedProxies, uPool);
                    }
                } else {
                    await db.from('ads_used_proxies').insert({
                        user_id: userId, host: p.host, port: p.port, user: p.user, pass: p.pass,
                        protocol: p.protocol, os: p.os
                    });
                }
                await new Promise(resolve => setTimeout(resolve, 2400));
            } catch (err) {
                console.error(`Failed to create profile for ${p.host}: ${err.message}`);
            } finally {
                const current = creationTasks.get(userId) || 1;
                if (current <= 1) creationTasks.delete(userId);
                else creationTasks.set(userId, current - 1);
            }
        }
    })();
});

app.post('/api/profiles/cleanup', async (req, res) => {
    const userId = req.user.id;
    const db = req.supabase;
    let proxies;
    if (IS_LOCAL_MODE) {
        proxies = loadJsonFile(DEFAULT_PATHS.proxies);
    } else {
        const { data } = await db.from('ads_proxies').select('host');
        proxies = data;
    }

    const hosts = [...new Set((proxies || []).map(p => p.host))];
    hosts.forEach(h => removeProxyFromAdsPower(userId, h, db));

    res.json({ message: 'Cleanup started' });
});

app.delete('/api/profiles/:id', async (req, res) => {
    const userId = req.user.id;
    const profileId = req.params.id;
    const db = req.supabase;
    let settings;
    if (IS_LOCAL_MODE) {
        settings = deepMerge(DEFAULT_SETTINGS, loadJsonFile(DEFAULT_PATHS.settings));
    } else {
        const { data } = await db.from('ads_settings').select('data').eq('user_id', userId).single();
        settings = deepMerge(DEFAULT_SETTINGS, data?.data || {});
    }
    const { baseUrl, apiKey } = settings.adsPower;
    try {
        const api = axios.create({ baseURL: baseUrl, timeout: 25000, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
        await api.post('/api/v1/user/delete', { user_ids: [profileId] });
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Logs (Success History) ───────────────────────────────────────────────────
app.get('/api/success-logs', async (req, res) => {
    if (IS_LOCAL_MODE) {
        const logs = loadJsonFile(DEFAULT_PATHS.logs);
        return res.json(logs.slice(-200).reverse());
    }
    const db = req.supabase;
    const userId = req.user.id;
    const { data: logs, error } = await db.from('ads_logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(logs || []);
});

app.post('/api/success-logs/clear', async (req, res) => {
    if (IS_LOCAL_MODE) {
        saveJsonFile(DEFAULT_PATHS.logs, []);
        return res.json({ ok: true });
    }
    const db = req.supabase;
    const userId = req.user.id;
    const { error } = await db.from('ads_logs').delete().eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─── Proxies ──────────────────────────────────────────────────────────────────
app.get('/api/proxies', async (req, res) => {
    if (IS_LOCAL_MODE) {
        const proxies = loadJsonFile(DEFAULT_PATHS.proxies);
        const used = loadJsonFile(DEFAULT_PATHS.usedProxies);
        const usedKeys = new Set((used || []).map(p => proxyKey(p)));
        return res.json(proxies.map(p => {
            const parsed = normalizeProxy(p);
            // Return parsed info for the table, but the key must match what the list expects
            return {
                ...parsed,
                used: usedKeys.has(proxyKey(parsed)),
                key: proxyKey(parsed)
            };
        }));
    }
    const db = req.supabase;
    const { data: proxies, error } = await db.from('ads_proxies').select('*').order('created_at');
    if (error) return res.status(500).json({ error: error.message });

    const { data: used } = await db.from('ads_used_proxies').select('*');
    const usedKeys = new Set((used || []).map(p => proxyKey(p)));

    res.json((proxies || []).map(p => ({ ...p, used: usedKeys.has(proxyKey(p)), key: proxyKey(p) })));
});

app.post('/api/proxies/add', async (req, res) => {
    const { entries, defaultOs = 'windows' } = req.body;
    if (!Array.isArray(entries) || entries.length === 0)
        return res.status(400).json({ error: 'entries array required' });

    if (IS_LOCAL_MODE) {
        const pool = loadJsonFile(DEFAULT_PATHS.proxies);
        const existingKeys = new Set(pool.map(p => proxyKey(normalizeProxy(p))));
        let addedCount = 0;
        for (const e of entries) {
            const p = normalizeProxy(e, defaultOs);
            if (!p || existingKeys.has(proxyKey(p))) continue;
            pool.push(p);
            existingKeys.add(proxyKey(p));
            addedCount++;
        }
        if (addedCount > 0) saveJsonFile(DEFAULT_PATHS.proxies, pool);
        return res.json({ added: addedCount });
    }

    const db = req.supabase;
    const userId = req.user.id;
    // ... rest of the supabase logic ...
    const { data: existing } = await db.from('ads_proxies').select('*');
    const existingKeys = new Set((existing || []).map(p => proxyKey(p)));

    const toInsert = [];
    for (const e of entries) {
        const p = normalizeProxy(e, defaultOs);
        if (!p) continue;
        if (existingKeys.has(proxyKey(p))) continue;
        existingKeys.add(proxyKey(p));
        toInsert.push({ user_id: userId, ...p });
    }

    if (toInsert.length === 0) return res.json({ added: 0 });

    const { error } = await db.from('ads_proxies').insert(toInsert);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ added: toInsert.length });
});

app.delete('/api/proxies', async (req, res) => {
    const { keys } = req.body;
    const userId = req.user.id;

    if (IS_LOCAL_MODE) {
        let pool = loadJsonFile(DEFAULT_PATHS.proxies);
        let matches = [];
        console.log(`[local] Deleting proxies. Pool size: ${pool.length}, Requested keys: ${JSON.stringify(keys)}`);

        if (Array.isArray(keys) && keys.length) {
            matches = pool.filter(p => {
                const pKey = proxyKey(normalizeProxy(p));
                const match = keys.includes(pKey);
                if (match) console.log(`[local] Match found for deletion: ${pKey}`);
                return match;
            });
            pool = pool.filter(p => !keys.includes(proxyKey(normalizeProxy(p))));
            console.log(`[local] Deletion complete. Matches found: ${matches.length}, New pool size: ${pool.length}`);
        } else {
            matches = [...pool];
            pool = [];
            console.log(`[local] Deleting ALL proxies for this user.`);
        }
        saveJsonFile(DEFAULT_PATHS.proxies, pool);

        // Background AdsPower cleanup
        const hosts = [...new Set(matches.map(p => {
            const parsed = normalizeProxy(p);
            return parsed ? parsed.host : null;
        }).filter(Boolean))];
        hosts.forEach(h => removeProxyFromAdsPower(userId, h, null));

        return res.json({ deleted: true });
    }

    const db = req.supabase;
    if (Array.isArray(keys) && keys.length) {
        // 1. Get hostnames before deleting to clean up AdsPower later
        console.log(`[proxy:delete] Attempting to delete ${keys.length} proxies for user ${userId}`);
        const { data: all, error: fetchErr } = await db.from('ads_proxies').select('*');
        if (fetchErr) {
            console.error('[proxy:delete] Fetch error:', fetchErr.message);
            return res.status(500).json({ error: fetchErr.message });
        }

        const matches = (all || []).filter(p => keys.includes(proxyKey(p)));
        const ids = matches.map(p => p.id);
        const hosts = [...new Set(matches.map(p => p.host))];

        console.log(`[proxy:delete] Found ${ids.length} matching IDs in DB out of ${keys.length} requested keys`);

        if (ids.length) {
            // 2. Delete from Supabase
            const { error: delErr } = await db.from('ads_proxies').delete().in('id', ids);
            if (delErr) {
                console.error('[proxy:delete] Delete error:', delErr.message);
                return res.status(500).json({ error: delErr.message });
            }
            // 3. Trigger AdsPower cleanup in background
            hosts.forEach(h => removeProxyFromAdsPower(userId, h, db));
            return res.json({ deleted: true, count: ids.length });
        } else {
            console.warn('[proxy:delete] No matches found for keys:', keys);
            return res.status(404).json({ error: 'No matching proxies found in database' });
        }
    } else {
        // Delete all proxies for this user
        console.log(`[proxy:delete] Deleting ALL proxies for user ${userId}`);
        const { data: all } = await db.from('ads_proxies').select('host');
        const hosts = [...new Set((all || []).map(p => p.host))];

        const { error: delErr } = await db.from('ads_proxies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (delErr) {
            console.error('[proxy:delete] Delete all error:', delErr.message);
            return res.status(500).json({ error: delErr.message });
        }

        // Background cleanup
        hosts.forEach(h => removeProxyFromAdsPower(userId, h, db));
        res.json({ deleted: true, all: true });
    }
});

// ─── Used proxies ─────────────────────────────────────────────────────────────
app.get('/api/used-proxies', async (req, res) => {
    if (IS_LOCAL_MODE) {
        return res.json(loadJsonFile(DEFAULT_PATHS.usedProxies));
    }
    const { data, error } = await req.supabase.from('ads_used_proxies').select('*').order('used_at');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

app.delete('/api/used-proxies', async (req, res) => {
    if (IS_LOCAL_MODE) {
        saveJsonFile(DEFAULT_PATHS.usedProxies, []);
        return res.json({ cleared: true });
    }
    await req.supabase.from('ads_used_proxies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    res.json({ cleared: true });
});

// ─── Websites ─────────────────────────────────────────────────────────────────
app.get('/api/websites', async (req, res) => {
    if (IS_LOCAL_MODE) {
        const list = loadJsonFile(DEFAULT_PATHS.websites);
        return res.json(list.map(w => typeof w === 'string' ? normalizeUrl(w) : normalizeUrl(w.url)));
    }
    const { data, error } = await req.supabase.from('ads_website').select('id,url').order('created_at');
    if (error) return res.status(500).json({ error: error.message });
    // Normalize on read too — fixes any bare URLs saved before this patch
    res.json((data || []).map(w => normalizeUrl(w.url)));
});

// ─── URL normaliser ─ auto-prepend https:// if no protocol present ───────────
function normalizeUrl(raw) {
    const s = (raw || '').trim();
    if (!s) return s;
    // Already has a scheme
    if (/^https?:\/\//i.test(s)) return s;
    // Has a different scheme (ftp:// etc) — leave as-is
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) return s;
    // No scheme — default to https://
    return 'https://' + s;
}

function getEffectiveOS(proxy) {
    // Use the OS explicitly stored with the proxy, defaulting to 'windows' if missing.
    // We removed automatic detection based on keywords like 'mobile' to give the user absolute control.
    return (proxy.os || 'windows').toLowerCase();
}

app.post('/api/websites/add', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const normalized = normalizeUrl(url);

    if (IS_LOCAL_MODE) {
        const pool = loadJsonFile(DEFAULT_PATHS.websites);
        // Supports both array of strings and array of objects
        const exists = pool.some(w => (typeof w === 'string' ? w : w.url) === normalized);
        if (!exists) {
            pool.push(normalized);
            saveJsonFile(DEFAULT_PATHS.websites, pool);
        }
        return res.json({ added: true, url: normalized });
    }

    const { error } = await req.supabase
        .from('ads_website')
        .upsert({ user_id: req.user.id, url: normalized }, { onConflict: 'user_id,url' });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ added: true, url: normalized });
});

app.delete('/api/websites/:index', async (req, res) => {
    // index-based delete (for backward compat with the frontend)
    const idx = parseInt(req.params.index, 10);

    if (IS_LOCAL_MODE) {
        const pool = loadJsonFile(DEFAULT_PATHS.websites);
        if (idx >= 0 && idx < pool.length) {
            pool.splice(idx, 1);
            saveJsonFile(DEFAULT_PATHS.websites, pool);
            return res.json({ deleted: true });
        }
        return res.status(404).json({ error: 'not found' });
    }

    const { data } = await req.supabase.from('ads_website').select('id').order('created_at');
    const entry = (data || [])[idx];
    if (!entry) return res.status(404).json({ error: 'not found' });

    await req.supabase.from('ads_website').delete().eq('id', entry.id);
    res.json({ deleted: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────
// (DEFAULT_SETTINGS moved up)

app.get('/api/settings', async (req, res) => {
    if (IS_LOCAL_MODE) {
        const settings = loadJsonFile(DEFAULT_PATHS.settings);
        return res.json(deepMerge(DEFAULT_SETTINGS, settings));
    }
    const { data } = await req.supabase
        .from('ads_settings')
        .select('data')
        .eq('user_id', req.user.id)
        .single();

    res.json(deepMerge(DEFAULT_SETTINGS, data?.data || {}));
});

app.post('/api/settings', async (req, res) => {
    if (IS_LOCAL_MODE) {
        saveJsonFile(DEFAULT_PATHS.settings, req.body);
        return res.json({ saved: true });
    }
    const { error } = await req.supabase
        .from('ads_settings')
        .upsert({ user_id: req.user.id, data: req.body, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ saved: true });
});

// ─── User profile ──────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
    res.json({ id: req.user.id, email: req.user.email });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║  AdsPower Dashboard → http://localhost:${PORT}        ║`);
    console.log('║  Multi-user mode — powered by Supabase           ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
});
