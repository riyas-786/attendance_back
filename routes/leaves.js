const express = require('express');
const Leave = require('../models/Leave');
const Attendance = require('../models/Attendance');
const { protect, allow } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;

// Inclusive list of YYYY-MM-DD between two dates (UTC math avoids time-zone shifts)
function datesBetween(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let t = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (t <= end && out.length <= MAX_DAYS) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

// Staff: request leave
router.post('/', async (req, res) => {
  try {
    const { type, from, to, reason } = req.body;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ message: 'Valid from and to dates are required' });
    }
    if (to < from) return res.status(400).json({ message: 'End date cannot be before start date' });
    if (datesBetween(from, to).length > MAX_DAYS) {
      return res.status(400).json({ message: `Leave cannot be longer than ${MAX_DAYS} days` });
    }

    const overlap = await Leave.findOne({
      user: req.user._id,
      status: { $in: ['pending', 'approved'] },
      from: { $lte: to },
      to: { $gte: from },
    });
    if (overlap) return res.status(409).json({ message: 'You already have a leave request for these dates' });

    const leave = await Leave.create({ user: req.user._id, type, from, to, reason });
    res.status(201).json(leave);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Staff: my requests
router.get('/my', async (req, res) => {
  const leaves = await Leave.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(200);
  res.json(leaves);
});

// Staff: cancel my own pending request
router.put('/:id/cancel', async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, user: req.user._id });
  if (!leave) return res.status(404).json({ message: 'Request not found' });
  if (leave.status !== 'pending') return res.status(400).json({ message: 'Only pending requests can be cancelled' });
  leave.status = 'cancelled';
  await leave.save();
  res.json(leave);
});

// Admin: list requests (?status=pending)
router.get('/', allow('leaves'), async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : {};
  const leaves = await Leave.find(filter)
    .populate('user', 'name email department employeeId')
    .populate('reviewedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(500);
  res.json(leaves);
});

// Admin: approve or reject  (body: { decision: 'approved' | 'rejected', note? })
router.put('/:id/review', allow('leaves'), async (req, res) => {
  try {
    const { decision, note } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ message: 'decision must be approved or rejected' });
    }
    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: 'Request not found' });
    if (leave.status !== 'pending') return res.status(400).json({ message: `Request is already ${leave.status}` });

    leave.status = decision;
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    leave.reviewNote = note || '';
    await leave.save();

    // Approved leave shows up in attendance as "leave" (days with a real check-in are left alone)
    if (decision === 'approved') {
      for (const date of datesBetween(leave.from, leave.to)) {
        const existing = await Attendance.findOne({ user: leave.user, date });
        if (existing?.checkIn && !existing.auto) continue; // a real check-in stays; a day the system filled in for an auto-attendance person becomes leave
        const rec = existing || new Attendance({ user: leave.user, date });
        if (rec.auto) { rec.sessions = []; rec.checkIn = undefined; rec.checkOut = undefined; rec.workedMinutes = 0; rec.auto = false; }
        rec.status = 'leave';
        rec.leaveType = leave.type;
        rec.note = `Approved ${leave.type} leave`;
        await rec.save();
      }
    }
    res.json(leave);
  } catch (err) {
    res.status(500).json({ message: 'Could not save decision' });
  }
});

module.exports = router;
