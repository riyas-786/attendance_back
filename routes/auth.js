const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { checkDevice } = require('../utils/device');
const { getSettings } = require('../utils/settings');

const router = express.Router();

const publicUser = (u) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  permissions: u.role === 'accountant' ? u.permissions || [] : [],
  department: u.department,
  employeeId: u.employeeId,
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password +deviceId');
    if (!user || !user.active || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Staff accounts only work on their own registered phone/browser
    const dev = await checkDevice(user, req.headers['x-device-id']);
    if (!dev.ok) return res.status(dev.status).json({ message: dev.message });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });
    res.json({ token, user: publicUser(user), timezone: (await getSettings()).timezone });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// The company time zone comes with the profile so every screen shows times in it
router.get('/me', protect, async (req, res) => {
  try {
    res.json({ ...publicUser(req.user), timezone: (await getSettings()).timezone });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
