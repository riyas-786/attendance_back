const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Shift = require('../models/Shift');
const Location = require('../models/Location');
const { protect, adminOnly, anyPermission, PERMISSIONS } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Normalises the optional salary fields; returns { error } for bad input
function salaryFields(body) {
  const out = {};
  if (body.monthlyMethod !== undefined) {
    if (!['', 'fixed', 'days'].includes(body.monthlyMethod)) return { error: 'Monthly pay method must be fixed or days' };
    out.monthlyMethod = body.monthlyMethod;
  }
  if (body.payType !== undefined) {
    if (!['monthly', 'daily', 'hourly'].includes(body.payType)) return { error: 'Pay type must be monthly, daily or hourly' };
    out.payType = body.payType;
  }
  if (body.baseSalary !== undefined && body.baseSalary !== '') {
    const n = Number(body.baseSalary);
    if (!Number.isFinite(n) || n < 0) return { error: 'Salary or rate must be a number of 0 or more' };
    out.baseSalary = n;
  }
  if (body.company !== undefined) {
    const c = String(body.company || '').trim();
    if (c.length > 60) return { error: 'Company name can be at most 60 characters' };
    out.company = c;
  }
  if (body.salaryMode !== undefined) {
    if (!['bank', 'cash'].includes(body.salaryMode)) return { error: 'Salary must be paid by bank or cash' };
    out.salaryMode = body.salaryMode;
  }
  if (body.joinDate !== undefined) {
    if (body.joinDate && !DATE_RE.test(body.joinDate)) return { error: 'Join date must be YYYY-MM-DD' };
    out.joinDate = body.joinDate || '';
  }
  return { out };
}

// Validates the optional duty-time / location assignment fields.
async function assignmentFields(body) {
  const out = {};
  if (body.shift !== undefined) {
    if (body.shift === null || body.shift === '') out.shift = null;
    else {
      if (!mongoose.isValidObjectId(body.shift) || !(await Shift.exists({ _id: body.shift }))) return { error: 'Selected shift does not exist' };
      out.shift = body.shift;
    }
  }
  if (body.locations !== undefined) {
    if (!Array.isArray(body.locations) || body.locations.some((id) => !mongoose.isValidObjectId(id))) return { error: 'Invalid locations' };
    const ids = [...new Set(body.locations.map(String))];
    if (ids.length && (await Location.countDocuments({ _id: { $in: ids } })) !== ids.length) return { error: 'One of the selected locations does not exist' };
    out.locations = ids;
  }
  if (body.anyLocation !== undefined) {
    if (typeof body.anyLocation !== 'boolean') return { error: 'anyLocation must be true or false' };
    out.anyLocation = body.anyLocation;
  }
  return { out };
}

// Pay details are hidden from an accountant who was not allowed to see payroll
const PAY_FIELDS = ['baseSalary', 'payType', 'monthlyMethod'];

// WhatsApp number: digits with the country code (a leading + and spaces are ignored), or empty
function phoneField(body) {
  if (body.phone === undefined) return { out: {} };
  const digits = String(body.phone || '').replace(/[\s()+-]/g, '');
  if (digits === '') return { out: { phone: '' } };
  if (!/^\d{7,15}$/.test(digits)) return { error: 'Phone must be the WhatsApp number with the country code, for example 919876543210' };
  return { out: { phone: digits } };
}

// Accountant permissions: a list of keys from PERMISSIONS
function permissionsField(body) {
  if (body.permissions === undefined) return { out: {} };
  if (!Array.isArray(body.permissions) || body.permissions.some((p) => !PERMISSIONS.includes(p))) return { error: 'Unknown permission' };
  const set = new Set(body.permissions);
  // editing needs viewing
  if (set.has('attendance_edit')) set.add('attendance_view');
  if (set.has('payroll_edit')) set.add('payroll_view');
  return { out: { permissions: [...set] } };
}

router.get('/', anyPermission, async (req, res) => {
  const users = await User.find().select('+deviceId').sort({ name: 1 });
  const seesPay = req.user.role === 'admin' || (req.user.permissions || []).some((p) => ['payroll_view', 'payroll_edit', 'salary_summary'].includes(p));
  // never send the device id itself, only whether one is registered
  res.json(users.map((u) => {
    const o = u.toObject();
    o.hasDevice = !!o.deviceId;
    delete o.deviceId;
    if (!seesPay) PAY_FIELDS.forEach((f) => delete o[f]);
    return o;
  }));
});

router.post('/', adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, department, employeeId } = req.body;
    const sal = salaryFields(req.body);
    if (sal.error) return res.status(400).json({ message: sal.error });
    const asg = await assignmentFields(req.body);
    if (asg.error) return res.status(400).json({ message: asg.error });

    const perm = permissionsField(req.body);
    if (perm.error) return res.status(400).json({ message: perm.error });
    const ph = phoneField(req.body);
    if (ph.error) return res.status(400).json({ message: ph.error });
    const user = await User.create({ name, email, password, role, department, employeeId, ...sal.out, ...asg.out, ...perm.out, ...ph.out, ...(typeof req.body.autoAttendance === 'boolean' ? { autoAttendance: req.body.autoAttendance } : {}) });
    res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Email or employee ID already exists' });
    res.status(400).json({ message: err.message });
  }
});

router.put('/:id', adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'Staff member not found' });

    const sal = salaryFields(req.body);
    if (sal.error) return res.status(400).json({ message: sal.error });
    const asg = await assignmentFields(req.body);
    if (asg.error) return res.status(400).json({ message: asg.error });

    ['name', 'email', 'role', 'department', 'employeeId', 'active'].forEach((f) => {
      if (req.body[f] !== undefined) user[f] = req.body[f];
    });
    const perm = permissionsField(req.body);
    if (perm.error) return res.status(400).json({ message: perm.error });
    const ph = phoneField(req.body);
    if (ph.error) return res.status(400).json({ message: ph.error });
    Object.assign(user, sal.out, asg.out, perm.out, ph.out);
    if (typeof req.body.deviceLock === 'boolean') user.deviceLock = req.body.deviceLock;
    if (typeof req.body.autoAttendance === 'boolean') user.autoAttendance = req.body.autoAttendance;
    if (req.body.password) user.password = req.body.password;
    await user.save();
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, active: user.active });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Email or employee ID already exists' });
    res.status(400).json({ message: err.message });
  }
});

// Forget the registered phone/browser: the next sign-in registers a new one
router.post('/:id/reset-device', adminOnly, async (req, res) => {
  try {
    const r = await User.updateOne({ _id: req.params.id }, { $unset: { deviceId: 1 } });
    if (!r.matchedCount) return res.status(404).json({ message: 'Staff member not found' });
    res.json({ message: 'Device reset. The next sign-in will register a new phone or browser.' });
  } catch (err) {
    res.status(400).json({ message: 'Could not reset the device' });
  }
});

// Deactivate instead of deleting so attendance history is preserved
router.delete('/:id', adminOnly, async (req, res) => {
  if (String(req.user._id) === req.params.id) {
    return res.status(400).json({ message: 'You cannot deactivate your own account' });
  }
  const user = await User.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  if (!user) return res.status(404).json({ message: 'Staff member not found' });
  res.json({ message: 'Staff member deactivated' });
});

module.exports = router;
