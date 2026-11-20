const express = require('express');
const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(protect, adminOnly);

function clean(body) {
  const name = String(body.name || '').trim();
  const workStart = String(body.workStart || '');
  const workEnd = String(body.workEnd || '');
  const graceMinutes = body.graceMinutes === undefined || body.graceMinutes === '' ? 0 : Number(body.graceMinutes);
  if (!name || name.length > 60) return { error: 'Name is required (up to 60 characters)' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(workStart)) return { error: 'Start time must be HH:MM (24-hour)' };
  if (workEnd && !/^([01]\d|2[0-3]):[0-5]\d$/.test(workEnd)) return { error: 'End time must be HH:MM (24-hour)' };
  if (workEnd && workEnd === workStart) return { error: 'End time must be different from the start time' };
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 240)
    return { error: 'Grace period must be a whole number from 0 to 240 minutes' };
  return { value: { name, workStart, workEnd, graceMinutes } };
}

router.get('/', async (req, res) => {
  const [shifts, counts] = await Promise.all([
    Shift.find().sort({ workStart: 1, name: 1 }).lean(),
    User.aggregate([{ $match: { shift: { $ne: null } } }, { $group: { _id: '$shift', n: { $sum: 1 } } }]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(shifts.map((s) => ({ ...s, staffCount: byId.get(String(s._id)) || 0 })));
});

router.post('/', async (req, res) => {
  try {
    const { value, error } = clean(req.body);
    if (error) return res.status(400).json({ message: error });
    res.status(201).json(await Shift.create(value));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'A shift with this name already exists' });
    res.status(400).json({ message: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Shift not found' });
    const { value, error } = clean(req.body);
    if (error) return res.status(400).json({ message: error });
    const shift = await Shift.findByIdAndUpdate(req.params.id, value, { new: true, runValidators: true });
    if (!shift) return res.status(404).json({ message: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'A shift with this name already exists' });
    res.status(400).json({ message: err.message });
  }
});

// Deleting puts those staff back on the default duty time from Settings
router.delete('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Shift not found' });
  const shift = await Shift.findByIdAndDelete(req.params.id);
  if (!shift) return res.status(404).json({ message: 'Shift not found' });
  await User.updateMany({ shift: shift._id }, { $set: { shift: null } });
  res.json({ message: 'Shift deleted' });
});

module.exports = router;
