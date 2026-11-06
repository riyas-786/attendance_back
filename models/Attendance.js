const mongoose = require('mongoose');

const pointSchema = new mongoose.Schema(
  { lat: Number, lng: Number, accuracy: Number, distanceM: Number, siteName: String },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Calendar day as YYYY-MM-DD so there is exactly one record per user per day
    date: { type: String, required: true },
    checkIn: { type: Date },
    checkOut: { type: Date },
    status: { type: String, enum: ['present', 'late', 'absent', 'leave'], default: 'present' },
    workedMinutes: { type: Number, default: 0 },
    note: { type: String, trim: true, default: '' },
    inLocation: { type: pointSchema },
    outLocation: { type: pointSchema },
    inMethod: { type: String, enum: ['button', 'qr'], default: 'button' },
    // Only used when status is "leave". Unpaid leave is deducted from salary; the others are not.
    leaveType: { type: String, enum: ['annual', 'sick', 'unpaid', 'other'], default: 'annual' },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
