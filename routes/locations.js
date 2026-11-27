const express = require('express');
const mongoose = require('mongoose');
const Location = require('../models/Location');
const User = require('../models/User');
const { protect, adminOnly, anyPermission } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

function clean(body) {
  const name = String(body.name || '').trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const radiusMeters = body.radiusMeters === undefined || body.radiusMeters === '' ? 200 : Number(body.radiusMeters);
  if (!name || name.length > 60) return { error: 'Name is required (up to 60 characters)' };
  if (body.lat === '' || body.lat === null || body.lat === undefined || !Number.isFinite(lat) || lat < -90 || lat > 90)
    return { error: 'Latitude must be a number between -90 and 90' };
  if (body.lng === '' || body.lng === null || body.lng === undefined || !Number.isFinite(lng) || lng < -180 || lng > 180)
    return { error: 'Longitude must be a number between -180 and 180' };
  if (!Number.isFinite(radiusMeters) || radiusMeters < 10 || radiusMeters > 100000)
    return { error: 'Allowed distance must be between 10 and 100000 metres' };
  return { value: { name, lat, lng, radiusMeters } };
}

// Locations with how many staff use each
router.get('/', anyPermission, async (req, res) => {
  const [locations, counts] = await Promise.all([
    Location.find().sort({ name: 1 }).lean(),
    User.aggregate([{ $unwind: '$locations' }, { $group: { _id: '$locations', n: { $sum: 1 } } }]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(locations.map((l) => ({ ...l, staffCount: byId.get(String(l._id)) || 0 })));
});

router.post('/', adminOnly, async (req, res) => {
  try {
    const { value, error } = clean(req.body);
    if (error) return res.status(400).json({ message: error });
    res.status(201).json(await Location.create(value));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'A location with this name already exists' });
    res.status(400).json({ message: err.message });
  }
});

router.put('/:id', adminOnly, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Location not found' });
    const { value, error } = clean(req.body);
    if (error) return res.status(400).json({ message: error });
    const loc = await Location.findByIdAndUpdate(req.params.id, value, { new: true, runValidators: true });
    if (!loc) return res.status(404).json({ message: 'Location not found' });
    res.json(loc);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'A location with this name already exists' });
    res.status(400).json({ message: err.message });
  }
});

// Deleting removes it from every staff member who had it
router.delete('/:id', adminOnly, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Location not found' });
  const loc = await Location.findByIdAndDelete(req.params.id);
  if (!loc) return res.status(404).json({ message: 'Location not found' });
  await User.updateMany({ locations: loc._id }, { $pull: { locations: loc._id } });
  res.json({ message: 'Location deleted' });
});

module.exports = router;
