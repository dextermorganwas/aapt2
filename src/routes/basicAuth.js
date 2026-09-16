'use strict';
const config = require('../config');
const { hasSession } = require('../lib/adminSession');

function enabled() { return !!(config.adminUser && config.adminPassword); }
module.exports = function adminAuth(req, res, next) {
  if (!enabled()) return res.status(503).send('Admin authentication is not configured');
  if (hasSession(req)) return next();
  // When middleware is mounted at /admin, Express rewrites req.path to '/'.
  // Use originalUrl so browser navigation to /admin or /admin/* gets the login page
  // instead of a JSON 401. API requests remain JSON 401s.
  const isAdminPage = req.originalUrl === '/admin' || req.originalUrl.startsWith('/admin/');
  if (req.accepts('html') && isAdminPage) return res.redirect('/admin/login');
  return res.status(401).json({ error: 'Authentication required' });
};
module.exports.enabled = enabled;
