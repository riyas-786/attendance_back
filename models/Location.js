const mongoose = require('mongoose');

// A place where staff are allowed to check in/out (office, branch, warehouse, ...)
const locationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    radiusMeters: { type: Number, required: true, min: 10, max: 100000, default: 200 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Location', locationSchema);
