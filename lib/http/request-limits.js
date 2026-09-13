'use strict';

// Production Gate A item 3 (#2366): ceilings on concurrent work, queue depth
// and request body size so load makes the service slow rather than dead.
//
// Body-size ceilings already exist via requestGuards: DEFAULT_MAX_JSON_BODY
// (4KB) and DEFAULT_MAX_UPLOAD_BODY (1MB) enforced in readJsonBody with
// both Content-Length fast-path and streaming overflow. This module adds
// the missing global concurrency ceiling.

const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;
const DEFAULT_MAX_CONCURRENT_QUEUE_DEPTH = 0; // 0 = fail-fast (no queue), 503 immediately
const DEFAULT_RETRY_AFTER_MS = 1000;

const LIMITS = Object.freeze({
  MAX_CONCURRENT_REQUESTS: Object.freeze({ min: 1, max: 10000 }),
  MAX_QUEUE_DEPTH: Object.freeze({ min: 0, max: 10000 }),
});

function invalidLimit(name, reason) {
  const error = new Error(`invalid request limit for ${name}: ${reason}`);
  error.code = 'HUQAN_REQUEST_LIMIT_INVALID';
  error.field = name;
  return error;
}

function boundedInteger(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  const limit = LIMITS[name];
  if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) {
    throw invalidLimit(name, `expected integer between ${limit.min} and ${limit.max}`);
  }
  return value;
}

function resolveRequestLimits(readEnvironment) {
  if (typeof readEnvironment !== 'function') throw new TypeError('readEnvironment must be a function');
  const maxConcurrent = boundedInteger('MAX_CONCURRENT_REQUESTS', readEnvironment('HUQAN_MAX_CONCURRENT_REQUESTS'), DEFAULT_MAX_CONCURRENT_REQUESTS);
  const maxQueueDepth = boundedInteger('MAX_QUEUE_DEPTH', readEnvironment('HUQAN_MAX_QUEUE_DEPTH'), DEFAULT_MAX_CONCURRENT_QUEUE_DEPTH);
  return Object.freeze({ maxConcurrent, maxQueueDepth, retryAfterMs: DEFAULT_RETRY_AFTER_MS });
}

function createConcurrencyLimiter({ maxConcurrent = DEFAULT_MAX_CONCURRENT_REQUESTS } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be positive integer');
  let active = 0;
  let rejected = 0;
  return Object.freeze({
    get active() { return active; },
    get rejected() { return rejected; },
    get maxConcurrent() { return maxConcurrent; },
    tryAcquire() {
      if (active >= maxConcurrent) {
        rejected += 1;
        return false;
      }
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
    stats() {
      return Object.freeze({ active, rejected, maxConcurrent });
    },
    reset() {
      active = 0;
      rejected = 0;
    },
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONCURRENT_QUEUE_DEPTH,
  DEFAULT_RETRY_AFTER_MS,
  resolveRequestLimits,
  createConcurrencyLimiter,
});
