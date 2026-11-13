const express = require('express');
const mongoose = require('mongoose');
const Adjustment = require('../models/Adjustment');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(protect, adminOnly);

const { isPeriodKey, isRealDate } = require('../utils/period');
const MONTH_RE = { test: (k) => isPeriodKey(String(k || '')) };

// GET /api/adjustments?from=YYYY-MM-DD&to=YYYY-MM-DD[&user=id]   (or ?month=<pay period key> for older entries)
router.get('/', async (req, res) => {
  try {
    const { month, user, from, to } = req.query;
    let filter;
    if (from || to) {
      if (!isRealDate(String(from || '')) || !isRealDate(String(to || ''))) return res.status(400).json({ message: 'from and to must be dates (YYYY-MM-DD)' });
      filter = { date: { $gte: from, $lte: to } };
    } else {
      if (!MONTH_RE.test(month || '')) return res.status(400).json({ message: 'Give from and to dates, or a month' });
      filter = { month };
    }
    if (user) {
      if (!mongoose.isValidObjectId(user)) return res.status(400).json({ message: 'Invalid staff id' });
      filter.user = user;
    }
    res.json(await Adjustment.find(filter).sort({ date: 1, createdAt: 1 }));
  } catch {
    res.status(500).json({ message: 'Could not load adjustments' });
  }
});

// POST /api/adjustments  { user, date, type, label, amount, note }
//   date  = the day it is for; label = what it is (Overtime, Advance ...); note = narration (required)
router.post('/', async (req, res) => {
  try {
    const { user, date, type, label, note } = req.body || {};
    const amount = Number(req.body?.amount);
    if (!mongoose.isValidObjectId(user)) return res.status(400).json({ message: 'Choose a staff member' });
    if (!isRealDate(String(date || ''))) return res.status(400).json({ message: 'Choose the date (YYYY-MM-DD)' });
    if (!['earning', 'deduction'].includes(type)) return res.status(400).json({ message: 'Type must be earning or deduction' });
    if (!String(label || '').trim()) return res.status(400).json({ message: 'Enter a name, e.g. Overtime or Advance' });
    if (!String(note || '').trim()) return res.status(400).json({ message: 'Write a short narration, e.g. why this amount' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Amount must be more than 0' });

    const person = await User.findById(user);
    if (!person) return res.status(404).json({ message: 'Staff member not found' });

    const doc = await Adjustment.create({
      user, date, month: date.slice(0, 7), type, label: String(label).trim().slice(0, 60),
      amount: Math.round(amount * 100) / 100, note: String(note).trim().slice(0, 300), createdBy: req.user._id,
    });
    res.status(201).json(doc);
  } catch {
    res.status(500).json({ message: 'Could not save the adjustment' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Adjustment.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Removed' });
  } catch {
    res.status(500).json({ message: 'Could not remove the adjustment' });
  }
});

module.exports = router;
