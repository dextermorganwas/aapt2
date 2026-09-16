'use strict';
const config = require('../config');
const { hasSession } = require('../lib/adminSession');

function enabled() { return !!(config.adminUser && config.adminPassword); }
module.exports = function adminAuth(req, res, next) {
  if (!enabled()) return res.status(503).send('Admin authentication is not configured');
  if (hasSession(req)) return next();
  if (req.accepts('html') && req.path.startsWith('/admin')) return res.redirect('/admin/login');
  return res.status(401).json({ error: 'Authentication required' });
};
module.exports.enabled = enabled;
