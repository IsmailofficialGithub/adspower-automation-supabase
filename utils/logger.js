'use strict';

/**
 * Minimal logger with ISO timestamps and log levels.
 * Outputs to stdout/stderr. Extend to write to file if needed.
 */

function timestamp() {
  return new Date().toISOString();
}

module.exports = {
  info:  (...args) => console.log( `[${timestamp()}] [INFO] `, ...args),
  warn:  (...args) => console.warn(`[${timestamp()}] [WARN] `, ...args),
  error: (...args) => console.error(`[${timestamp()}] [ERROR]`, ...args),
  debug: (...args) => console.log( `[${timestamp()}] [DEBUG]`, ...args),
};
