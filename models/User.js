const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
    department: { type: String, trim: true, default: '' },
    employeeId: { type: String, trim: true, unique: true, sparse: true },
    active: { type: Boolean, default: true },
    // How this person is paid: a fixed monthly salary, a rate per day worked, or a rate per hour worked.
    // monthly staff only: '' = use the Settings default, 'fixed' = full salary minus absences, 'days' = salary / working days x days present
    monthlyMethod: { type: String, enum: ['', 'fixed', 'days'], default: '' },
    payType: { type: String, enum: ['monthly', 'daily', 'hourly'], default: 'monthly' },
    // The amount for payType: monthly salary / rate per day / rate per hour
    baseSalary: { type: Number, min: 0, default: 0 },
    // YYYY-MM-DD. Days before this are not counted as absences. Leave empty to count the whole month.
    joinDate: { type: String, default: '' },
    // Duty time. Empty = use the default work start / grace from Settings.
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    // Places this person may check in/out. Empty = use the default office from Settings (if one is set).
    locations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Location' }],
    // Field/remote staff: no location check at all.
    anyLocation: { type: Boolean, default: false },
    // The one phone/browser this person may use (registered on first sign-in). See utils/device.js.
    deviceId: { type: String, default: undefined, select: false },
    deviceLock: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

// unique among people who have one; sparse so unregistered accounts do not clash
userSchema.index({ deviceId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', userSchema);
