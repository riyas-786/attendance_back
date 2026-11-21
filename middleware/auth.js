const jwt = require('jsonwebtoken');
const User = require('../models/User');

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

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

exports.adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  next();
};
