'use strict';

/**
 * AdsPower Dashboard — Express API + static server
 * Multi-user edition powered by Supabase Auth + Database
 * Run: node server.js  →  http://localhost:3000
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase clients ─────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    console.error('\n❌  Missing Supabase environment variables.');
    console.error('    Please copy .env and fill in your SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY\n');
    process.exit(1);
}

// Service-role client for server-side DB operations (bypasses RLS on service operations but we use user client for RLS)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    db: { schema: 'public' },
    auth: { autoRefreshToken: false, persistSession: false }
});

// Anon client for verifying user JWTs
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'public' },
    auth: { autoRefreshToken: false, persistSession: false }
});

// ─── Auth middleware ───────────────────────────────────────────────────────────
/**
 * requireAuth — validates the Bearer token from Authorization header
 * Attaches req.user (Supabase user object) and req.supabase (user-scoped client)
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : (req.query.token || null); // Allow token via query param (for SSE EventSource)

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized — missing token' });
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized — invalid token' });
    }

    req.user = user;
    // Create a user-scoped Supabase client (RLS enforced automatically)
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
const KNOWN_OS = new Set(['windows', 'mac', 'android', 'linux']);

function parseProxyUrl(str) {
    const m = str.trim().match(/^(socks5|socks4|https?):\/\/(.+)$/i);
    if (!m) return null;
    const parts = m[2].split(':');
    if (parts.length < 4) return null;
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const user = parts[2];
    const last = parts[parts.length - 1].toLowerCase();
    let os, pass;
    if (KNOWN_OS.has(last)) {
        os = last;
        pass = parts.slice(3, -1).join(':');
    } else {
        os = 'windows';
        pass = parts.slice(3).join(':');
    }
    if (!host || isNaN(port) || !user || !pass) return null;
    return { host, port, user, pass, protocol: m[1].toLowerCase(), os };
}

function normalizeProxy(entry) {
    if (typeof entry === 'string') return parseProxyUrl(entry);
    if (entry && typeof entry === 'object') return entry;
    return null;
}

function proxyKey(p) {
    return `${p.host}:${p.port}:${p.pass || ''}`;
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

// ─── Automation run / stop ────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ running: userAutomations.has(req.user.id) });
});

app.post('/api/run', (req, res) => {
    const userId = req.user.id;
    if (userAutomations.has(userId)) return res.status(400).json({ error: 'Already running' });

    userLogBuffers.set(userId, []);
    broadcastToUser(userId, '=== Starting AdsPower Automation ===');

    const proc = spawn('node', ['index.js'], {
        cwd: __dirname,
        env: { ...process.env, AUTOMATION_USER_ID: userId }
    });
    userAutomations.set(userId, proc);

    const pipe = d => d.toString().split('\n').filter(Boolean).forEach(line => broadcastToUser(userId, line));
    proc.stdout.on('data', pipe);
    proc.stderr.on('data', pipe);
    proc.on('close', code => {
        broadcastToUser(userId, `=== Process exited (code ${code ?? 0}) ===`);
        userAutomations.delete(userId);
    });

    res.json({ started: true });
});

app.post('/api/stop', (req, res) => {
    const userId = req.user.id;
    const proc = userAutomations.get(userId);
    if (proc) {
        broadcastToUser(userId, '=== Stop requested — finishing current sessions gracefully… ===');
        proc.kill('SIGINT');
    }
    res.json({ stopped: true });
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
    const db = req.supabase;
    const userId = req.user.id;

    const [
        { count: totalProxies },
        { count: usedCount },
        { count: websites }
    ] = await Promise.all([
        db.from('ads_proxies').select('*', { count: 'exact', head: true }),
        db.from('ads_used_proxies').select('*', { count: 'exact', head: true }),
        db.from('ads_website').select('*', { count: 'exact', head: true }),
    ]);

    // Fresh proxies = proxies not in used_proxies
    const { data: proxies } = await db.from('ads_proxies').select('host,port,pass');
    const { data: used } = await db.from('ads_used_proxies').select('host,port,pass');
    const usedKeys = new Set((used || []).map(p => proxyKey(p)));
    const freshProxies = (proxies || []).filter(p => !usedKeys.has(proxyKey(p))).length;

    res.json({
        totalProxies: totalProxies || 0,
        usedProxies: usedCount || 0,
        freshProxies,
        websites: websites || 0,
        running: userAutomations.has(userId)
    });
});

// ─── Proxies ──────────────────────────────────────────────────────────────────
app.get('/api/proxies', async (req, res) => {
    const db = req.supabase;
    const { data: proxies, error } = await db.from('ads_proxies').select('*').order('created_at');
    if (error) return res.status(500).json({ error: error.message });

    const { data: used } = await db.from('ads_used_proxies').select('host,port,pass');
    const usedKeys = new Set((used || []).map(p => proxyKey(p)));

    res.json((proxies || []).map(p => ({ ...p, used: usedKeys.has(proxyKey(p)), key: proxyKey(p) })));
});

app.post('/api/proxies/add', async (req, res) => {
    const { entries } = req.body;
    const db = req.supabase;
    const userId = req.user.id;

    if (!Array.isArray(entries) || entries.length === 0)
        return res.status(400).json({ error: 'entries array required' });

    // Get existing proxy keys to avoid duplicates
    const { data: existing } = await db.from('ads_proxies').select('host,port,pass');
    const existingKeys = new Set((existing || []).map(p => proxyKey(p)));

    const toInsert = [];
    for (const e of entries) {
        const p = normalizeProxy(e);
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
    const db = req.supabase;

    if (Array.isArray(keys) && keys.length) {
        // Delete specific proxies by composite key
        const { data: all } = await db.from('ads_proxies').select('id,host,port,pass');
        const ids = (all || [])
            .filter(p => keys.includes(proxyKey(p)))
            .map(p => p.id);
        if (ids.length) await db.from('ads_proxies').delete().in('id', ids);
    } else {
        // Delete all proxies for this user
        await db.from('ads_proxies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    }

    res.json({ deleted: true });
});

// ─── Used proxies ─────────────────────────────────────────────────────────────
app.get('/api/used-proxies', async (req, res) => {
    const { data, error } = await req.supabase.from('ads_used_proxies').select('*').order('used_at');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

app.delete('/api/used-proxies', async (req, res) => {
    await req.supabase.from('ads_used_proxies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    res.json({ cleared: true });
});

// ─── Websites ─────────────────────────────────────────────────────────────────
app.get('/api/websites', async (req, res) => {
    const { data, error } = await req.supabase.from('ads_website').select('id,url').order('created_at');
    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(w => w.url));
});

app.post('/api/websites/add', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const { error } = await req.supabase
        .from('ads_website')
        .upsert({ user_id: req.user.id, url: url.trim() }, { onConflict: 'user_id,url' });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ added: true });
});

app.delete('/api/websites/:index', async (req, res) => {
    // index-based delete (for backward compat with the frontend)
    const idx = parseInt(req.params.index, 10);
    const { data } = await req.supabase.from('ads_website').select('id').order('created_at');
    const entry = (data || [])[idx];
    if (!entry) return res.status(404).json({ error: 'not found' });

    await req.supabase.from('ads_website').delete().eq('id', entry.id);
    res.json({ deleted: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    adsPower: { baseUrl: 'http://127.0.0.1:50325', apiKey: '' },
    proxySampling: { windows: { min: 5, max: 15 }, mac: { min: 2, max: 8 }, android: { min: 3, max: 12 } },
    concurrency: { min: 3, max: 5 },
    minBrowserStartGapMs: 4000,
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

app.get('/api/settings', async (req, res) => {
    const { data } = await req.supabase
        .from('ads_settings')
        .select('data')
        .eq('user_id', req.user.id)
        .single();

    res.json(deepMerge(DEFAULT_SETTINGS, data?.data || {}));
});

app.post('/api/settings', async (req, res) => {
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
