'use strict';
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../logger');
const limit = pLimit(config.backgroundJobConcurrency);
let pending = 0;
const timers = new Set();
function schedule(label, fn, delayMs = 0) {
  pending += 1;
  const run = () => limit(fn)
    .catch((e) => logger.warn(`Background job "${label}" failed:`, e.message))
    .finally(() => { pending -= 1; });
  if (delayMs > 0) {
    const timer = setTimeout(() => { timers.delete(timer); run(); }, delayMs);
    timer.unref?.(); timers.add(timer);
  } else run();
}
function pendingCount() { return pending; }
module.exports = { schedule, pendingCount };
