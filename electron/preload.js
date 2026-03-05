'use strict';

/**
 * Electron Preload Script
 * Runs in the renderer process before the page loads.
 * Keeps contextIsolation ON for security.
 * The existing web UI talks to Express over HTTP — no IPC bridge needed.
 */

const { contextBridge } = require('electron');

// Expose the platform so the UI can optionally tweak behaviour
contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    isElectron: true,
});
