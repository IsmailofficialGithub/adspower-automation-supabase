'use strict';

/**
 * AdsPower Automation — Electron Main Process
 *
 * Flow:
 *  1. App starts → spawn server.js (Express on :3000)
 *  2. Wait for Express to be ready  (wait-on)
 *  3. Open BrowserWindow loading http://localhost:3000
 *  4. Tray icon: minimize hides window, tray menu lets user restore / quit
 *  5. On quit → kill Express child process cleanly
 */

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn, fork } = require('child_process');
const waitOn = require('wait-on');
const dotenv = require('dotenv');

// ─── Config ───────────────────────────────────────────────────────────────────
// In production, PROJECT_ROOT is where the asar is. We use the asar file path 
// for require, but child_process needs a REAL directory for cwd.
const APP_PATH = app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.join(__dirname, '..');
const SPAWN_CWD = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const USER_DATA = app.getPath('userData');

dotenv.config({ path: path.join(APP_PATH, '.env') });
const SERVER_PORT = process.env.PORT || 3000;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const PRELOAD = app.isPackaged
    ? path.join(APP_PATH, 'electron', 'preload.js')
    : path.join(__dirname, 'preload.js');
const TRAY_ICON = app.isPackaged
    ? path.join(APP_PATH, 'electron', 'assets', 'tray.png')
    : path.join(__dirname, 'assets', 'tray.png');
const APP_NAME = 'Money Money Money';

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let serverProc = null;
let isQuitting = false;

// ─── Prevent second instance ──────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        // If someone opens the app again, just restore the existing window
        if (mainWindow) {
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ─── Start Express server ─────────────────────────────────────────────────────
function startServer() {
    const serverPath = path.join(APP_PATH, 'server.js');

    const env = {
        ...process.env,
        DOTENV_CONFIG_PATH: path.join(APP_PATH, '.env'),
        ELECTRON_RUN_AS_NODE: '1',
        USER_DATA_PATH: USER_DATA, // Pass writable path to child
    };

    const options = {
        cwd: SPAWN_CWD, // MUST be a real directory
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execPath: process.execPath,
    };


    console.log(`[electron] Spawning server: ${serverPath}`);
    console.log(`[electron] Using executable: ${options.execPath}`);

    try {
        serverProc = fork(serverPath, [], options);

        if (serverProc.stdout) {
            serverProc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
        }
        if (serverProc.stderr) {
            serverProc.stderr.on('data', d => process.stderr.write(`[server:err] ${d}`));
        }

        serverProc.on('error', (err) => {
            console.error('[electron] Failed to start server process:', err);
            dialog.showErrorBox(APP_NAME + ' — Startup Error', `Failed to start the backend server:\n${err.message}`);
        });

        serverProc.on('close', (code) => {
            if (!isQuitting) {
                console.error(`[electron] Server exited unexpectedly (code ${code}).`);
                dialog.showErrorBox(
                    APP_NAME + ' — Server Crashed',
                    `The Express server exited with code ${code}.\n\nTry restarting the app.`
                );
            }
        });

        console.log(`[electron] Express server spawned (pid ${serverProc.pid})`);
    } catch (err) {
        console.error('[electron] Critical error spawning server:', err);
        dialog.showErrorBox(APP_NAME + ' — Startup Error', `Critical error spawning server:\n${err.message}`);
    }
}

// ─── Stop Express server ──────────────────────────────────────────────────────
function stopServer() {
    if (serverProc && !serverProc.killed) {
        console.log('[electron] Stopping server…');
        serverProc.kill('SIGTERM');
        serverProc = null;
    }
}

// ─── Create the main browser window ──────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: APP_NAME,
        backgroundColor: '#0f1117',   // Match the dark UI
        autoHideMenuBar: true,        // Hide the native menu bar
        webPreferences: {
            preload: PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // Load the web dashboard
    mainWindow.loadURL(SERVER_URL);

    // Open external links in the default browser, not a new Electron window
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(SERVER_URL)) shell.openExternal(url);
        return { action: 'deny' };
    });

    // Minimize → hide to tray instead of minimizing
    mainWindow.on('minimize', (e) => {
        e.preventDefault();
        mainWindow.hide();
        tray.displayBalloon({
            iconType: 'info',
            title: APP_NAME,
            content: 'Running in the background. Click the tray icon to restore.',
        });
    });

    // Close button → also hide to tray (unless quitting)
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Create system tray ───────────────────────────────────────────────────────
function createTray() {
    let icon;
    try {
        icon = nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16 });
    } catch (_) {
        // Fallback: create a tiny colored square if icon file missing
        icon = nativeImage.createEmpty();
    }

    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);

    const menu = Menu.buildFromTemplate([
        {
            label: '📊 Show Dashboard',
            click: () => {
                if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
            },
        },
        { type: 'separator' },
        {
            label: '🌐 Open in Browser',
            click: () => shell.openExternal(SERVER_URL),
        },
        { type: 'separator' },
        {
            label: '❌ Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(menu);

    // Single-click on tray icon → show/hide window
    tray.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ─── App events ───────────────────────────────────────────────────────────────
const { killPort } = require('../utils/port-manager');

app.whenReady().then(async () => {
    console.log(`[electron] App ready. Cleaning up port ${SERVER_PORT}…`);

    // 1. Ensure port is free
    await killPort(SERVER_PORT);

    console.log(`[electron] Starting server on port ${SERVER_PORT}…`);

    // 2. Start Express
    startServer();

    // 3. Wait for Express to be accepting connections (max 30s)
    try {
        await waitOn({
            resources: [`tcp:127.0.0.1:${SERVER_PORT}`],
            timeout: 30000,
            interval: 500,
        });
        console.log(`[electron] Express is ready at ${SERVER_URL}`);
    } catch (err) {
        dialog.showErrorBox(
            APP_NAME + ' — Startup Failed',
            `Could not connect to the Express server at ${SERVER_URL}.\n\nError: ${err.message}`
        );
        app.quit();
        return;
    }

    // 4. Create tray first (so it exists before window minimize events)
    createTray();

    // 5. Open the window
    createWindow();
});

// macOS: re-create window when dock icon is clicked and no windows open
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Quit cleanly — kill server first
app.on('before-quit', () => {
    isQuitting = true;
    stopServer();
});

// On non-macOS, quit when all windows are closed
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // Don't quit — tray keeps the app alive
        // Only quit via the tray menu "Quit" option
    }
});
