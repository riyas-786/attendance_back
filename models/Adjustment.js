const mongoose = require('mongoose');

// A one-off amount added to (earning) or taken from (deduction) one person's pay for one month.
// Examples: overtime, incentive, bonus, allowance  /  salary advance, loan repayment, fine.
const adjustmentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The day the amount is for (YYYY-MM-DD). It counts in whichever pay period contains that day.
    date: { type: String, default: '', index: true },
    // Older entries (before day-based entry) have no date and belong to a pay period key instead:
    // YYYY-MM or YYYY-MM-DD..YYYY-MM-DD (see utils/period.js)
    month: { type: String, default: '', index: true },
    type: { type: String, enum: ['earning', 'deduction'], required: true },
    label: { type: String, required: true, trim: true, maxlength: 60 }, // Overtime, Incentive, Advance ...
    amount: { type: Number, required: true, min: 0.01, max: 100000000 },
    note: { type: String, trim: true, maxlength: 300, default: '' }, // the narration: why this amount
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Adjustment', adjustmentSchema);
