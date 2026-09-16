'use strict';
require('dotenv').config();
const path = require('path');

function bool(val, def) {
  if (val === undefined || val === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(val).toLowerCase());
}

function int(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  // --- Server ---
  port: int(process.env.PORT, 8990),
  baseUrl: process.env.BASE_URL || '',
  dataDir: DATA_DIR,
  cacheDir: process.env.CACHE_DIR || path.join(DATA_DIR, 'cache'),
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'db', 'artbridge.sqlite'),
  adminUser: process.env.ADMIN_USER || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET || '',
  adminSessionHours: int(process.env.ADMIN_SESSION_HOURS, 12),
  adminCookieSecure: bool(process.env.ADMIN_COOKIE_SECURE, true),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Provider API keys ---
  tmdbApiKey: process.env.TMDB_API_KEY || '',
  // TMDB v3 "API Key" (legacy) OR a v4 Read Access Token - we support either.
  tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || '',
  tvdbApiKey: process.env.TVDB_API_KEY || '',
  tvdbSubscriberPin: process.env.TVDB_SUBSCRIBER_PIN || '',

  // --- Image sizes ---
  tmdbPosterSize: process.env.TMDB_POSTER_SIZE || 'w780',
  tmdbBackdropSize: process.env.TMDB_BACKDROP_SIZE || 'original',
  tmdbLogoSize: process.env.TMDB_LOGO_SIZE || 'original',

  // --- Cache / TTL (days). ThePosterDB results are always cached forever regardless. ---
  cacheTtlDaysTmdb: int(process.env.CACHE_TTL_DAYS_TMDB, 30),
  cacheTtlDaysTvdb: int(process.env.CACHE_TTL_DAYS_TVDB, 30),
  cacheTtlDaysMetahub: int(process.env.CACHE_TTL_DAYS_METAHUB, 14),
  negativeCacheTtlHours: int(process.env.NEGATIVE_CACHE_TTL_HOURS, 24),
  // Fallback art is intentionally short-lived on first resolution so a background TPDb hit
  // can become visible quickly. Once TPDb has been checked and is in a negative cooldown,
  // the normal provider TTL is used, but the HTTP cache is still capped by next TPDb retry.
  fallbackClientCacheSeconds: int(process.env.FALLBACK_CLIENT_CACHE_SECONDS, 900),
  tpdbFirstAttemptDelaySeconds: int(process.env.TPDB_FIRST_ATTEMPT_DELAY_SECONDS, 0),
  tpdbRetryBaseSeconds: int(process.env.TPDB_RETRY_BASE_SECONDS, 1800),
  tpdbRetryMaxSeconds: int(process.env.TPDB_RETRY_MAX_SECONDS, 86400),
  tpdbMatcherVersion: int(process.env.TPDB_MATCHER_VERSION, 4),
  tpdbBackgroundPollSeconds: int(process.env.TPDB_BACKGROUND_POLL_SECONDS, 300),

  // --- Concurrency / resource usage ---
  // Global cap on simultaneous outbound provider fetches (across all requests).
  maxConcurrentFetches: int(process.env.MAX_CONCURRENT_FETCHES, 8),
  // Separate low-priority background-fetch budget so TPDB catch-up cannot starve live requests.
  backgroundProviderConcurrency: int(process.env.BACKGROUND_PROVIDER_CONCURRENCY, 2),
  // Concurrency for the low-priority background jobs themselves.
  backgroundJobConcurrency: int(process.env.BACKGROUND_JOB_CONCURRENCY, 2),

  // --- Per-provider timeouts (ms) ---
  tpdbTimeoutMs: int(process.env.TPDB_TIMEOUT_MS, 4000),
  tmdbTimeoutMs: int(process.env.TMDB_TIMEOUT_MS, 6000),
  tvdbTimeoutMs: int(process.env.TVDB_TIMEOUT_MS, 6000),
  metahubTimeoutMs: int(process.env.METAHUB_TIMEOUT_MS, 5000),

  // How many candidate ThePosterDB sets to actually open (each costs one request) before
  // giving up on a title. Keep this modest - it directly controls TPDB load & latency.
  tpdbMaxCandidates: int(process.env.TPDB_MAX_CANDIDATES, 6),
  tpdbMaxSetsToInspectInParallel: int(process.env.TPDB_MAX_SETS_IN_PARALLEL, 3),
  maxImageBytes: int(process.env.MAX_IMAGE_BYTES, 25000000),

  // --- Placeholder behaviour ---
  // If true, a request that resolves to "no art anywhere" gets a 302 to placeholderUrl
  // instead of a 404, so Stremio/AIOMetadata never shows a broken image icon.
  servePlaceholderOn404: bool(process.env.SERVE_PLACEHOLDER_ON_404, true),
  placeholderPosterUrl: process.env.PLACEHOLDER_POSTER_URL || '',
  placeholderBackdropUrl: process.env.PLACEHOLDER_BACKDROP_URL || '',
  placeholderLogoUrl: process.env.PLACEHOLDER_LOGO_URL || '',
  cpuLimit: process.env.CPU_LIMIT || '1.0',
  memoryLimit: process.env.MEMORY_LIMIT || '512m',
  pidsLimit: int(process.env.PIDS_LIMIT, 128),
};
