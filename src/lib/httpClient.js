'use strict';
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../logger');

const liveLimit = pLimit(config.maxConcurrentFetches);
const backgroundLimit = pLimit(config.backgroundProviderConcurrency);
const UA = 'stremio-art-bridge/1.1 (+self-hosted)';

async function limitedFetch(url, { timeoutMs = 8000, headers = {}, allow404 = false, method = 'GET', body, priority = 'live' } = {}) {
  const gate = priority === 'background' ? backgroundLimit : liveLimit;
  return gate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: controller.signal });
      if (res.status === 404 && allow404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
      }
      return res;
    } finally { clearTimeout(timer); }
  });
}

async function fetchJson(url, opts) { const res = await limitedFetch(url, opts); return res ? res.json() : null; }
async function fetchText(url, opts) { const res = await limitedFetch(url, opts); return res ? res.text() : null; }
async function fetchBuffer(url, opts) {
  const res = await limitedFetch(url, opts);
  if (!res) return null;
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 0 && len > (config.maxImageBytes || 25 * 1024 * 1024)) throw new Error(`Image too large (${len} bytes)`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > (config.maxImageBytes || 25 * 1024 * 1024)) throw new Error(`Image too large (${ab.byteLength} bytes)`);
  return { buffer: Buffer.from(ab), contentType };
}

module.exports = { limitedFetch, fetchJson, fetchText, fetchBuffer };
