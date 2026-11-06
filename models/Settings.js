const mongoose = require('mongoose');

// One document (key: 'main') holding the settings the admin edits in the back office.
// Fields are optional: anything missing falls back to the .env default (see utils/settings.js).
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    workStart: String,
    lateGraceMinutes: Number,
    officeLat: Number,
    officeLng: Number,
    officeRadiusMeters: Number,
    requireQr: Boolean,
    qrWindowMinutes: Number,
    frontendUrl: String,
    weekendDays: [Number],
    holidays: [String],
    absentDeductionFactor: Number,
    lateCountThreshold: Number,
    lateDeductionDays: Number,
    salaryCurrency: String,
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Settings', settingsSchema);
