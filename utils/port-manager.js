'use strict';

const { execSync, exec } = require('child_process');

/**
 * Finds and kills any process running on the specified port.
 * Works on Windows.
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
async function killPort(port) {
    if (process.platform !== 'win32') return true;

    return new Promise((resolve) => {
        // Find PID using netstat
        exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
            if (err || !stdout) {
                return resolve(false); // Nothing running on this port
            }

            const lines = stdout.split('\n');
            const pids = new Set();

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length > 4 && parts[1].endsWith(`:${port}`)) {
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== '0') pids.add(pid);
                }
            }

            if (pids.size === 0) return resolve(false);

            // Kill each PID
            let killedCount = 0;
            pids.forEach(pid => {
                try {
                    execSync(`taskkill /F /PID ${pid}`);
                    killedCount++;
                    console.log(`[kill-port] Killed process ${pid} on port ${port}`);
                } catch (e) {
                    console.error(`[kill-port] Failed to kill process ${pid}: ${e.message}`);
                }
            });

            resolve(killedCount > 0);
        });
    });
}

module.exports = { killPort };
