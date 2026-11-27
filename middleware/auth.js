const jwt = require('jsonwebtoken');
const User = require('../models/User');

// What an admin can tick for an Accountant (Staff page -> Edit -> Accountant permissions)
const PERMISSIONS = ['attendance_view', 'attendance_edit', 'reports', 'payroll_view', 'payroll_edit', 'salary_summary', 'leaves'];

// The only requests an accountant account can make at all. Each of these routes then checks the exact permission (allow()).
const ACCOUNTANT_CALLS = [
  ['GET', /^\/api\/auth\/me$/],
  ['GET', /^\/api\/attendance\/?$/],
  ['GET', /^\/api\/attendance\/(summary|report|hours|hours\.xlsx|export\.csv|export\.xlsx|pay-period)$/],
  ['PUT', /^\/api\/attendance\/manual$/],
  ['POST', /^\/api\/attendance\/(manual\/clear|ot)$/],
  ['*', /^\/api\/payroll(\/|$)/],
  ['*', /^\/api\/adjustments(\/|$)/],
  ['GET', /^\/api\/(staff|settings|locations|shifts)\/?$/],
  ['GET', /^\/api\/leaves\/?$/],
  ['PUT', /^\/api\/leaves\/[^/]+\/review$/],
];

exports.protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Not authenticated' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.id).select('+deviceId');
    if (!user || !user.active) return res.status(401).json({ message: 'Account not available' });

    // Owners are view-only: they may read their own profile and the attendance-status overview, nothing else
    if (user.role === 'owner') {
      const p = req.baseUrl + req.path;
      const allowed = req.method === 'GET' && (p === '/api/auth/me' || p === '/api/attendance/owner');
      if (!allowed) return res.status(403).json({ message: 'Owner accounts can only view attendance status' });
    }

    // Accountants: only the admin-area calls above (and never check-in, their own history or leave requests)
    if (user.role === 'accountant') {
      const p = req.baseUrl + req.path;
      const ok = ACCOUNTANT_CALLS.some(([m, re]) => (m === '*' || m === req.method) && re.test(p));
      if (!ok) return res.status(403).json({ message: 'This account cannot use that' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

exports.PERMISSIONS = PERMISSIONS;

// Admin always passes. An accountant passes when the admin ticked at least one of these permissions for them.
exports.allow = (...perms) => (req, res, next) => {
  const u = req.user;
  if (u?.role === 'admin') return next();
  if (u?.role === 'accountant' && perms.some((p) => (u.permissions || []).includes(p))) return next();
  return res.status(403).json({ message: 'You do not have permission for this. Ask the admin to allow it.' });
};

// For read-only reference lists (staff names, settings, places, shifts): admin, or an accountant who has any permission
exports.anyPermission = (req, res, next) => {
  const u = req.user;
  if (u?.role === 'admin' || (u?.role === 'accountant' && (u.permissions || []).length > 0)) return next();
  return res.status(403).json({ message: 'You do not have permission for this' });
};

exports.adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  next();
};
