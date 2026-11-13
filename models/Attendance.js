const mongoose = require('mongoose');

const pointSchema = new mongoose.Schema(
  { lat: Number, lng: Number, accuracy: Number, distanceM: Number, siteName: String },
  { _id: false }
);

// One check-in / check-out pair. A day can have several (e.g. before and after a break).
const sessionSchema = new mongoose.Schema(
  {
    in: { type: Date, required: true },
    out: { type: Date },
    inLocation: { type: pointSchema },
    outLocation: { type: pointSchema },
    inMethod: { type: String, enum: ['button', 'qr', 'admin'], default: 'button' },
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Calendar day as YYYY-MM-DD so there is exactly one record per user per day
    date: { type: String, required: true },
    // All check-in/out pairs of the day, in order
    sessions: { type: [sessionSchema], default: [] },
    // Summary of the sessions (kept up to date by utils/sessions.js, so reports and payroll keep working):
    // checkIn = first check-in; checkOut = last check-out, empty while the person is currently checked in
    checkIn: { type: Date },
    checkOut: { type: Date },
    status: { type: String, enum: ['present', 'late', 'absent', 'leave'], default: 'present' },
    workedMinutes: { type: Number, default: 0 },
    note: { type: String, trim: true, default: '' },
    inLocation: { type: pointSchema },
    outLocation: { type: pointSchema },
    inMethod: { type: String, enum: ['button', 'qr', 'admin'], default: 'button' },
    // Only used when status is "leave". Unpaid leave is deducted from salary; the others are not.
    leaveType: { type: String, enum: ['annual', 'sick', 'unpaid', 'other'], default: 'annual' },
  },
  {
    timestamps: true,
    toJSON: {
      // Records saved before multiple sessions existed have no `sessions`: present them as one session
      transform(doc, ret) {
        if ((!ret.sessions || !ret.sessions.length) && ret.checkIn) {
          ret.sessions = [{ in: ret.checkIn, ...(ret.checkOut ? { out: ret.checkOut } : {}), inLocation: ret.inLocation, outLocation: ret.outLocation, inMethod: ret.inMethod }];
        }
        return ret;
      },
    },
  }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
