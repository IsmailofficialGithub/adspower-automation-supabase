'use strict';

/**
 * Returns a cryptographically-safe random integer between min and max (inclusive).
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Returns a random float between min and max.
 */
function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Resolves after `ms` milliseconds.
 * Use with await for non-blocking delays.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { randomInt, randomFloat, sleep };
