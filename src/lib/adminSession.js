'use strict';
const crypto = require('crypto');
const config = require('../config');

const COOKIE = 'art_bridge_admin';
const secret = config.adminSessionSecret || crypto.createHash('sha256').update(`stremio-art-bridge:${config.adminUser}:${config.adminPassword}`).digest('hex');
function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function createSession() {
  const payload = `${Date.now()}:${config.adminSessionHours * 3600 * 1000}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}
function validSession(value) {
  try {
    if (!value) return false;
    const [raw, sig] = value.split('.');
    const payload = Buffer.from(raw, 'base64url').toString('utf8');
    const expected = sign(payload);
    if (!crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected))) return false;
    const [issued, ttl] = payload.split(':').map(Number);
    return Number.isFinite(issued) && Number.isFinite(ttl) && Date.now() < issued + ttl;
  } catch { return false; }
}
function parseCookies(header='') {
  const out={}; for (const part of header.split(';')) { const i=part.indexOf('='); if(i>0) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim()); }
  return out;
}
function setSession(res) {
  const parts = [`${COOKIE}=${encodeURIComponent(createSession())}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${config.adminSessionHours*3600}`];
  if (config.adminCookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
function hasSession(req) { return validSession(parseCookies(req.headers.cookie||'')[COOKIE]); }
module.exports = { COOKIE, hasSession, setSession, clearSession };
