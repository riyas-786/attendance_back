const mongoose = require('mongoose');

// A duty time (e.g. Morning 08:00, Evening 14:00). Decides when a check-in counts as late.
const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    workStart: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    graceMinutes: { type: Number, default: 0, min: 0, max: 240 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Shift', shiftSchema);
